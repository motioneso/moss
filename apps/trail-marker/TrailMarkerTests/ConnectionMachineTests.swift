import XCTest
@testable import TrailMarker

final class ConnectionMachineTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testLaunchWithCredentialAndEnabledStartsReconnectingAndSendsHeartbeat() {
        var machine = ConnectionMachine()
        let effects = machine.handle(.launched(hasCredential: true, enabled: true), now: now)

        XCTAssertEqual(machine.state, .reconnecting(attempt: 0, lastContact: nil))
        XCTAssertEqual(effects, [.sendHeartbeat(generation: 0)])

        let nextEffects = machine.handle(.heartbeatSucceeded(at: now, generation: 0), now: now)
        XCTAssertEqual(machine.state, .connected(lastContact: now))
        XCTAssertEqual(nextEffects, [.scheduleHeartbeat(after: 60, generation: 0)])
    }

    func testLaunchWithCredentialButDisabledStaysDisconnectedWithNoEffects() {
        var machine = ConnectionMachine()
        let effects = machine.handle(.launched(hasCredential: true, enabled: false), now: now)

        XCTAssertEqual(machine.state, .disconnected)
        XCTAssertEqual(effects, [])
    }

    func testUserDisconnectFromConnectedPersistsThenCancels() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 3)
        let effects = machine.handle(.userDisconnect, now: now)

        XCTAssertEqual(machine.state, .disconnected)
        XCTAssertEqual(effects, [.persistEnabled(false), .cancelAll])
    }

    func testStaleHeartbeatSucceededAfterDisconnectIsIgnored() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 3)
        _ = machine.handle(.userDisconnect, now: now)
        let staleGeneration = 3

        let effects = machine.handle(.heartbeatSucceeded(at: now, generation: staleGeneration), now: now)

        XCTAssertEqual(machine.state, .disconnected)
        XCTAssertEqual(effects, [])
    }

    func testNoEventsProduceEffectsWhileDisconnected() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 3)
        _ = machine.handle(.userDisconnect, now: now)
        let staleGeneration = 3

        XCTAssertEqual(machine.handle(.wake, now: now), [])
        XCTAssertEqual(machine.handle(.networkChanged, now: now), [])
        XCTAssertEqual(machine.handle(.timerFired(generation: staleGeneration), now: now), [])
        XCTAssertEqual(machine.state, .disconnected)
    }

    func testUnreachableFailuresBackOffWithoutExceedingTheCap() {
        // Three failures: 5s, 10s, 20s (times jitter) — well below the cap, so strictly
        // increasing is guaranteed (the jitter ranges for successive doublings never overlap).
        var machine = ConnectionMachine(state: .reconnecting(attempt: 0, lastContact: nil), generation: 0)

        var backoffs: [TimeInterval] = []
        for _ in 0..<3 {
            let effects = machine.handle(.heartbeatFailed(.unreachable, generation: 0), now: now)
            guard case .scheduleHeartbeat(let after, let generation) = effects.first else {
                return XCTFail("expected a scheduleHeartbeat effect, got \(effects)")
            }
            XCTAssertEqual(generation, 0)
            backoffs.append(after)
        }

        for backoff in backoffs {
            XCTAssertLessThanOrEqual(backoff, 300)
        }
        for index in 1..<backoffs.count {
            XCTAssertGreaterThan(backoffs[index], backoffs[index - 1], "backoff should grow")
        }
        if case .reconnecting = machine.state {} else {
            XCTFail("expected to stay in .reconnecting")
        }
    }

    func testBackoffNeverExceedsTheCapEvenAfterManyFailures() {
        // Many more failures than it takes to saturate: the cap must hold even once jittered
        // values start clustering at the ceiling.
        var machine = ConnectionMachine(state: .reconnecting(attempt: 0, lastContact: nil), generation: 0)

        for _ in 0..<12 {
            let effects = machine.handle(.heartbeatFailed(.unreachable, generation: 0), now: now)
            guard case .scheduleHeartbeat(let after, _) = effects.first else {
                return XCTFail("expected a scheduleHeartbeat effect, got \(effects)")
            }
            XCTAssertLessThanOrEqual(after, 300)
        }
    }

    func testCredentialInvalidFailureRequiresSignIn() {
        var machine = ConnectionMachine(state: .reconnecting(attempt: 2, lastContact: nil), generation: 0)
        let effects = machine.handle(.heartbeatFailed(.credentialInvalid, generation: 0), now: now)

        XCTAssertEqual(machine.state, .signInRequired(reason: .revoked))
        XCTAssertEqual(effects, [.cancelAll, .clearLocalData(keepInstance: true)])
    }

    func testTLSAndServerErrorsStayReconnecting() {
        for error in [CompanionError.tls, CompanionError.server(status: 503)] {
            var machine = ConnectionMachine(state: .reconnecting(attempt: 0, lastContact: nil), generation: 0)
            _ = machine.handle(.heartbeatFailed(error, generation: 0), now: now)

            if case .signInRequired = machine.state {
                XCTFail("\(error) should not require sign-in")
            }
            if case .reconnecting = machine.state {} else {
                XCTFail("\(error) should stay reconnecting, got \(machine.state)")
            }
        }
    }

    func testUserRetryFromReconnectingCancelsAndResends() {
        var machine = ConnectionMachine(state: .reconnecting(attempt: 4, lastContact: nil), generation: 0)
        let effects = machine.handle(.userRetry, now: now)

        XCTAssertEqual(effects, [.cancelAll, .sendHeartbeat(generation: 1)])
    }

    func testUserRetryFromDisconnectedDoesNothing() {
        var machine = ConnectionMachine(state: .disconnected, generation: 0)
        XCTAssertEqual(machine.handle(.userRetry, now: now), [])
    }

    /// Log Out from paused used to be ignored, so a paused Mac couldn't be logged out and kept
    /// every setting (#2643).
    func testUserLogoutWhilePausedRevokesAndClears() {
        var machine = ConnectionMachine(state: .disconnected, generation: 3)
        let effects = machine.handle(.userLogout, now: now)

        XCTAssertEqual(machine.state, .notLinked)
        XCTAssertEqual(effects, [.cancelAll, .revokeRemotely(generation: 3), .clearCredential, .clearLocalData(keepInstance: false)])
    }

    /// A blocked account may be unblocked, so the link and its settings are kept.
    func testABlockedAccountDoesNotClearLocalData() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 2)
        let effects = machine.handle(.heartbeatFailed(.accountBlocked(code: "account_deactivated"), generation: 2), now: now)
        XCTAssertEqual(effects, [.cancelAll])
    }

    func testUserLogoutFromConnectedRevokesAndClears() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 5)
        let effects = machine.handle(.userLogout, now: now)

        XCTAssertEqual(machine.state, .notLinked)
        XCTAssertEqual(effects, [.cancelAll, .revokeRemotely(generation: 5), .clearCredential, .clearLocalData(keepInstance: false)])

        let laterEffects = machine.handle(.heartbeatFailed(.unreachable, generation: 5), now: now)
        XCTAssertEqual(laterEffects, [.showLogoutUnconfirmed])
    }

    func testUserQuitCancelsWithoutTouchingThePersistedEnabledFlag() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 1)
        let effects = machine.handle(.userQuit, now: now)

        XCTAssertEqual(effects, [.cancelAll])
        XCTAssertFalse(effects.contains(.persistEnabled(true)))
        XCTAssertFalse(effects.contains(.persistEnabled(false)))
    }

    func testRevokedCredentialWhileConnectedRequiresSignIn() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 2)
        let effects = machine.handle(.heartbeatFailed(.credentialInvalid, generation: 2), now: now)

        XCTAssertEqual(machine.state, .signInRequired(reason: .revoked))
        XCTAssertEqual(effects, [.cancelAll, .clearLocalData(keepInstance: true)])
    }

    func testNetworkFailureWhileConnectedStartsReconnectingAndKeepsLastContact() {
        var machine = ConnectionMachine(state: .connected(lastContact: now), generation: 2)
        let effects = machine.handle(.heartbeatFailed(.unreachable, generation: 2), now: now)

        XCTAssertEqual(machine.state, .reconnecting(attempt: 1, lastContact: now))
        guard case .scheduleHeartbeat(let after, let generation) = effects.first else {
            return XCTFail("expected a retry to be scheduled, got \(effects)")
        }
        XCTAssertLessThanOrEqual(after, 300)
        XCTAssertEqual(generation, 2)
    }
}
