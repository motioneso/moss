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
if args.contains("--titles") {
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
        }
    }
}
emit(result)
