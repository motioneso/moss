import AppKit
import ApplicationServices

/// Where the current observation comes from. A protocol so the focus logic is tested with a fake;
/// the real reader can only be exercised on a Mac with Accessibility granted (plan Part C).
protocol FrontmostSource {
    /// The frontmost app other than Trail Marker itself, or nil when there is none.
    var current: Observation? { get }
    /// False when Accessibility is not granted: the app name is still known, the title is empty.
    var canReadWindowTitles: Bool { get }
}

struct WorkspaceFrontmostSource: FrontmostSource {
    var canReadWindowTitles: Bool { AXIsProcessTrusted() }

    var current: Observation? {
        guard
            let app = NSWorkspace.shared.frontmostApplication,
            let bundleId = app.bundleIdentifier,
            bundleId != Bundle.main.bundleIdentifier
        else {
            return nil
        }
        return Observation(
            appName: app.localizedName ?? bundleId,
            bundleId: bundleId,
            windowTitle: focusedWindowTitle(processId: app.processIdentifier)
        )
    }

    private func focusedWindowTitle(processId: pid_t) -> String {
        guard AXIsProcessTrusted() else { return "" }
        let application = AXUIElementCreateApplication(processId)

        var window: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &window) == .success,
            let window
        else {
            return ""
        }

        var title: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success,
            let text = title as? String
        else {
            return ""
        }
        return text
    }
}

/// Tells the runtime when a different app comes to the front. Only listening while started, so
/// pausing (which stops it) leaves nothing running.
@MainActor
final class FrontmostObserver {
    private let source: FrontmostSource
    private var token: NSObjectProtocol?

    init(source: FrontmostSource = WorkspaceFrontmostSource()) {
        self.source = source
    }

    var canReadWindowTitles: Bool { source.canReadWindowTitles }
    var current: Observation? { source.current }

    func start(onChange: @escaping @MainActor (Observation?) -> Void) {
        stop()
        token = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [source] _ in
            let observation = source.current
            Task { @MainActor in onChange(observation) }
        }
    }

    func stop() {
        if let token {
            NSWorkspace.shared.notificationCenter.removeObserver(token)
        }
        token = nil
    }
}
