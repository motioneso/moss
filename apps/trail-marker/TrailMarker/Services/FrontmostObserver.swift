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
        let window = Self.focusedWindowIdentity(pid: app.processIdentifier)
        return Observation(
            appName: app.localizedName ?? bundleId,
            bundleId: bundleId,
            // Read on its own, not from `window`: a window whose frame can't be read still has a
            // title, and the private-window check needs it even when no capture is possible.
            windowTitle: window?.title ?? Self.focusedWindowTitle(pid: app.processIdentifier) ?? "",
            pid: app.processIdentifier,
            window: window
        )
    }

    /// The focused window's title, or nil when it couldn't be read.
    static func focusedWindowTitle(pid: pid_t) -> String? {
        guard AXIsProcessTrusted(), let window = focusedWindow(pid: pid) else { return nil }
        var titleRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef) == .success,
            let title = titleRef as? String
        else {
            return nil
        }
        return title
    }

    private static func focusedWindow(pid: pid_t) -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
            let windowRef, CFGetTypeID(windowRef) == AXUIElementGetTypeID()
        else {
            return nil
        }
        return (windowRef as! AXUIElement)
    }

    /// The app's focused window, or nil unless every read succeeded: Accessibility granted, a
    /// focused window, its position, size and title. A title that fails to read is nil, never an
    /// empty title, so the private-window check can't be skipped by accident (#2643). Also used
    /// right after a capture to confirm focus didn't move while the picture was taken.
    static func focusedWindowIdentity(pid: pid_t) -> WindowIdentity? {
        guard AXIsProcessTrusted(), let window = focusedWindow(pid: pid) else { return nil }

        var titleRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef) == .success,
            let title = titleRef as? String
        else {
            return nil
        }

        var positionRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        var position = CGPoint.zero
        var size = CGSize.zero
        guard
            AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRef) == .success,
            AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success,
            let positionRef, let sizeRef,
            CFGetTypeID(positionRef) == AXValueGetTypeID(), CFGetTypeID(sizeRef) == AXValueGetTypeID(),
            AXValueGetValue(positionRef as! AXValue, .cgPoint, &position),
            AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        else {
            return nil
        }
        return WindowIdentity(frame: CGRect(origin: position, size: size), title: title)
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
        guard let observation, !observation.isSameWindow(as: lastDelivered) else { return }
        deliver(observation)
    }

    private func deliver(_ observation: Observation?) {
        guard let onChange else { return }
        if let observation { lastDelivered = observation }
        onChange(observation)
    }
}
