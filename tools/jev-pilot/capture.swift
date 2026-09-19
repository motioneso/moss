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

func windowText(_ window: AXUIElement) -> String {
    AXUIElementSetMessagingTimeout(window, 0.05)
    guard let bounds = frame(window) else { return "" }
    let deadline = Date().addingTimeInterval(1.5)
    var pending: [(AXUIElement, Int)] = [(window, 0)]
    var parts: [String] = []
    var seen = Set<String>()
    var visited = 0
    var characters = 0
    // Bounded foreground-window walk; never read values from editable/secure controls.
    while let (element, depth) = pending.popLast(), visited < 250,
          characters < 1200, Date() < deadline {
        visited += 1
        AXUIElementSetMessagingTimeout(element, 0.05)
        let role = attribute(element, kAXRoleAttribute) as? String ?? ""
        if ["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox"].contains(role) { continue }
        if let rect = frame(element), !bounds.intersects(rect) { continue }
        if role == "AXStaticText", let rect = frame(element), bounds.intersects(rect),
           let value = attribute(element, kAXValueAttribute) as? String {
            let text = String(value.prefix(1200 - characters)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty, seen.insert(text).inserted {
                parts.append(text)
                characters += text.count + 1
            }
        }
        if depth < 20 {
            var children = (attribute(element, "AXVisibleChildren") as? [AXUIElement]) ?? []
            if children.isEmpty { children = (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
            for child in children.prefix(250 - visited).reversed() { pending.append((child, depth + 1)) }
        }
    }
    return String(parts.joined(separator: " ").prefix(1200))
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

guard let app = workspace.frontmostApplication, let bundleID = app.bundleIdentifier else {
    emit(["status": "unavailable"])
    exit(0)
}
let idle = CGEventSource.secondsSinceLastEventType(
    .combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!
)
let session = CGSessionCopyCurrentDictionary() as? [String: Any]
// Lock detection is best effort; explicit stop and idle cutoff remain necessary.
let locked = session?["CGSSessionScreenIsLocked"] as? Bool ?? false
let onConsole = session?[kCGSessionOnConsoleKey as String] as? Bool ?? true
if locked || !onConsole || idle >= 120 {
    emit(["status": "idle"])
    exit(0)
}
guard args.contains(bundleID) else {
    emit(["status": "excluded"])
    exit(0)
}

var result: [String: Any] = [
    "status": "ok", "app": app.localizedName ?? "Unknown", "bundle_id": bundleID,
    "title": "", "accessibility": AXIsProcessTrusted()
]
if args.contains("--titles") || args.contains("--text") {
    if !AXIsProcessTrusted() {
        result["status"] = "permission_denied"
    } else {
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 1.0)
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success,
           let focused = focused, CFGetTypeID(focused) == AXUIElementGetTypeID() {
            let window = unsafeBitCast(focused, to: AXUIElement.self)
            var title: CFTypeRef?
            if AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success {
                result["title"] = String((title as? String ?? "").prefix(512))
            }
            if args.contains("--text") { result["text"] = windowText(window) }
        }
    }
}
emit(result)
