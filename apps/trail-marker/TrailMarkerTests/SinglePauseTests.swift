import XCTest
@testable import TrailMarker

/// There is one pause, the connection's (Ben, 2026-09-23). Builds before that had a separate
/// Focus pause stored under `focusPaused`; a Mac upgraded while that was on must not stay
/// silently unwatched with no button left to undo it.
@MainActor
final class SinglePauseTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "SinglePauseTests.\(UUID().uuidString)"
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

    func testALeftoverFocusPauseIsRemovedOnLaunch() {
        defaults.set(true, forKey: "focusPaused")
        _ = PreferencesStore(defaults: defaults)
        XCTAssertNil(defaults.object(forKey: "focusPaused"))
    }

    func testALeftoverFocusPauseNoLongerStopsWatching() {
        defaults.set(true, forKey: "focusPaused")
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = true
        let focus = FocusRuntime(
            connection: ConnectionRuntime(preferences: preferences),
            permissions: PermissionsService(adaptor: NoPermissions()),
            nudges: NoNudges(),
            preferences: preferences,
            keychain: KeychainStore(service: "com.moss.trailmarker.tests"),
            observer: FrontmostObserver(source: FakeSource())
        )
        focus.start()

        // Consent on and not paused: the only thing holding it back is that Moss isn't
        // connected in this test, which is what "unreachable" says.
        XCTAssertTrue(focus.consent)
        XCTAssertEqual(focus.state, .unreachable)
    }
}
