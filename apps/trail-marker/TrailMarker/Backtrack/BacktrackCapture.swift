#if DEBUG
import AppKit
import ApplicationServices
import CoreGraphics
import Vision

// The pieces `BacktrackRuntime` uses to turn the window in front into text. Each is a protocol so
// the runtime is tested with fakes; the real ones need a Mac with Accessibility and Screen
// Recording granted.

// MARK: - Text recognition

protocol TextRecognizing {
    func recognize(_ image: CGImage) async throws -> [String]
}

/// Apple Vision on this Mac: no network, no model call (spec §2). Lines come back top to bottom,
/// then left to right.
struct VisionTextRecognizer: TextRecognizing {
    func recognize(_ image: CGImage) async throws -> [String] {
        try await withCheckedThrowingContinuation { continuation in
            let request = Self.makeRequest { result in continuation.resume(with: result) }
            DispatchQueue.global(qos: .utility).async {
                do {
                    try VNImageRequestHandler(cgImage: image).perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// `.accurate` without language correction: about 1.7x cheaper with no accuracy loss on screen
    /// text (plan §7, retry 2, task 1; omi's `ocr-quality.md` §3).
    static func makeRequest(completion: @escaping (Result<[String], Error>) -> Void) -> VNRecognizeTextRequest {
        let request = VNRecognizeTextRequest { request, error in
            if let error {
                completion(.failure(error))
                return
            }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            let sorted = observations.sorted {
                abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01
                    ? $0.boundingBox.midY > $1.boundingBox.midY
                    : $0.boundingBox.minX < $1.boundingBox.minX
            }
            completion(.success(sorted.compactMap { $0.topCandidates(1).first?.string }))
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        return request
    }
}

// MARK: - Accessibility helpers

/// Reads the focused window of a process and its identity, the same way
/// `WorkspaceFrontmostSource.focusedWindowIdentity` does, but keeping the element so what is read
/// from it (secure fields, the address) is bound to the window the capture was bound to.
enum BacktrackAX {
    static func focusedWindow(pid: pid_t) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let application = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
              let windowRef, CFGetTypeID(windowRef) == AXUIElementGetTypeID()
        else { return nil }
        return (windowRef as! AXUIElement)
    }

    /// The focused window of `pid`, only if it is still exactly `identity`.
    static func window(pid: pid_t, matching identity: WindowIdentity) -> AXUIElement? {
        guard let element = focusedWindow(pid: pid),
              let title = string(element, kAXTitleAttribute),
              let frame = frame(of: element),
              WindowIdentity(frame: frame, title: title).matches(identity)
        else { return nil }
        return element
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        if let text = value as? String { return text }
        if let url = value as? URL { return url.absoluteString }
        return nil
    }

    static func frame(of element: AXUIElement) -> CGRect? {
        var positionRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let positionRef, let sizeRef,
              CFGetTypeID(positionRef) == AXValueGetTypeID(), CFGetTypeID(sizeRef) == AXValueGetTypeID(),
              AXValueGetValue(positionRef as! AXValue, .cgPoint, &position),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        else { return nil }
        return CGRect(origin: position, size: size)
    }

    static func children(_ element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let array = value as? [AXUIElement]
        else { return [] }
        return array
    }
}

// MARK: - Secure fields

protocol SecureFieldLocating {
    /// Screen frames of every secure text field in the window, focused or not. Nil when the
    /// window is no longer `window`, or the search couldn't be completed within `budget`: then
    /// nothing is captured (plan §4.3).
    func secureFieldFrames(pid: pid_t, window: WindowIdentity, budget: TimeInterval) -> [CGRect]?
}

struct AXSecureFieldLocator: SecureFieldLocating {
    static let maxElements = 5000

    func secureFieldFrames(pid: pid_t, window identity: WindowIdentity, budget: TimeInterval) -> [CGRect]? {
        guard let window = BacktrackAX.window(pid: pid, matching: identity) else { return nil }
        let deadline = Date().addingTimeInterval(budget)
        var frames: [CGRect] = []
        var queue = [window]
        var visited = 0
        while !queue.isEmpty {
            guard Date() < deadline, visited < Self.maxElements else { return nil }
            let element = queue.removeFirst()
            visited += 1
            let role = BacktrackAX.string(element, kAXRoleAttribute)
            if BacktrackAX.string(element, kAXSubroleAttribute) == "AXSecureTextField" {
                guard let frame = BacktrackAX.frame(of: element) else { return nil }
                frames.append(frame)
                continue
            }
            // A web page: ask the page for its text fields instead of walking every node, which is
            // what makes this fit the budget in a browser. If the page can't answer, walk it.
            if role == "AXWebArea", let fields = Self.searchTextFields(in: element) {
                for field in fields where BacktrackAX.string(field, kAXSubroleAttribute) == "AXSecureTextField" {
                    guard let frame = BacktrackAX.frame(of: field) else { return nil }
                    frames.append(frame)
                }
                continue
            }
            queue.append(contentsOf: BacktrackAX.children(element))
        }
        return frames
    }

    /// WebKit and Chromium answer `AXUIElementsForSearchPredicate`; nil when unsupported.
    private static func searchTextFields(in element: AXUIElement) -> [AXUIElement]? {
        let predicate: [String: Any] = [
            "AXSearchKey": "AXTextFieldSearchKey",
            "AXResultsLimit": 500,
            "AXDirection": "AXDirectionNext",
            "AXVisibleOnly": false
        ]
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            element, "AXUIElementsForSearchPredicate" as CFString, predicate as CFDictionary, &value
        ) == .success, let array = value as? [AXUIElement]
        else { return nil }
        return array
    }
}

// MARK: - Address

protocol BrowserAddressReading {
    /// The page address of the focused window, read from that same window (plan §4.3), or nil.
    /// Never guessed: a browser that exposes nothing gets no address.
    func address(pid: pid_t, window: WindowIdentity, bundleId: String) -> String?
}

struct AXBrowserAddressReader: BrowserAddressReading {
    static let maxElements = 400

    func address(pid: pid_t, window identity: WindowIdentity, bundleId: String) -> String? {
        guard let window = BacktrackAX.window(pid: pid, matching: identity) else { return nil }
        if let document = BacktrackAX.string(window, kAXDocumentAttribute), Self.isWeb(document) {
            return document
        }
        var queue = [window]
        var visited = 0
        while !queue.isEmpty, visited < Self.maxElements {
            let element = queue.removeFirst()
            visited += 1
            if BacktrackAX.string(element, kAXRoleAttribute) == "AXWebArea" {
                if let url = BacktrackAX.string(element, "AXURL"), Self.isWeb(url) { return url }
                continue
            }
            queue.append(contentsOf: BacktrackAX.children(element))
        }
        return nil
    }

    private static func isWeb(_ text: String) -> Bool {
        text.lowercased().hasPrefix("http://") || text.lowercased().hasPrefix("https://")
    }
}

// MARK: - Change check

/// "Has the window changed?" from a tiny greyscale thumbnail, so an unchanged screen costs only
/// this check (spec §5).
protocol ThumbnailComparing: AnyObject {
    func changed(_ key: DedupeKey, thumbnail: CGImage, at: Date) -> Bool
    func recognized(_ key: DedupeKey, thumbnail: CGImage, at: Date)
    func reset()
}

final class ThumbnailChangeDetector: ThumbnailComparing {
    static let side = 32
    static let maxWindows = 32
    static let maxScreens = 8
    static let refreshInterval: TimeInterval = 60
    private struct Fingerprint {
        let hash: UInt64
        let brightness: Double

        func resembles(_ other: Fingerprint) -> Bool {
            (hash ^ other.hash).nonzeroBitCount <= 5 && abs(brightness - other.brightness) <= 10
        }
    }
    private struct ReadScreen {
        let fingerprint: Fingerprint
        let at: Date
    }
    private var histories: [DedupeKey: [ReadScreen]] = [:]
    private var order: [DedupeKey] = []

    func changed(_ key: DedupeKey, thumbnail: CGImage, at: Date) -> Bool {
        guard let fingerprint = Self.fingerprint(thumbnail), let screens = histories[key]
        else { return true }
        return !screens.contains {
            at >= $0.at && at.timeIntervalSince($0.at) < Self.refreshInterval && $0.fingerprint.resembles(fingerprint)
        }
    }

    /// Checks and failed/cancelled captures never mark a screen as read.
    func recognized(_ key: DedupeKey, thumbnail: CGImage, at: Date) {
        guard let fingerprint = Self.fingerprint(thumbnail) else { return }
        var screens = histories[key] ?? []
        screens.removeAll { $0.fingerprint.resembles(fingerprint) }
        screens.append(ReadScreen(fingerprint: fingerprint, at: at))
        histories[key] = Array(screens.suffix(Self.maxScreens))
        order.removeAll { $0 == key }
        order.append(key)
        if order.count > Self.maxWindows { histories[order.removeFirst()] = nil }
    }

    func reset() {
        histories = [:]
        order = []
    }

    /// A 64-bit horizontal difference hash and average luminance; no image is retained.
    private static func fingerprint(_ image: CGImage) -> Fingerprint? {
        let width = 9, height = 8
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var hash: UInt64 = 0
        for y in 0..<height {
            for x in 0..<8 where pixels[y * width + x] > pixels[y * width + x + 1] {
                hash |= UInt64(1) << (y * 8 + x)
            }
        }
        return Fingerprint(hash: hash, brightness: Double(pixels.reduce(0) { $0 + Int($1) }) / Double(pixels.count))
    }

    static func greyscale(_ image: CGImage) -> [UInt8]? {
        var pixels = [UInt8](repeating: 0, count: side * side)
        guard let context = CGContext(
            data: &pixels, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return pixels
    }
}

// MARK: - Masking

enum SecureFieldMask {
    /// Paints each secure field (screen points) solid black on the window's image, scaled to the
    /// image, with a small margin. Nil if the image can't be redrawn: then nothing is recognised.
    static func apply(_ frames: [CGRect], to image: CGImage, windowFrame: CGRect) -> CGImage? {
        guard !frames.isEmpty else { return image }
        guard windowFrame.width > 0, windowFrame.height > 0,
              let context = CGContext(
                  data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        let scaleX = width / windowFrame.width
        let scaleY = height / windowFrame.height
        for frame in frames {
            // Screen and window frames are top-left origin; a CGContext is bottom-left.
            let rect = CGRect(
                x: (frame.minX - windowFrame.minX) * scaleX,
                y: height - (frame.maxY - windowFrame.minY) * scaleY,
                width: frame.width * scaleX,
                height: frame.height * scaleY
            )
            context.fill(rect.insetBy(dx: -2, dy: -2))
        }
        return context.makeImage()
    }
}
#endif
