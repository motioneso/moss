import XCTest
@testable import TrailMarker

final class FocusMachineTests: XCTestCase {
    private let start = ServerTime.parse("2026-12-01T09:30:00.000Z")!
    private let blockId = "3b1f0c1e-6c1a-4f5e-9d3a-0a1b2c3d4e5f"
    private let safari = Observation(appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs")
    private let mail = Observation(appName: "Mail", bundleId: "com.apple.mail", windowTitle: "Inbox")

    private func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }

    private func context(block: Bool = true, ready: Bool = true) -> FocusContext {
        FocusContext(
            block: block
                ? FocusBlock(
                    id: blockId, title: "Study AI", startsAt: "2026-12-01T09:00:00.000Z",
                    endsAt: "2026-12-01T11:00:00.000Z"
                ) : nil,
            judgmentReady: ready
        )
    }

    private func judgment(_ label: FocusLabel, nudge: Bool = false) -> FocusJudgment {
        FocusJudgment(judgmentId: "6f1f0c1e-6c1a-4f5e-9d3a-0a1b2c3d4e5f", label: label, reason: "r", nudge: nudge)
    }

    /// Consent on, connected, Accessibility granted, Safari allowed and in front, and a
    /// block covering now with a model bound. The first sample has been sent at `at(0)`.
    private func armed() -> FocusMachine {
        var machine = FocusMachine(policy: ObservationPolicy(allowedBundleIds: ["com.apple.Safari"]))
        _ = machine.handle(.launched(consent: true), now: at(0))
        _ = machine.handle(.accessibilityChanged(granted: true), now: at(0))
        _ = machine.handle(.appChanged(safari), now: at(0))
        _ = machine.handle(.connectionChanged(isConnected: true), now: at(0))
        _ = machine.handle(.contextLoaded(context(), generation: machine.generation), now: at(0))
        return machine
    }

    private func sends(_ effects: [FocusEffect]) -> Bool {
        effects.contains { if case .sendObservation = $0 { return true } else { return false } }
    }

    // MARK: launch and connection

    func testItStartsOffWithoutConsent() {
        var machine = FocusMachine()
        XCTAssertEqual(machine.handle(.launched(consent: false), now: at(0)), [])
        XCTAssertEqual(machine.state, .off)
        XCTAssertEqual(machine.handle(.connectionChanged(isConnected: true), now: at(0)), [])
    }

    func testBecomingConnectedWithConsentFetchesTheContext() {
        var machine = FocusMachine()
        _ = machine.handle(.launched(consent: true), now: at(0))
        let effects = machine.handle(.connectionChanged(isConnected: true), now: at(0))
        XCTAssertEqual(effects, [.fetchContext(generation: machine.generation)])
    }

    func testLeavingConnectedCancelsEverythingAndNothingSendsUntilItReturns() {
        var machine = armed()
        let cancel = machine.handle(.connectionChanged(isConnected: false), now: at(1))
        XCTAssertEqual(cancel, [.cancelAll])

        XCTAssertEqual(machine.handle(.appChanged(safari), now: at(100)), [])
        XCTAssertEqual(machine.handle(.sampleTimerFired(generation: machine.generation), now: at(400)), [])
        XCTAssertEqual(machine.handle(.wake, now: at(500)), [])

        let back = machine.handle(.connectionChanged(isConnected: true), now: at(600))
        XCTAssertEqual(back, [.fetchContext(generation: machine.generation)])
    }

    // MARK: pause (the connection's Pause is the only pause; it reaches Focus as a disconnect)

    func testAfterPauseNothingCanSendOnAnyPath() {
        var machine = armed()
        let staleGeneration = machine.generation
        XCTAssertEqual(machine.handle(.connectionChanged(isConnected: false), now: at(5)), [.cancelAll])

        // If any of these produced an effect, pausing would not stop requests.
        XCTAssertEqual(machine.handle(.appChanged(safari), now: at(200)), [])
        XCTAssertEqual(machine.handle(.appChanged(mail), now: at(300)), [])
        XCTAssertEqual(machine.handle(.sampleTimerFired(generation: staleGeneration), now: at(400)), [])
        XCTAssertEqual(machine.handle(.sampleTimerFired(generation: machine.generation), now: at(400)), [])
        XCTAssertEqual(machine.handle(.contextTimerFired(generation: machine.generation), now: at(400)), [])
        XCTAssertEqual(machine.handle(.wake, now: at(500)), [])
        XCTAssertEqual(machine.handle(.contextLoaded(context(), generation: staleGeneration), now: at(540)), [])
        XCTAssertEqual(machine.handle(.contextLoaded(context(), generation: machine.generation), now: at(540)), [])
        XCTAssertEqual(machine.handle(.judged(judgment(.distracted, nudge: true), generation: staleGeneration), now: at(550)), [])
    }

    func testAPausedLaunchSendsNothingUntilResumed() {
        var machine = FocusMachine(policy: ObservationPolicy(allowedBundleIds: ["com.apple.Safari"]))
        XCTAssertEqual(machine.handle(.launched(consent: true), now: at(0)), [])
        XCTAssertEqual(machine.handle(.accessibilityChanged(granted: true), now: at(0)), [])
        XCTAssertFalse(sends(machine.handle(.appChanged(safari), now: at(1))))
        XCTAssertEqual(machine.state, .unreachable)
    }

    func testResumeFetchesTheContext() {
        var machine = armed()
        _ = machine.handle(.connectionChanged(isConnected: false), now: at(5))
        let effects = machine.handle(.connectionChanged(isConnected: true), now: at(10))
        XCTAssertEqual(effects, [.fetchContext(generation: machine.generation)])
    }

    // MARK: what is required before anything is sent

    func testNoBlockMeansNothingIsSent() {
        var machine = armed()
        let effects = machine.handle(.contextLoaded(context(block: false), generation: machine.generation), now: at(60))
        XCTAssertFalse(sends(effects))
        XCTAssertEqual(machine.state, .noBlock)
        XCTAssertFalse(sends(machine.handle(.appChanged(mail), now: at(200))))
    }

    func testWithoutConsentNothingIsSent() {
        var machine = armed()
        _ = machine.handle(.userToggleConsent(false), now: at(10))
        XCTAssertEqual(machine.state, .off)
        XCTAssertEqual(machine.handle(.appChanged(safari), now: at(200)), [])
    }

    func testAnAppThePersonDidNotAllowIsNeverSent() {
        var machine = armed()
        XCTAssertFalse(sends(machine.handle(.appChanged(mail), now: at(200))))
    }

    func testAnAppOnTheDenylistIsNeverSentEvenIfAllowed() {
        let denied = Observation(appName: "1Password", bundleId: "com.1password.1password", windowTitle: "Vault")
        var machine = FocusMachine(policy: ObservationPolicy(allowedBundleIds: [denied.bundleId]))
        _ = machine.handle(.launched(consent: true), now: at(0))
        _ = machine.handle(.accessibilityChanged(granted: true), now: at(0))
        _ = machine.handle(.connectionChanged(isConnected: true), now: at(0))
        _ = machine.handle(.contextLoaded(context(), generation: machine.generation), now: at(0))
        XCTAssertFalse(sends(machine.handle(.appChanged(denied), now: at(200))))
    }

    /// #2633: an app the person excluded sends nothing even with the entire desktop watched —
    /// not on the switch, not when the block is found, and not on the regular sample timer.
    func testAnExcludedAppIsNeverSentEvenWhileTheEntireDesktopIsWatched() {
        let finance = Observation(appName: "Finance", bundleId: "com.example.Finance", windowTitle: "Accounts")
        var machine = FocusMachine(policy: ObservationPolicy(
            allowedBundleIds: [], watchEntireDesktop: true, excludedBundleIds: [finance.bundleId]
        ))
        _ = machine.handle(.launched(consent: true), now: at(0))
        _ = machine.handle(.accessibilityChanged(granted: true), now: at(0))
        _ = machine.handle(.connectionChanged(isConnected: true), now: at(0))
        XCTAssertFalse(sends(machine.handle(.appChanged(finance), now: at(0))))
        XCTAssertFalse(sends(machine.handle(.contextLoaded(context(), generation: machine.generation), now: at(0))))
        XCTAssertFalse(sends(machine.handle(.sampleTimerFired(generation: machine.generation), now: at(300))))
    }

    func testExcludingTheAppInFrontStopsItBeingSent() {
        var machine = armed()
        let excluding = ObservationPolicy(allowedBundleIds: ["com.apple.Safari"], excludedBundleIds: ["com.apple.Safari"])
        _ = machine.handle(.policyChanged(excluding), now: at(10))
        XCTAssertFalse(sends(machine.handle(.sampleTimerFired(generation: machine.generation), now: at(300))))
    }

    func testWithoutAccessibilityNothingIsSent() {
        var machine = armed()
        _ = machine.handle(.accessibilityChanged(granted: false), now: at(10))
        XCTAssertFalse(sends(machine.handle(.appChanged(safari), now: at(200))))
    }

    func testAnEndedBlockIsNotJudged() {
        var machine = armed()
        let afterEnd = ServerTime.parse("2026-12-01T11:00:01.000Z")!
        XCTAssertFalse(sends(machine.handle(.sampleTimerFired(generation: machine.generation), now: afterEnd)))
    }

    func testNotReadyWhenNoModelIsBoundAndNothingIsSent() {
        var machine = armed()
        let effects = machine.handle(
            .contextLoaded(context(ready: false), generation: machine.generation), now: at(60)
        )
        XCTAssertEqual(machine.state, .notReady)
        XCTAssertFalse(sends(effects))
        XCTAssertFalse(sends(machine.handle(.appChanged(safari), now: at(200))))
    }

    // MARK: cadence

    func testTheFirstSampleIsSentWhenTheBlockIsFoundAndContextRefreshesEverySixtySeconds() {
        var machine = FocusMachine(policy: ObservationPolicy(allowedBundleIds: ["com.apple.Safari"]))
        _ = machine.handle(.launched(consent: true), now: at(0))
        _ = machine.handle(.accessibilityChanged(granted: true), now: at(0))
        _ = machine.handle(.appChanged(safari), now: at(0))
        _ = machine.handle(.connectionChanged(isConnected: true), now: at(0))
        let generation = machine.generation

        let effects = machine.handle(.contextLoaded(context(), generation: generation), now: at(0))

        XCTAssertTrue(effects.contains(.scheduleContext(after: 60, generation: generation)))
        XCTAssertTrue(effects.contains(.sendObservation(safari, blockId: blockId, generation: generation)))
        XCTAssertTrue(effects.contains(.scheduleSample(after: 300, generation: generation)))
        XCTAssertEqual(machine.state, .watching(blockId: blockId, title: "Study AI", endsAt: ServerTime.parse("2026-12-01T11:00:00.000Z")!))
    }

    private func armedForBoth() -> FocusMachine {
        let allowBoth = ObservationPolicy(allowedBundleIds: ["com.apple.Safari", "com.apple.mail"])
        var machine = FocusMachine(policy: allowBoth)
        _ = machine.handle(.launched(consent: true), now: at(0))
        _ = machine.handle(.accessibilityChanged(granted: true), now: at(0))
        _ = machine.handle(.appChanged(safari), now: at(0))
        _ = machine.handle(.connectionChanged(isConnected: true), now: at(0))
        _ = machine.handle(.contextLoaded(context(), generation: machine.generation), now: at(0)) // sends Safari at 0
        return machine
    }

    private func dwell(_ effects: [FocusEffect]) -> Int? {
        for effect in effects {
            if case .scheduleDwell(let after, _, let change) = effect, after == FocusMachine.dwell { return change }
        }
        return nil
    }

    func testAnAppChangeIsJudgedOnlyAfterItStaysInFrontForTheDwell() {
        var machine = armedForBoth()
        let effects = machine.handle(.appChanged(mail), now: at(1))
        XCTAssertFalse(sends(effects))
        let change = try! XCTUnwrap(dwell(effects))

        let fired = machine.handle(.dwellTimerFired(generation: machine.generation, change: change), now: at(6))
        XCTAssertTrue(fired.contains(.sendObservation(mail, blockId: blockId, generation: machine.generation)))
    }

    func testAGlanceIsNeverJudged() {
        var machine = armedForBoth()
        let glance = try! XCTUnwrap(dwell(machine.handle(.appChanged(mail), now: at(1))))
        // Back to the window already judged: nothing new to wait for.
        XCTAssertEqual(machine.handle(.appChanged(safari), now: at(3)), [])
        XCTAssertFalse(sends(machine.handle(.dwellTimerFired(generation: machine.generation, change: glance), now: at(6))))
    }

    func testOnlyTheNewestChangeIsJudged() {
        var machine = armedForBoth()
        let older = try! XCTUnwrap(dwell(machine.handle(.appChanged(mail), now: at(1))))
        let reddit = Observation(appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Reddit")
        let newer = try! XCTUnwrap(dwell(machine.handle(.appChanged(reddit), now: at(3))))
        XCTAssertFalse(sends(machine.handle(.dwellTimerFired(generation: machine.generation, change: older), now: at(6))))
        let fired = machine.handle(.dwellTimerFired(generation: machine.generation, change: newer), now: at(8))
        XCTAssertTrue(fired.contains(.sendObservation(reddit, blockId: blockId, generation: machine.generation)))
    }

    func testSwitchingToADeniedAppCancelsTheWait() {
        var machine = armedForBoth()
        let change = try! XCTUnwrap(dwell(machine.handle(.appChanged(mail), now: at(1))))
        let denied = Observation(appName: "1Password", bundleId: "com.1password.1password", windowTitle: "Vault")
        XCTAssertEqual(machine.handle(.appChanged(denied), now: at(2)), [])
        XCTAssertFalse(sends(machine.handle(.dwellTimerFired(generation: machine.generation, change: change), now: at(6))))
    }

    func testAfterPauseTheDwellTimerSendsNothing() {
        var machine = armedForBoth()
        let generation = machine.generation
        let change = try! XCTUnwrap(dwell(machine.handle(.appChanged(mail), now: at(1))))
        _ = machine.handle(.connectionChanged(isConnected: false), now: at(2))
        XCTAssertFalse(sends(machine.handle(.dwellTimerFired(generation: generation, change: change), now: at(6))))
    }

    func testASampleTimerSendsAndSchedulesTheNextFiveMinutesOut() {
        var machine = armed()
        let effects = machine.handle(.sampleTimerFired(generation: machine.generation), now: at(300))
        XCTAssertTrue(sends(effects))
        XCTAssertTrue(effects.contains(.scheduleSample(after: 300, generation: machine.generation)))
    }

    func testAStaleTimerIsIgnored() {
        var machine = armed()
        XCTAssertEqual(machine.handle(.sampleTimerFired(generation: machine.generation - 1), now: at(300)), [])
        XCTAssertEqual(machine.handle(.contextTimerFired(generation: machine.generation - 1), now: at(300)), [])
    }

    func testContextTimerFetchesAgain() {
        var machine = armed()
        XCTAssertEqual(
            machine.handle(.contextTimerFired(generation: machine.generation), now: at(60)),
            [.fetchContext(generation: machine.generation)]
        )
    }

    // MARK: judgments and nudges

    func testANudgeAnswerShowsExactlyOneNudgeNamingTheBlock() {
        var machine = armed()
        let effects = machine.handle(.judged(judgment(.distracted, nudge: true), generation: machine.generation), now: at(40))
        XCTAssertEqual(effects.filter { if case .showNudge = $0 { return true } else { return false } }, [.showNudge(title: "Study AI")])
        XCTAssertTrue(effects.contains(.rememberJudgment(judgment(.distracted, nudge: true))))
    }

    func testAnAnswerWithoutTheNudgeFlagNeverShowsANudge() {
        var machine = armed()
        for label in [FocusLabel.focused, .necessaryDetour, .distracted, .insufficientEvidence] {
            let effects = machine.handle(.judged(judgment(label, nudge: false), generation: machine.generation), now: at(40))
            XCTAssertFalse(effects.contains { if case .showNudge = $0 { return true } else { return false } }, "\(label)")
        }
    }

    func testAJudgmentFromAnOldGenerationIsIgnored() {
        var machine = armed()
        let old = machine.generation
        _ = machine.handle(.connectionChanged(isConnected: false), now: at(5))
        _ = machine.handle(.connectionChanged(isConnected: true), now: at(6))
        XCTAssertEqual(machine.handle(.judged(judgment(.distracted, nudge: true), generation: old), now: at(7)), [])
    }

    func testAFailedJudgmentMovesToUnreachableWithoutRetryingAndNeverNudges() {
        var machine = armed()
        let effects = machine.handle(.judgeFailed(.unreachable, generation: machine.generation), now: at(40))
        XCTAssertEqual(machine.state, .unreachable)
        XCTAssertEqual(effects, [])
        // The next scheduled sample tries again; a second failure does not add more work.
        XCTAssertEqual(machine.handle(.judgeFailed(.server(status: 500), generation: machine.generation), now: at(41)), [])
    }

    func testAJudgmentAfterAFailureRecoversTheWatchingState() {
        var machine = armed()
        _ = machine.handle(.judgeFailed(.unreachable, generation: machine.generation), now: at(40))
        _ = machine.handle(.judged(judgment(.focused), generation: machine.generation), now: at(340))
        if case .watching = machine.state {} else { XCTFail("expected watching, got \(machine.state)") }
    }

    func testAServerSayingNotReadyMovesToNotReady() {
        var machine = armed()
        _ = machine.handle(.judgeFailed(.focusNotReady, generation: machine.generation), now: at(40))
        XCTAssertEqual(machine.state, .notReady)
    }

    func testAServerSayingThereIsNoBlockFetchesTheContextAgain() {
        var machine = armed()
        let effects = machine.handle(.judgeFailed(.noBlock, generation: machine.generation), now: at(40))
        XCTAssertEqual(effects, [.fetchContext(generation: machine.generation)])
    }

    func testAFailedContextFetchMovesToUnreachableAndTriesAgainInAMinute() {
        var machine = armed()
        let effects = machine.handle(.contextFailed(.unreachable, generation: machine.generation), now: at(60))
        XCTAssertEqual(machine.state, .unreachable)
        XCTAssertEqual(effects, [.scheduleContext(after: 60, generation: machine.generation)])
    }

    // MARK: Test nudge, first consent

    func testTestNudgeAlwaysAsksForTheFixedTestNotification() {
        var machine = FocusMachine()
        XCTAssertEqual(machine.handle(.userTestNudge, now: at(0)), [.showTestNudge])
    }

    func testTheFirstConsentAsksForNotificationPermissionExactlyOnce() {
        var machine = FocusMachine()
        _ = machine.handle(.launched(consent: false), now: at(0))

        let first = machine.handle(.userToggleConsent(true), now: at(1))
        XCTAssertEqual(first.filter { $0 == .requestNotificationPermission }.count, 1)
        XCTAssertEqual(first.first, .persistConsent(true))

        _ = machine.handle(.userToggleConsent(false), now: at(2))
        let second = machine.handle(.userToggleConsent(true), now: at(3))
        XCTAssertFalse(second.contains(.requestNotificationPermission))
    }

    func testTurningConsentOffCancelsAfterPersisting() {
        var machine = armed()
        XCTAssertEqual(machine.handle(.userToggleConsent(false), now: at(9)), [.persistConsent(false), .cancelAll])
    }
}
