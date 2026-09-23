import XCTest
@testable import TrailMarker

/// The person's own "Never watch" apps (#2633): stored, cleared on log out, and kept apart from
/// the chosen apps.
@MainActor
final class FocusExclusionTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "FocusExclusionTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private struct NoNudges: NudgeDelivering {
        func requestAuthorization() {}
        func showNudge(blockTitle: String) {}
        func showTestNudge() {}
    }

    private struct NoPermissions: PermissionsOSAdaptor {
        func accessibilityTrusted(prompting: Bool) -> Bool { false }
        func screenRecordingGranted(prompting: Bool) -> Bool { false }
    }

    private final class FakeSource: FrontmostSource {
        var current: Observation?
        var canReadWindowTitles = true
    }

    private final class RecordingCapture: WindowCapturing {
        private(set) var captured: [String] = []
        func capture(_ window: WindowIdentity, pid: pid_t, maxDimension: CGFloat) async throws -> CGImage {
            captured.append(window.title)
            throw ScreenCaptureError.noMatchingWindow(debugDetail: "")
        }
    }

    private static let window = WindowIdentity(frame: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Docs")

    private func runtime(
        _ preferences: PreferencesStore, source: FakeSource = FakeSource(), capture: WindowCapturing = RecordingCapture(),
        fresh: ((pid_t) -> WindowIdentity?)? = nil
    ) -> FocusRuntime {
        FocusRuntime(
            connection: ConnectionRuntime(preferences: preferences),
            permissions: PermissionsService(adaptor: NoPermissions()),
            nudges: NoNudges(),
            preferences: preferences,
            keychain: KeychainStore(service: "com.moss.trailmarker.tests"),
            observer: FrontmostObserver(source: source),
            windowCapture: capture,
            freshWindowIdentity: fresh ?? { [weak source] _ in source?.current?.window }
        )
    }

    /// Settings' Test vision takes a picture outside any judgment; it must still never take one
    /// of an excluded app. The allowed case below proves the fake would have recorded it.
    func testTestVisionNeverCapturesAnExcludedApp() async {
        let source = FakeSource()
        source.current = Observation(
            appName: "Finance", bundleId: "com.example.Finance", windowTitle: "Accounts", pid: 7,
            window: WindowIdentity(frame: Self.window.frame, title: "Accounts")
        )
        let capture = RecordingCapture()
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = true
        let focus = runtime(preferences, source: source, capture: capture)
        focus.setExcluded("com.example.Finance", excluded: true)

        focus.testVision()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(capture.captured, [])
        guard case .failure(.captureFailed) = focus.visionTestResult else {
            return XCTFail("expected a refusal, got \(String(describing: focus.visionTestResult))")
        }
    }

    func testTestVisionStillCapturesAnAppThatIsNotExcluded() async {
        let source = FakeSource()
        source.current = Observation(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs", pid: 7, window: Self.window
        )
        let capture = RecordingCapture()
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = true
        let focus = runtime(preferences, source: source, capture: capture)

        focus.testVision()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(capture.captured, ["Docs"])
    }

    /// The remembered app's title is minutes old (a Chrome unread count moved on); the picture is
    /// bound to the window as it is now, not refused because the snapshot went stale (#2643).
    func testTestVisionCapturesTheFreshWindowNotTheStaleSnapshot() async {
        let source = FakeSource()
        source.current = Observation(
            appName: "Google Chrome", bundleId: "com.google.Chrome", windowTitle: "(20) Messages", pid: 7,
            window: WindowIdentity(frame: Self.window.frame, title: "(20) Messages")
        )
        let capture = RecordingCapture()
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = true
        let focus = runtime(preferences, source: source, capture: capture) { _ in
            WindowIdentity(frame: Self.window.frame, title: "(19) Messages")
        }

        focus.testVision()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(capture.captured, ["(19) Messages"])
    }

    /// The fresh read is what the private-window check sees: a window that became private since
    /// the snapshot is never captured.
    func testTestVisionChecksPrivacyOnTheFreshTitle() async {
        let source = FakeSource()
        source.current = Observation(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs", pid: 7, window: Self.window
        )
        let capture = RecordingCapture()
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = true
        let focus = runtime(preferences, source: source, capture: capture) { _ in
            WindowIdentity(frame: Self.window.frame, title: "Bank — Private Browsing")
        }

        focus.testVision()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(capture.captured, [])
    }

    /// Accessibility can't read the window now: no capture, whatever the snapshot said.
    func testTestVisionWithNoFreshWindowCapturesNothing() async {
        let source = FakeSource()
        source.current = Observation(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs", pid: 7, window: Self.window
        )
        let capture = RecordingCapture()
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = true
        let focus = runtime(preferences, source: source, capture: capture) { _ in nil }

        focus.testVision()
        try? await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(capture.captured, [])
    }

    func testExclusionsSurviveARelaunch() {
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusExcludedBundleIds = ["com.example.Finance"]
        XCTAssertEqual(PreferencesStore(defaults: defaults).focusExcludedBundleIds, ["com.example.Finance"])
        XCTAssertEqual(runtime(PreferencesStore(defaults: defaults)).excludedBundleIds, ["com.example.Finance"])
    }

    func testLogOutClearsExclusions() {
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusExcludedBundleIds = ["com.example.Finance"]
        preferences.clearAll()
        XCTAssertEqual(preferences.focusExcludedBundleIds, [])
    }

    func testExcludingAChosenAppTakesItOffTheChosenApps() {
        let preferences = PreferencesStore(defaults: defaults)
        let focus = runtime(preferences)
        focus.setAllowed("com.example.Finance", allowed: true)
        focus.setAllowed("com.apple.Safari", allowed: true)

        focus.setExcluded("com.example.Finance", excluded: true)

        XCTAssertEqual(focus.excludedBundleIds, ["com.example.Finance"])
        XCTAssertEqual(focus.allowedBundleIds, ["com.apple.Safari"])
        XCTAssertEqual(preferences.focusExcludedBundleIds, ["com.example.Finance"])
        XCTAssertEqual(preferences.focusAllowedBundleIds, ["com.apple.Safari"])
    }

    func testRemovingAnExclusionDoesNotChooseTheAppAgain() {
        let preferences = PreferencesStore(defaults: defaults)
        let focus = runtime(preferences)
        focus.setExcluded("com.example.Finance", excluded: true)
        focus.setExcluded("com.example.Finance", excluded: false)
        XCTAssertEqual(focus.excludedBundleIds, [])
        XCTAssertEqual(focus.allowedBundleIds, [])
        XCTAssertEqual(preferences.focusExcludedBundleIds, [])
    }
}
