import XCTest
@testable import TrailMarker

/// Pause All and the menu's Focus switch (Backtrack plan §3.4). The switch pauses Focus alone;
/// Pause All still stops everything, and leaves the switch where it was.
@MainActor
final class FocusSwitchTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ seconds: TimeInterval) -> Date { base.addingTimeInterval(seconds) }

    private var defaults: UserDefaults!
    private let suite = "com.moss.trailmarker.tests.focusswitch"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    // MARK: - Machine

    private func activeMachine() -> FocusMachine {
        var machine = FocusMachine(policy: ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true))
        _ = machine.handle(.launched(consent: true), now: at(0))
        _ = machine.handle(.connectionChanged(isConnected: true), now: at(0))
        return machine
    }

    func testSwitchingFocusOffCancelsEverythingAndPersists() {
        var machine = activeMachine()
        let effects = machine.handle(.userSwitchedFocus(on: false), now: at(1))
        XCTAssertEqual(effects, [.persistFocusSwitchedOff(true), .cancelAll])
        XCTAssertEqual(machine.state, .switchedOff)
    }

    /// Every timer and reply started before the switch went off is dropped, and nothing new starts.
    func testNothingIsScheduledOrSentWhileSwitchedOff() {
        var machine = activeMachine()
        let old = machine.generation
        _ = machine.handle(.userSwitchedFocus(on: false), now: at(1))
        let events: [FocusEvent] = [
            .contextTimerFired(generation: old), .contextTimerFired(generation: machine.generation),
            .sampleTimerFired(generation: machine.generation), .dwellTimerFired(generation: machine.generation, change: 0),
            .wake, .appChanged(Observation(appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs")),
            .judged(FocusJudgment(judgmentId: "j", label: .distracted, reason: "", nudge: true), generation: old)
        ]
        for event in events {
            XCTAssertEqual(machine.handle(event, now: at(2)), [], "\(event) acted while switched off")
        }
    }

    func testSwitchingFocusBackOnFetchesAfresh() {
        var machine = activeMachine()
        _ = machine.handle(.userSwitchedFocus(on: false), now: at(1))
        let effects = machine.handle(.userSwitchedFocus(on: true), now: at(2))
        XCTAssertEqual(effects, [.persistFocusSwitchedOff(false), .fetchContext(generation: machine.generation)])
    }

    func testLaunchingSwitchedOffStaysQuietWhenMossConnects() {
        var machine = FocusMachine()
        _ = machine.handle(.launched(consent: true, switchedOff: true), now: at(0))
        XCTAssertEqual(machine.handle(.connectionChanged(isConnected: true), now: at(0)), [])
        XCTAssertEqual(machine.state, .switchedOff)
    }

    // MARK: - Menu

    private func identity() -> LinkedIdentity { PrivacyFixesTests.identity() }

    func testPrimaryTitlesArePauseAllAndResumeAll() {
        XCTAssertEqual(MenuModel.primaryActionTitle(for: .connected(lastContact: Date())), "Pause All")
        XCTAssertEqual(MenuModel.primaryActionTitle(for: .disconnected), "Resume All")
    }

    private func focusRow(state: ConnectionState, focus: FocusWatchState) -> MenuItemDescriptor? {
        let info = FocusMenuInfo(state: focus, goalLine: nil, hasLastJudgment: false)
        return MenuModel.items(state: state, identity: identity(), focus: info).first { $0.role == .focusSwitch }
    }

    func testTheFocusRowAppearsOnlyWhenFocusIsOn() {
        XCTAssertNil(focusRow(state: .connected(lastContact: Date()), focus: .off))
        let row = focusRow(state: .connected(lastContact: Date()), focus: .noBlock)
        XCTAssertEqual(row?.kind, .toggle)
        XCTAssertEqual(row?.isOn, true)
        XCTAssertEqual(row?.isEnabled, true)
    }

    func testSwitchedOffShowsOffAndSaysFocusPaused() {
        XCTAssertEqual(focusRow(state: .connected(lastContact: Date()), focus: .switchedOff)?.isOn, false)
        let info = FocusMenuInfo(state: .switchedOff, goalLine: nil, hasLastJudgment: false)
        XCTAssertEqual(info.statusLine, "Focus paused")
    }

    /// Pause All greys the switch but keeps its position, so Resume All brings back what ran.
    func testDuringPauseAllTheSwitchKeepsItsPositionAndIsDisabled() {
        let on = focusRow(state: .disconnected, focus: .unreachable)
        XCTAssertEqual(on?.isOn, true)
        XCTAssertEqual(on?.isEnabled, false)
        let off = focusRow(state: .disconnected, focus: .switchedOff)
        XCTAssertEqual(off?.isOn, false)
        XCTAssertEqual(off?.isEnabled, false)
    }

    /// The card's everyday rows are unchanged: the switch is drawn on its own, not as a row.
    func testTheSwitchIsNotOneOfTheCardsRows() {
        let info = FocusMenuInfo(state: .noBlock, goalLine: nil, hasLastJudgment: false)
        let card = MenuModel.card(state: .connected(lastContact: Date()), identity: identity(), focus: info)
        XCTAssertFalse(card.rows.contains("Focus"))
    }

    // MARK: - Preferences, through launch

    /// The retired `focusPaused` must never pause anyone: the switch uses a new key, and
    /// `PreferencesStore` deletes the old one on launch.
    func testARetiredFocusPausedDoesNotSwitchFocusOffOnLaunch() {
        defaults.set(true, forKey: "focusPaused")
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = true
        let focus = FocusRuntime(
            connection: ConnectionRuntime(preferences: preferences),
            permissions: PermissionsService(adaptor: PrivacyFixesTests.AllPermissions()),
            nudges: PrivacyFixesTests.NoNudges(),
            preferences: preferences,
            keychain: KeychainStore(service: "com.moss.trailmarker.tests"),
            observer: FrontmostObserver(source: PrivacyFixesTests.FakeSource())
        )
        focus.start()
        XCTAssertFalse(focus.focusSwitchedOff)
        XCTAssertNotEqual(focus.state, .switchedOff)
    }

    func testTheSwitchSurvivesARelaunchAndLogOutClearsIt() {
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusSwitchedOff = true
        XCTAssertTrue(PreferencesStore(defaults: defaults).focusSwitchedOff)
        preferences.clearAll()
        XCTAssertFalse(PreferencesStore(defaults: defaults).focusSwitchedOff)
    }

    func testMossRevokingThisMacAlsoClearsTheSwitch() {
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusSwitchedOff = true
        preferences.clearAccountData()
        XCTAssertFalse(preferences.focusSwitchedOff)
    }
}
