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

/// Tells the runtime when a different app comes to the front, or when the window title in front
/// changes without an app switch (a new browser tab, another document). Only listening while
/// started, so pausing (which stops it) leaves nothing running.
@MainActor
final class FrontmostObserver {
    /// How often the title in front is re-read. Local only: the focus machine's own spacing still
    /// decides whether anything is sent.
    static let titlePollInterval: TimeInterval = 2

    private let source: FrontmostSource
    private var token: NSObjectProtocol?
    private var pollTimer: Timer?
    private var onChange: (@MainActor (Observation?) -> Void)?
    private var lastDelivered: Observation?

    init(source: FrontmostSource = WorkspaceFrontmostSource()) {
        self.source = source
    }

    var canReadWindowTitles: Bool { source.canReadWindowTitles }
    var current: Observation? { source.current }

    func start(onChange: @escaping @MainActor (Observation?) -> Void) {
        stop()
        self.onChange = onChange
        lastDelivered = source.current
        token = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self, source] _ in
            let observation = source.current
            Task { @MainActor in self?.deliver(observation) }
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.titlePollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }

    func stop() {
        if let token {
            NSWorkspace.shared.notificationCenter.removeObserver(token)
        }
        token = nil
        pollTimer?.invalidate()
        pollTimer = nil
        onChange = nil
    }

    /// Re-reads what is in front and reports it only when it differs from the last report, so a
    /// tab switch inside one app counts as a change and an unchanged window says nothing.
    func poll() {
        let observation = source.current
        guard let observation, observation != lastDelivered else { return }
        deliver(observation)
    }

    private func deliver(_ observation: Observation?) {
        guard let onChange else { return }
        if let observation { lastDelivered = observation }
        onChange(observation)
    }
}
