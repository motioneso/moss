import XCTest
@testable import TrailMarker

final class MeetingControlOutboxTests: XCTestCase {
    func testLateStatusCannotOverwriteSuccessfulPauseBeforeStop() throws {
        var outbox = MeetingControlOutbox()
        XCTAssertTrue(outbox.accepts(generation: 1))
        outbox.stage(command: "pause", meetingId: "meeting", grantId: "grant", generation: 1)
        let pause = try XCTUnwrap(outbox.pending)
        outbox.received(requestKey: pause.requestKey, desired: "paused")
        XCTAssertTrue(outbox.accepts(generation: 2))
        XCTAssertFalse(outbox.accepts(generation: 1))
        outbox.stage(command: "stop", meetingId: "meeting", grantId: "grant", generation: outbox.latestGeneration)
        XCTAssertEqual(outbox.pending?.expectedGeneration, 2)
        XCTAssertEqual(outbox.pending?.command, "stop")
    }

    func testLostStopRequestRetainsUUIDUntilDeliveryConfirmed() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "stop", meetingId: "meeting", grantId: "grant", generation: 1)
        let original = try XCTUnwrap(outbox.pending)
        // Transport failed before receipt; status still reports the same recording generation.
        outbox.reconcile(generation: 1, desired: "recording")
        XCTAssertEqual(outbox.pending?.requestKey, original.requestKey)
        XCTAssertEqual(outbox.pending?.expectedGeneration, original.expectedGeneration)
        outbox.received(requestKey: original.requestKey, desired: "stopped")
        XCTAssertNil(outbox.pending)
    }

    func testLostSuccessfulStopResponseReconcilesFromStatusWithoutNewRequest() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "stop", meetingId: "meeting", grantId: "grant", generation: 1)
        XCTAssertNotNil(outbox.pending)
        XCTAssertTrue(outbox.accepts(generation: 2))
        outbox.reconcile(generation: 2, desired: "stopped")
        XCTAssertNil(outbox.pending)
    }

    func testConflictRebasesStopWithoutTurningItIntoRecord() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "stop", meetingId: "meeting", grantId: "grant", generation: 1)
        let oldKey = try XCTUnwrap(outbox.pending?.requestKey)
        // An independent Pause won first; retry Stop against its known revision.
        outbox.reconcile(generation: 2, desired: "paused")
        XCTAssertEqual(outbox.pending?.command, "stop")
        XCTAssertEqual(outbox.pending?.expectedGeneration, 2)
        XCTAssertNotEqual(outbox.pending?.requestKey, oldKey)
        let retryKey = outbox.pending?.requestKey
        outbox.reconcile(generation: 2, desired: "paused")
        XCTAssertEqual(outbox.pending?.requestKey, retryKey)
    }

    func testStopSupersedesInFlightPauseAndLatePauseCannotClearStop() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "pause", meetingId: "meeting", grantId: "grant", generation: 1)
        let pauseKey = try XCTUnwrap(outbox.pending?.requestKey)
        outbox.stage(command: "stop", meetingId: "meeting", grantId: "grant", generation: 1)
        outbox.received(requestKey: pauseKey, desired: "paused")
        XCTAssertEqual(outbox.pending?.command, "stop")
        outbox.reconcile(generation: 2, desired: "paused")
        XCTAssertEqual(outbox.pending?.expectedGeneration, 2)
        outbox.stage(command: "pause", meetingId: "meeting", grantId: "grant", generation: 2)
        XCTAssertEqual(outbox.pending?.command, "stop")
    }
    func testResumeRetriesTheExactUUIDOnlyAtItsOriginalPausedGeneration() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 2)
        let original = try XCTUnwrap(outbox.pending)
        outbox.reconcile(generation: 2, desired: "paused")
        XCTAssertEqual(outbox.pending?.requestKey, original.requestKey)
        XCTAssertEqual(outbox.pending?.expectedGeneration, 2)
        outbox.received(requestKey: original.requestKey, desired: "recording")
        XCTAssertNil(outbox.pending, "Confirmed Resume must clear only its matching request")
    }

    func testResumeNeverRebasesAcrossNewerPauseStopOrSource() throws {
        for desired in ["paused", "recording", "stopped", "revoked"] {
            var outbox = MeetingControlOutbox()
            outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 2)
            outbox.reconcile(generation: 3, desired: desired)
            XCTAssertNil(outbox.pending, "Newer authority must cancel Resume instead of minting another request")
        }
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 2)
        outbox.reconcile(generation: 2, desired: "paused", retainedSourceMatches: false)
        XCTAssertNil(outbox.pending, "A changed retained source cancels Resume")
    }

    func testPendingPauseOrStopCannotBeOverriddenByResume() throws {
        for command in ["pause", "stop"] {
            var outbox = MeetingControlOutbox()
            outbox.stage(command: command, meetingId: "meeting", grantId: "grant", generation: 1)
            let original = try XCTUnwrap(outbox.pending)
            outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 1)
            XCTAssertEqual(outbox.pending?.command, command, "Resume must not override pending Pause or Stop")
            XCTAssertEqual(outbox.pending?.requestKey, original.requestKey)
        }
    }

    func testStopSupersedesResumeAndLateResumeAcknowledgmentCannotClearIt() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 2)
        let resume = try XCTUnwrap(outbox.pending)
        outbox.stage(command: "stop", meetingId: "meeting", grantId: "grant", generation: 2)
        outbox.received(requestKey: resume.requestKey, desired: "recording")
        outbox.reconcile(generation: 3, desired: "recording")
        XCTAssertEqual(outbox.pending?.command, "stop")
        XCTAssertEqual(outbox.pending?.expectedGeneration, 3)
    }

    func testDefinitiveResumeRejectionClearsOnlyThatIntentAndNeverStop() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 2)
        let original = try XCTUnwrap(outbox.pending)
        XCTAssertTrue(outbox.rejectResume(requestKey: original.requestKey))
        XCTAssertNil(outbox.pending, "A rejected Resume must require another click")
        outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 2)
        XCTAssertNotEqual(outbox.pending?.requestKey, original.requestKey)
        outbox.stage(command: "stop", meetingId: "meeting", grantId: "grant", generation: 2)
        XCTAssertFalse(outbox.rejectResume(requestKey: original.requestKey))
        XCTAssertEqual(outbox.pending?.command, "stop", "A stale Resume rejection must preserve Stop")
    }

    func testPauseSupersedesResumeAndLateResumeAcknowledgmentCannotClearIt() throws {
        var outbox = MeetingControlOutbox()
        outbox.stage(command: "record", meetingId: "meeting", grantId: "grant", generation: 2)
        let resume = try XCTUnwrap(outbox.pending)
        outbox.stage(command: "pause", meetingId: "meeting", grantId: "grant", generation: 2)
        outbox.received(requestKey: resume.requestKey, desired: "recording")
        outbox.reconcile(generation: 3, desired: "recording")
        XCTAssertEqual(outbox.pending?.command, "pause", "Late Resume acknowledgment must preserve a newer Pause")
        XCTAssertEqual(outbox.pending?.expectedGeneration, 3)
    }

}
