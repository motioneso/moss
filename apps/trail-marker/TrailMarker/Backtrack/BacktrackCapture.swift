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
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let sorted = observations.sorted {
                    abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01
                        ? $0.boundingBox.midY > $1.boundingBox.midY
                        : $0.boundingBox.minX < $1.boundingBox.minX
                }
                continuation.resume(returning: sorted.compactMap { $0.topCandidates(1).first?.string })
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            DispatchQueue.global(qos: .utility).async {
                do {
                    try VNImageRequestHandler(cgImage: image).perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
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
    func changed(_ key: DedupeKey, thumbnail: CGImage) -> Bool
    func reset()
}

final class ThumbnailChangeDetector: ThumbnailComparing {
    static let side = 32
    /// Mean absolute difference, 0–255, above which the window counts as changed.
    static let threshold = 2.0
    private var last: [DedupeKey: [UInt8]] = [:]

    func changed(_ key: DedupeKey, thumbnail: CGImage) -> Bool {
        guard let pixels = Self.greyscale(thumbnail) else { return true }
        defer { last[key] = pixels }
        guard let previous = last[key], previous.count == pixels.count else { return true }
        let total = zip(previous, pixels).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }
        return Double(total) / Double(pixels.count) > Self.threshold
    }

    func reset() { last = [:] }

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
