import AppKit
import ApplicationServices
import Foundation

// One foreground snapshot. Python owns timing; this process never uses the network.
let args = Array(CommandLine.arguments.dropFirst())
let workspace = NSWorkspace.shared

func emit(_ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { exit(1) }
    print(text)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}

func cgRect(_ value: Any) -> CGRect? {
    guard let bounds = value as? [String: Any] else { return nil }
    return CGRect(dictionaryRepresentation: bounds as CFDictionary)
}

// Match the focused AX window to exactly one visible, normal-level CG window.
// A tolerance absorbs the small rounding differences between the two APIs;
// ambiguity fails closed so the caller cannot capture an arbitrary app window.
func focusedWindowID(pid: pid_t, bounds: CGRect) -> CGWindowID? {
    guard let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else { return nil }

    let tolerance = 1.0
    let matches = windows.compactMap { info -> CGWindowID? in
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
              let rectValue = info[kCGWindowBounds as String],
              let rect = cgRect(rectValue), rect.width > 0, rect.height > 0,
              abs(rect.minX - bounds.minX) <= tolerance,
              abs(rect.minY - bounds.minY) <= tolerance,
              abs(rect.width - bounds.width) <= tolerance,
              abs(rect.height - bounds.height) <= tolerance,
              let number = info[kCGWindowNumber as String] as? NSNumber else { return nil }
        return CGWindowID(number.uint32Value)
    }
    return matches.count == 1 ? matches[0] : nil
}

func windowText(_ window: AXUIElement) -> [String: Any] {
    AXUIElementSetMessagingTimeout(window, 0.05)
    guard let bounds = frame(window) else { return ["text": "", "text_source": "none"] }
    let deadline = Date().addingTimeInterval(1.5)
    var pending: [(AXUIElement, Int, Bool)] = [(window, 0, false)]
    var parts: [String] = []
    var pageParts: [String] = []
    var seen = Set<String>()
    var visited = 0
    var characters = 0
    var pageCharacters = 0
    // Bounded foreground-window walk; never read values from editable/secure controls.
    while !pending.isEmpty, visited < 250, pageCharacters < 1200, Date() < deadline {
        let (element, depth, parentIsPage) = pending.removeLast()
        visited += 1
        AXUIElementSetMessagingTimeout(element, 0.05)
        let role = attribute(element, kAXRoleAttribute) as? String ?? ""
        let isPage = parentIsPage || role == "AXWebArea"
        if ["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox"].contains(role) { continue }
        let rect = frame(element)
        if let rect = rect, !bounds.intersects(rect) { continue }
        if role == "AXStaticText", let rect = rect, bounds.intersects(rect),
           let value = attribute(element, kAXValueAttribute) as? String {
            let remaining = max(0, 1200 - (isPage ? pageCharacters : characters))
            let text = String(value.prefix(remaining)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty, seen.insert((isPage ? "page:" : "window:") + text).inserted {
                if isPage {
                    pageParts.append(text)
                    pageCharacters += text.count + 1
                } else {
                    parts.append(text)
                    characters += text.count + 1
                }
            }
        }
        if depth < 20 {
            var children = (attribute(element, "AXVisibleChildren") as? [AXUIElement]) ?? []
            if children.isEmpty { children = (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
            for child in children.prefix(250 - visited).reversed() { pending.append((child, depth + 1, isPage)) }
        }
    }
    let text = String((pageParts.isEmpty ? parts : pageParts).joined(separator: " ").prefix(1200))
    return ["text": text, "text_source": text.isEmpty ? "none" : (pageParts.isEmpty ? "window" : "page"),
            "text_scan_limited": !pending.isEmpty]
}

if args.contains("--list-apps") {
    emit(workspace.runningApplications.filter { $0.activationPolicy == .regular }.map {
        ["app": $0.localizedName ?? "Unknown", "bundle_id": $0.bundleIdentifier ?? ""]
    })
    exit(0)
}

if args.contains("--request-access") {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    emit(["accessibility": AXIsProcessTrustedWithOptions(options as CFDictionary)])
    exit(0)
}

if args.contains("--request-screen-access") {
    let screenRecording = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    emit(["screen_recording": screenRecording])
    exit(0)
}

guard let app = workspace.frontmostApplication, let bundleID = app.bundleIdentifier else {
    emit(["status": "unavailable"])
    exit(0)
}
let idle = CGEventSource.secondsSinceLastEventType(
    .combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!
)
let session = CGSessionCopyCurrentDictionary() as? [String: Any]
var idleLimit = 600.0
if let index = args.firstIndex(of: "--idle-seconds") {
    guard args.indices.contains(index + 1), let value = Double(args[index + 1]),
          value.isFinite, (30.0...3600.0).contains(value) else {
        emit(["status": "invalid_idle_timeout"])
        exit(2)
    }
    idleLimit = value
}
// Lock detection is best effort; explicit stop and idle cutoff remain necessary.
let locked = session?["CGSSessionScreenIsLocked"] as? Bool ?? false
let onConsole = session?[kCGSessionOnConsoleKey as String] as? Bool ?? true
if locked || !onConsole || idle >= idleLimit {
    emit(["status": "idle"])
    exit(0)
}
guard args.contains(bundleID) else {
    emit(["status": "excluded"])
    exit(0)
}

let needsWindowID = args.contains("--window-id")
let screenRecording = !needsWindowID || CGPreflightScreenCaptureAccess()
var result: [String: Any] = [
    "status": "ok", "app": app.localizedName ?? "Unknown", "bundle_id": bundleID,
    "title": "", "accessibility": AXIsProcessTrusted()
]
if needsWindowID { result["screen_recording"] = screenRecording }
if !screenRecording {
    result["status"] = "permission_denied"
} else if args.contains("--titles") || args.contains("--text") || needsWindowID {
    if !AXIsProcessTrusted() {
        result["status"] = "permission_denied"
    } else {
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 1.0)
        var focused: CFTypeRef?
        var focusedWindow: AXUIElement?
        if AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success,
           let focused = focused, CFGetTypeID(focused) == AXUIElementGetTypeID() {
            let window = unsafeBitCast(focused, to: AXUIElement.self)
            focusedWindow = window
            var title: CFTypeRef?
            if AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success {
                result["title"] = String((title as? String ?? "").prefix(512))
            }
            if args.contains("--text") {
                result.merge(windowText(window)) { _, new in new }
            }
        }
        if needsWindowID {
            if let window = focusedWindow, let bounds = frame(window),
               let windowID = focusedWindowID(pid: app.processIdentifier, bounds: bounds) {
                result["window_id"] = Int(windowID)
            } else {
                result["status"] = "unavailable"
            }
        }
    }
}
emit(result)
