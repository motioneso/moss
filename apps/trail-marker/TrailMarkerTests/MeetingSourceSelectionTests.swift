import Foundation
import XCTest
@testable import TrailMarker

@MainActor
final class MeetingSourceSelectionTests: XCTestCase {
    typealias Fixture = MeetingHostLifecycleTests.Fixture
    typealias Device = MeetingHostLifecycleTests.Device
    private let second = MeetingCaptureChoice.Microphone(deviceId: "second-uid", sourceId: "second-mic")

    func testComputerOnlySelectionHasNoMicrophoneAndEncodesExplicitNull() throws {
        let selection = computerOnly
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(selection)) as? [String: Any])
        XCTAssertTrue(object["microphone"] is NSNull, "Computer-only selection must explicitly encode null microphone")
        let resolved = try snapshot(microphones: false).resolve(selection)
        XCTAssertNil(resolved.selection.microphoneDeviceID)
        XCTAssertEqual(resolved.selection.sources, [.output])
        XCTAssertThrowsError(try MeetingNativeSelection(microphoneDeviceID: nil, output: nil).validate())
        XCTAssertThrowsError(try MeetingNativeSelection(microphoneDeviceID: nil, output: .selectedProcesses([1])).validate())
        XCTAssertThrowsError(try snapshot().resolve(.init(mode: "microphone-only", microphone: nil,
            outputSourceId: nil, appProcessTreeId: nil, scope: nil)))
        let wrongSource = MeetingCaptureChoice(mode: "microphone-only", microphone: .init(deviceId: "mic-uid", sourceId: "wrong"),
            outputSourceId: nil, appProcessTreeId: nil, scope: nil)
        XCTAssertThrowsError(try snapshot().resolve(wrongSource), "Device identity alone cannot authorize another source ID")
        let widened = MeetingCaptureChoice(mode: "computer-audio", microphone: nil, outputSourceId: "output",
            appProcessTreeId: nil, scope: .init(kind: "process-exclusion", endpointId: nil, excludedProcessTreeIds: []))
        XCTAssertThrowsError(try snapshot().resolve(widened), "Computer audio must preserve exact process exclusions")
        let collision = MeetingCaptureChoice(mode: "computer-audio", microphone: nil, outputSourceId: "mic",
            appProcessTreeId: nil, scope: computerOnly.scope)
        XCTAssertThrowsError(try snapshot().resolve(collision))
    }

    func testLegacyControlBodyCannotAccidentallyIncludeSourceChangeFields() throws {
        for command in ["record", "pause", "stop"] {
            let body = MeetingCaptureControlBody(meetingId: "meeting", grantId: "grant", requestKey: "request",
                expectedGeneration: 2, command: command)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
            XCTAssertNil(object["selection"])
            XCTAssertNil(object["expectedEpoch"])
        }
    }

    func testSystemOnlyStartNeverRequestsMicrophonePermissionOrCreatesMicrophone() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .denied
        fixture.server.setSelection(computerOnly)
        let output = Device()
        let host = fixture.host(snapshot: snapshot(microphones: false), factory: { selection in
            XCTAssertNil(selection.microphoneDeviceID, "System-only factory must never acquire a microphone")
            XCTAssertEqual(selection.sources, [.output])
            return [.output: output]
        }) { XCTFail("System-only capture must never request microphone permission"); return false }
        defer { host.shutdown(reason: "Synthetic system-only test") }
        try await start(host, fixture)
        XCTAssertEqual(output.starts, 1)
        XCTAssertEqual(fixture.device.starts, 0)
        XCTAssertEqual(fixture.permissionReads, 0, "System-only capture must not consult microphone permission")
        host.setComputerAudioFromUserClick(false)
        XCTAssertEqual(host.sourceSelectionError, MeetingSourceChoice.emptyMessage)
        XCTAssertEqual(host.phase, .recording)
        XCTAssertEqual(output.stops, 0)
        XCTAssertEqual(host.sourceDescription, "Computer audio")
        host.pauseFromUserClick()
        XCTAssertEqual(output.stops, 1)
        XCTAssertTrue(try fixture.runtime.service(at: fixture.monotonic).allSatisfy { $0.source == .output })
    }

    func testBothOffRejectsBeforeDeviceCloseOrNetworkAndKeepsPriorSelection() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic invalid-selection test") }
        try await start(host, fixture)
        let old = host.currentSourceChoice
        let requests = fixture.server.controlCount
        host.selectMicrophoneFromUserClick(nil)
        XCTAssertEqual(host.sourceSelectionError, "Select a microphone or turn on computer audio.")
        XCTAssertEqual(host.phase, .recording, "Both-off rejection must leave prior capture running")
        XCTAssertEqual(host.currentSourceChoice, old)
        XCTAssertEqual(fixture.device.stops, 0, "Both-off rejection must happen before native shutdown")
        XCTAssertEqual(fixture.server.controlCount, requests, "Both-off rejection must happen before network control")
        host.dismissSourceSelectionError()
        XCTAssertNil(host.sourceSelectionError)
    }

    func testManualSourceEditSupersedesAdoptedRecoveryAwaitingRecordingAcknowledgment() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let originalDevice = fixture.device
        let replacement = Device()
        let host = fixture.host(snapshot: snapshot(), factory: { selection in
            [.microphone: selection.microphoneDeviceID == 43 ? replacement : originalDevice]
        }) { false }
        defer {
            host.shutdown(reason: "Manual edit supersedes recovery test")
            fixture.server.releaseRecordingStatusReplies()
        }
        try await start(host, fixture)
        fixture.server.holdRecordingStatusReplies(forGeneration: 2)
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        try await waitUntil(timeout: 6) { fixture.device.starts == 2 && host.phase == .recording }
        XCTAssertTrue(host.canChangeSourcesFromUserClick)
        let unchanged = try XCTUnwrap(host.currentSourceChoice)
        try host.changeSourcesFromUserClick(unchanged)
        let invalid = MeetingCaptureChoice(mode: "microphone-only", microphone: nil,
            outputSourceId: nil, appProcessTreeId: nil, scope: nil)
        XCTAssertThrowsError(try host.changeSourcesFromUserClick(invalid))
        XCTAssertEqual(fixture.device.stops, 1, "Invalid and unchanged edits must leave the adopted pair alone")
        host.selectMicrophoneFromUserClick(second)
        fixture.server.releaseRecordingStatusReplies()
        try await waitUntil(timeout: 6) { replacement.starts == 1 || host.interruptionWarning != nil }
        XCTAssertEqual(replacement.starts, 1, "An explicit source edit must supersede the pending automatic recovery")
        XCTAssertEqual(host.phase, .recording)
        XCTAssertEqual(host.currentSourceChoice?.microphone, second)
        XCTAssertEqual(fixture.server.captureEpoch, 3)
        XCTAssertNil(host.sourceSelectionError)
    }

    func testLiveSourceChangeClosesOldReceiverBeforeControlAndWaitsForExactStatus() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let replacement = Device()
        let host = fixture.host(snapshot: snapshot(), factory: { selection in
            if selection.microphoneDeviceID == 43 {
                XCTAssertEqual(fixture.device.stops, 1, "Old device must close before replacement opens")
                return [.microphone: replacement]
            }
            return [.microphone: fixture.device]
        }) { false }
        defer {
            host.shutdown(reason: "Synthetic source cutover test")
            fixture.server.releaseRecordingStatusReplies()
        }
        try await start(host, fixture)
        let old = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        fixture.server.configureSource(holdStatus: true)
        host.selectMicrophoneFromUserClick(second)
        XCTAssertEqual(fixture.device.stops, 1, "Old device must close before source control transport")
        guard fixture.device.stops == 1 else { return }
        XCTAssertEqual(host.phase, .paused)
        old.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 1 })
        XCTAssertNil(old.peek(), "Old callbacks must be fenced at source cutover")
        try await waitUntil { host.sourceChangeAcknowledged }
        XCTAssertEqual(fixture.server.sourceBodies.count, 1)
        XCTAssertEqual(replacement.starts, 0, "Control acknowledgment alone must never open replacement hardware")
        guard replacement.starts == 0 else { return }
        XCTAssertEqual(fixture.server.audioCount, 0)
        // The opening status must already cover the complete replacement chunk. Updating
        // elapsed afterward leaves the independent server-time fence masking a bad ack.
        fixture.server.advanceElapsed(to: 8000)
        fixture.server.holdRecordingStatusReplies(forGeneration: 2)
        fixture.server.configureSource()
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(replacement.starts, 1)
        XCTAssertEqual(host.currentSourceChoice?.microphone, second)
        XCTAssertEqual(fixture.server.captureGeneration, 2)
        XCTAssertEqual(fixture.server.lastObservation?.generation, 1, "Source change keeps the previous-generation paused observation")
        guard host.phase == .recording, replacement.starts == 1 else { return }
        let fresh = try XCTUnwrap(replacement.receiver as? MeetingAudioBuffer)
        for index in 0..<5 {
            fresh.receive(hostTimeNanoseconds: fixture.monotonic + UInt64(index) * 1_000_000_000,
                sampleRate: 8000, frameCount: 8000, sampleAt: { _ in 0.25 })
        }
        fixture.monotonic += 6_000_000_000
        let packet = try XCTUnwrap(fresh.peekChunk(targetDurationNanoseconds: 5_000_000_000,
            cutoffNanoseconds: nil, allowPartial: false)?.packet)
        XCTAssertEqual(packet.samples.count, 40_000, "The acknowledgment proof must queue a complete five-second chunk")
        let capture = try XCTUnwrap(host.remote)
        // Use the host's synchronized origin, not the initial fixture estimate, so
        // this precondition checks the same server-time fence as the real upload.
        let origin = try XCTUnwrap(host.synchronizedOriginNanoseconds)
        let bounds = try MeetingWireAudioBoundary(packet: packet, originNanoseconds: origin)
        XCTAssertLessThanOrEqual(bounds.endMs, capture.elapsedMs,
            "The server-time fence must already permit the replacement chunk before its recording acknowledgment")
        XCTAssertTrue(fixture.runtime.snapshot.permitsSend(epoch: packet.epoch,
            endNanoseconds: packet.endNanoseconds, now: fixture.monotonic),
            "The runtime must already permit the replacement chunk before its recording acknowledgment")
        host.service()
        XCTAssertFalse(host.uploadsInFlight, "Replacement uploads wait for exact recording-epoch acknowledgment")
        XCTAssertEqual(fixture.server.audioCount, 0, "Replacement uploads wait for exact recording-epoch acknowledgment")
        guard !host.uploadsInFlight, fixture.server.audioCount == 0 else { return }
        // Hold an actual recording-status response so neither a retry error nor a fast
        // successful response can hide the distinction between submission and acknowledgment.
        try await waitUntil(timeout: 5) { fixture.server.heldRecordingStatusCount == 1 }
        host.service()
        XCTAssertFalse(host.uploadsInFlight, "Replacement uploads wait for exact recording-epoch acknowledgment")
        XCTAssertEqual(fixture.server.audioCount, 0, "Replacement uploads wait for exact recording-epoch acknowledgment")
        fixture.server.releaseRecordingStatusReplies()
        try await waitUntil {
            host.service()
            return fixture.server.audioCount == 1
        }
    }

    func testPausedSourceChangeRetainsNewChoiceWithoutOpeningUntilNormalResume() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let replacement = Device()
        let host = fixture.host(snapshot: snapshot(), factory: { selection in
            [.microphone: selection.microphoneDeviceID == 43 ? replacement : fixture.device]
        }) { false }
        defer { host.shutdown(reason: "Synthetic paused-source test") }
        try await start(host, fixture)
        host.pauseFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        host.selectMicrophoneFromUserClick(second)
        try await waitUntil(timeout: 5) { host.currentSourceChoice?.microphone == self.second && host.canResumeFromUserClick }
        XCTAssertEqual(host.phase, .paused, "Paused source change must remain paused")
        XCTAssertEqual(replacement.starts, 0)
        XCTAssertEqual(fixture.server.captureEpoch, 2)
        host.resumeFromUserClick()
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(replacement.starts, 1)
        XCTAssertEqual(host.currentSourceChoice?.microphone, second)
        XCTAssertEqual(fixture.server.captureEpoch, 3)
        XCTAssertEqual(fixture.server.resumeKeys.count, 1)
    }

    func testNormalResumeSplitsPauseGapAtAuthoritativeEpochStart() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.validateGapBoundsStrictly()
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic authoritative Resume gap test") }
        try await start(host, fixture)
        host.pauseFromUserClick()
        try await waitUntil { host.canResumeFromUserClick }
        fixture.monotonic = 12_000_000_000
        fixture.server.advanceElapsed(to: 3000)
        fixture.server.configureResume(holdStatus: true)
        host.resumeFromUserClick()
        try await waitUntil { !host.controlInFlight && host.controlOutbox.pending == nil }
        fixture.monotonic = 14_000_000_000
        fixture.server.advanceElapsed(to: 5000)
        fixture.server.configureResume(holdStatus: false)
        try await waitUntil(timeout: 5) { host.phase == .recording }
        host.service()
        let gaps = host.pendingGaps + fixture.server.retainedGaps
        XCTAssertTrue(gaps.contains { $0.epoch == 1 && $0.sourceId == "mic" && $0.startMs == 1000 && $0.endMs == 3000 },
            "Resume must end the old pause gap at the authoritative epoch start")
        XCTAssertTrue(gaps.contains { $0.epoch == 2 && $0.sourceId == "mic" && $0.startMs == 3000 && $0.endMs == 5000 },
            "Resume must attribute reopen delay only to the new epoch")
        XCTAssertFalse(gaps.contains { $0.epoch == 1 && $0.endMs > 3000 },
            "Resume pause gaps must never cross the source-epoch boundary")
        try await waitUntil(timeout: 5) { fixture.server.reportedGaps.count >= 2 }
        XCTAssertEqual(fixture.server.rejectedGapCount, 0, "Strict status must accept the split Resume gaps")
        XCTAssertEqual(fixture.server.retainedGaps.count, 2)
    }

    func testStopAfterLostSourceReplySplitsQueuedGapBeforeStatus() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.validateGapBoundsStrictly()
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic lost source reply Stop test") }
        try await start(host, fixture)
        fixture.server.advanceElapsed(to: 3000)
        fixture.server.configureSource(loseReplies: 1, holdStatus: true)
        host.selectMicrophoneFromUserClick(second)
        try await waitUntil { fixture.server.sourceBodies.count == 1 && !host.sourceChangeInFlight }
        XCTAssertEqual(fixture.server.captureEpoch, 2)
        fixture.monotonic = 14_000_000_000
        fixture.server.advanceElapsed(to: 5000)
        host.stopFromUserClick()
        try await waitUntil { !host.controlInFlight }
        XCTAssertEqual(host.pendingGaps.first?.endMs, 5000, "The fixture must queue a local gap before learning the lost source acknowledgment")
        fixture.server.configureSource()
        try await waitUntil(timeout: 5) { host.remote?.epoch == 2 }
        let gaps = host.pendingGaps + fixture.server.retainedGaps
        XCTAssertTrue(gaps.contains { $0.epoch == 1 && $0.sourceId == "mic" && $0.startMs == 1000 && $0.endMs == 3000 },
            "Lost source acknowledgment Stop must preserve the old-source gap before the boundary")
        XCTAssertTrue(gaps.contains { $0.epoch == 2 && $0.sourceId == "second-mic" && $0.startMs == 3000 && $0.endMs == 5000 },
            "Lost source acknowledgment Stop must remap only the gap after the learned boundary")
        XCTAssertFalse(gaps.contains { $0.epoch == 1 && $0.endMs > 3000 },
            "Lost source acknowledgment Stop must never report a gap across epochs")
        fixture.monotonic += 2_000_000_000
        try await waitUntil(timeout: 5) { fixture.server.stopCount == 1 }
        try await waitUntil(timeout: 5) { fixture.server.reportedGaps.count >= 2 }
        XCTAssertEqual(fixture.server.rejectedGapCount, 0, "Strict status must accept lost-ack Stop gap identities and bounds")
        XCTAssertEqual(fixture.device.starts, 1, "Lost source acknowledgment Stop must never reopen capture")
        XCTAssertEqual(fixture.server.sourceBodies.count, 1)
        XCTAssertFalse(host.sourceChangePending)
    }

    func testMismatchedSourceControlAcknowledgmentNeverReopensHardware() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic mismatched source control test") }
        try await start(host, fixture)
        fixture.server.configureSource()
        fixture.server.mismatchSourceReplies(control: true)
        host.selectMicrophoneFromUserClick(second)
        try await waitUntil(timeout: 5) { !host.sourceChangePending }
        XCTAssertEqual(fixture.device.starts, 1, "Mismatched source control acknowledgment must never reopen hardware")
        XCTAssertTrue(host.sourceSelectionError?.contains("recording changed") == true,
            "Mismatched source control acknowledgment must reject the intent")
    }

    func testMismatchedSourceStatusAcknowledgmentNeverReopensHardware() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic mismatched source status test") }
        try await start(host, fixture)
        fixture.server.configureSource(holdStatus: true)
        host.selectMicrophoneFromUserClick(second)
        try await waitUntil { host.sourceChangeAcknowledged }
        fixture.server.mismatchSourceReplies(status: true)
        fixture.server.configureSource()
        try await waitUntil(timeout: 5) { !host.sourceChangePending }
        XCTAssertEqual(fixture.device.starts, 1, "Mismatched source status acknowledgment must never reopen hardware")
        XCTAssertTrue(host.sourceSelectionError?.contains("recording changed") == true,
            "Mismatched source status acknowledgment must reject the intent")
    }

    func testLostSourceReplyRetriesIdenticalIntentAndSuppressesPausedStatus() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic source retry test") }
        try await start(host, fixture)
        fixture.server.configureSource(loseReplies: 1, holdStatus: true)
        host.selectMicrophoneFromUserClick(second)
        try await waitUntil { !host.sourceChangeInFlight && fixture.server.sourceBodies.count == 1 }
        let statusCount = fixture.server.statusCount
        host.selectMicrophoneFromUserClick(nil)
        try await Task.sleep(nanoseconds: 2_100_000_000)
        XCTAssertEqual(fixture.server.statusCount, statusCount, "No ordinary paused status while source outcome is pending")
        fixture.monotonic += 2_000_000_000
        try await waitUntil(timeout: 5) { host.sourceChangeAcknowledged }
        XCTAssertEqual(fixture.server.sourceBodies.count, 2)
        XCTAssertEqual(fixture.server.sourceBodies.first, fixture.server.sourceBodies.last, "Retry must preserve complete source body and UUID")
        XCTAssertEqual(fixture.server.captureEpoch, 2, "Lost reply must not create a second source epoch")
        XCTAssertEqual(fixture.device.starts, 1)
        fixture.server.configureSource()
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(fixture.device.starts, 2)
    }

    func testSourceNetworkFailureHasBoundedRetriesAndLeavesCapturePaused() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic bounded-source retry test") }
        try await start(host, fixture)
        fixture.server.configureSource(unavailable: true)
        host.selectMicrophoneFromUserClick(second)
        for expected in 1...3 {
            try await waitUntil(timeout: 5) { fixture.server.sourceBodies.count == expected && !host.sourceChangeInFlight }
            if expected < 3 { fixture.monotonic += 2_000_000_000 }
        }
        XCTAssertFalse(host.sourceChangePending)
        XCTAssertEqual(Set(fixture.server.sourceBodies).count, 1, "All bounded attempts must reuse identical bytes")
        XCTAssertEqual(host.phase, .paused)
        XCTAssertEqual(fixture.device.starts, 1, "Network uncertainty must never reopen old or new hardware")
        XCTAssertTrue(host.sourceSelectionError?.contains("could not be confirmed") == true)
    }

    func testStopCancelsQueuedSourceChangeBeforeTransportAndCannotReopen() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic source Stop test") }
        try await start(host, fixture)
        host.selectMicrophoneFromUserClick(second)
        let completion = try XCTUnwrap(host.sourceChangeCompletion)
        host.stopFromUserClick()
        await completion()
        try await waitUntil { fixture.server.stopCount == 1 }
        XCTAssertEqual(fixture.server.sourceBodies.count, 0, "Stop must cancel queued source change before transport")
        XCTAssertFalse(host.sourceChangePending)
        XCTAssertEqual(fixture.device.starts, 1, "Stop must never open replacement devices")
    }

    func testCleanupFailureKeepsStopRecoveryAndSendsNoSourceChange() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic cleanup test") }
        try await start(host, fixture)
        fixture.device.failStop = true
        host.selectMicrophoneFromUserClick(second)
        if let completion = host.sourceChangeCompletion { await completion() }
        XCTAssertTrue(host.cleanupBlocked)
        XCTAssertTrue(host.canStop, "Source cleanup failure must preserve Stop recovery")
        XCTAssertEqual(fixture.server.sourceBodies.count, 0, "Cleanup failure must never send a source control")
        XCTAssertEqual(fixture.device.starts, 1)
        fixture.device.failStop = false
        host.stopFromUserClick()
        XCTAssertFalse(host.cleanupBlocked)
        XCTAssertEqual(host.phase, .stopped)
    }

    func testOlderStatusResponseCannotUndoSourceAcknowledgmentOrOpenOldDevice() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let replacement = Device()
        let host = fixture.host(snapshot: snapshot(), factory: { selection in
            [.microphone: selection.microphoneDeviceID == 43 ? replacement : fixture.device]
        }) { false }
        defer { host.shutdown(reason: "Synthetic stale-status test") }
        try await start(host, fixture)
        fixture.server.delayNextStatus(0.5)
        let prior = fixture.server.statusCount
        try await waitUntil(timeout: 3) { fixture.server.statusCount > prior }
        host.selectMicrophoneFromUserClick(second)
        try await waitUntil { host.sourceChangeAcknowledged }
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(host.remote?.generation, 2, "Pre-cutover status reply must not overwrite newer source authority")
        XCTAssertTrue(host.sourceChangeAcknowledged, "Pre-cutover status must preserve the newer source intent")
        XCTAssertEqual(replacement.starts, 0)
        try await waitUntil(timeout: 5) { host.phase == .recording }
        XCTAssertEqual(fixture.device.starts, 1)
        XCTAssertEqual(replacement.starts, 1)
    }

    func testNewerGenerationRejectsSourceIntentWithoutRebase() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host(snapshot: snapshot()) { false }
        defer { host.shutdown(reason: "Synthetic stale-source test") }
        try await start(host, fixture)
        fixture.server.browserState("paused", generation: 4)
        host.selectMicrophoneFromUserClick(second)
        try await waitUntil { !host.sourceChangePending }
        XCTAssertEqual(fixture.server.sourceBodies.count, 1, "Stale source intent must not rebase onto newer authority")
        XCTAssertEqual(fixture.device.starts, 1)
        XCTAssertEqual(host.phase, .paused)
        XCTAssertTrue(host.sourceSelectionError?.contains("recording changed") == true)
    }

    func testUnlinkAndLeaseExpiryCancelPendingSourceIntent() async throws {
        for expire in [false, true] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let host = fixture.host(snapshot: snapshot()) { false }
            defer { host.shutdown(reason: "Synthetic source teardown test") }
            try await start(host, fixture)
            fixture.server.configureSource(unavailable: true)
            host.selectMicrophoneFromUserClick(second)
            try await waitUntil { !host.sourceChangeInFlight }
            if expire { fixture.monotonic += 31_000_000_000; host.service() }
            else { XCTAssertTrue(host.beforeConnectionEvent(.userLogout)) }
            XCTAssertFalse(host.sourceChangePending, "Unlink and lease expiry must cancel the source intent")
            XCTAssertEqual(host.phase, .stopped)
            XCTAssertEqual(fixture.device.starts, 1)
            let count = fixture.server.sourceBodies.count
            host.selectMicrophoneFromUserClick(second)
            XCTAssertEqual(fixture.server.sourceBodies.count, count)
        }
    }

    private var computerOnly: MeetingCaptureChoice {
        .init(mode: "computer-audio", microphone: nil, outputSourceId: "output", appProcessTreeId: nil,
            scope: .init(kind: "process-exclusion", endpointId: nil, excludedProcessTreeIds: ["1:1:0"]))
    }

    private func snapshot(microphones: Bool = true) -> MeetingInventorySnapshot {
        let moss = MeetingProcessIdentity(pid: 1, parentPID: 0, startedSeconds: 1, startedMicroseconds: 0,
            executable: "/Applications/Moss.app/Contents/MacOS/Moss")
        let inventory = MeetingCaptureInventory(microphones: microphones ? [
            .init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic"),
            .init(deviceId: second.deviceId, sourceId: second.sourceId, label: "Second synthetic mic")
        ] : [], applications: [], computerAudio: .init(available: true, excludedProcessTreeIds: [moss.key]),
            microphonePermission: .unknown, systemAudioPermission: .unknown)
        return .init(wire: inventory, microphones: microphones ? ["mic-uid": 42, second.deviceId: 43] : [:],
            applications: [:], processes: [moss], audioObjects: [1: 101], excluded: [moss])
    }

    private func start(_ host: MeetingCaptureHost, _ fixture: Fixture) async throws {
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential,
            origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(condition(), "Synthetic source test did not reach expected state")
    }
}
