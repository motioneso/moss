import XCTest
@testable import TrailMarker

final class MeetingSourceRecoveryTests: XCTestCase {
    private let origin: UInt64 = 10_000_000_000
    private let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true, meetingDeviceAuthorized: true)
    private final class Device: MeetingAudioCapturing {
        var receiver: MeetingAudioReceiving?
        var old: [MeetingAudioReceiving] = []
        var starts = 0
        var stops = 0
        var failCleanup = false
        var onStop: (() -> Void)?
        var onStart: ((MeetingAudioReceiving) -> Void)?
        func start(into receiver: MeetingAudioReceiving) throws {
            self.receiver = receiver; old.append(receiver); starts += 1; onStart?(receiver)
        }
        func stop() throws { stops += 1; onStop?(); if failCleanup { throw MeetingAudioFailure.cleanupFailed } }
    }

    func testEpisodeBudgetBoundsRetriesAndRequiresSustainedHealth() {
        var budget = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 30_000_000_000,
            faultedSources: [.microphone])
        XCTAssertEqual(budget.deadline, origin + 12_000_000_000)
        XCTAssertTrue(budget.beginAttempt(at: origin))
        XCTAssertTrue(budget.beginAttempt(at: origin + 1))
        XCTAssertTrue(budget.beginAttempt(at: origin + 2))
        XCTAssertFalse(budget.beginAttempt(at: origin + 3), "Recovery attempts must share a bounded episode")
        XCTAssertFalse(budget.observeCallbacks([.microphone: 4], at: origin + 4))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 4], at: origin + 2_000_000_004))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 5], at: origin + 3_000_000_000))
        XCTAssertTrue(budget.observeCallbacks([.microphone: 6], at: origin + 5_000_000_000))
        XCTAssertEqual(budget.remaining(at: budget.deadline), 0)
        var short = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 1, faultedSources: [.microphone])
        XCTAssertFalse(short.beginAttempt(at: origin + 1), "Lease expiry cannot be extended by recovery")
    }

    func testCompletedRecoveryCooldownRequiresRecordingAcknowledgmentAndThirtySeconds() {
        var budget = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 120_000_000_000,
            faultedSources: [.microphone])
        XCTAssertTrue(budget.beginAttempt(at: origin))
        XCTAssertFalse(budget.completedCooldownElapsed(at: origin + 120_000_000_000),
            "Control, acquisition and unacknowledged recording cannot start the completed cooldown")
        let acknowledgedAt = origin + 2_000_000_000
        budget.acknowledgeRecording(at: acknowledgedAt)
        XCTAssertFalse(budget.completedCooldownElapsed(at: acknowledgedAt - 1))
        XCTAssertFalse(budget.completedCooldownElapsed(at: acknowledgedAt + 29_999_999_999))
        XCTAssertTrue(budget.completedCooldownElapsed(at: acknowledgedAt + 30_000_000_000),
            "An acknowledged quiet recovery must retire its local budget at thirty seconds")
        XCTAssertEqual(budget.deadline, origin + 12_000_000_000)
        XCTAssertEqual(budget.attempts, 1)
    }

    func testImmediateRecurringRecoveryRetainsDeadlineAndCancelsCompletedCooldown() {
        var budget = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 120_000_000_000,
            faultedSources: [.microphone])
        XCTAssertTrue(budget.beginAttempt(at: origin))
        budget.acknowledgeRecording(at: origin + 1)
        XCTAssertFalse(budget.completedCooldownElapsed(at: origin + 2))
        XCTAssertTrue(budget.beginAttempt(at: origin + 2))
        XCTAssertEqual(budget.attempts, 2)
        XCTAssertEqual(budget.deadline, origin + 12_000_000_000,
            "An immediate recurring fault must retain the original episode deadline")
        XCTAssertFalse(budget.completedCooldownElapsed(at: origin + 120_000_000_000),
            "A fresh in-progress attempt must never inherit an earlier completed cooldown")
        XCTAssertFalse(budget.beginAttempt(at: origin + 12_000_000_000))
    }

    func testHealthyRecoveredMicrophoneDoesNotWaitForCallbackFreeOutput() {
        var budget = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 30_000_000_000,
            faultedSources: [.microphone])
        XCTAssertTrue(budget.beginAttempt(at: origin))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 0], at: origin))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 2, .output: 0], at: origin + 1_000_000_000))
        XCTAssertTrue(budget.observeCallbacks([.microphone: 3, .output: 0], at: origin + 3_000_000_000),
            "An unchanged callback-free peer must not prevent sustained recovery health")
    }

    func testStalledFaultedSourceAndEmptyEvidenceNeverFinishEpisode() {
        let cases: [Set<MeetingAudioSource>] = [[.microphone], []]
        for faulted in cases {
            var budget = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 30_000_000_000,
                faultedSources: faulted)
            XCTAssertTrue(budget.beginAttempt(at: origin))
            XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 1], at: origin))
            XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 2], at: origin + 1_000_000_000))
            XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 3], at: origin + 3_000_000_000))
        }
    }

    func testAlternatingFaultsUnionHealthWithoutRenewingAttemptOrDeadline() {
        var budget = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 30_000_000_000,
            faultedSources: [.microphone])
        XCTAssertTrue(budget.beginAttempt(at: origin))
        _ = budget.observeCallbacks([.microphone: 1, .output: 0], at: origin)
        _ = budget.observeCallbacks([.microphone: 2, .output: 0], at: origin + 1_000_000_000)
        budget.requireHealth(from: [.output])
        XCTAssertTrue(budget.beginAttempt(at: origin + 2_000_000_000))
        XCTAssertEqual(budget.attempts, 2)
        XCTAssertEqual(budget.deadline, origin + 12_000_000_000)
        XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 1], at: origin + 2_000_000_000))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 2], at: origin + 3_000_000_000))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 3], at: origin + 5_000_000_000))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 2, .output: 4], at: origin + 6_000_000_000))
        XCTAssertTrue(budget.observeCallbacks([.microphone: 3, .output: 5], at: origin + 8_000_000_000))
    }

    func testBothFaultedSourcesMustBothDemonstrateSustainedHealth() {
        var budget = MeetingSourceRecoveryBudget(now: origin, leaseDeadline: origin + 30_000_000_000,
            faultedSources: [.microphone, .output])
        XCTAssertTrue(budget.beginAttempt(at: origin))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 1, .output: 0], at: origin))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 2, .output: 0], at: origin + 1_000_000_000))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 3, .output: 0], at: origin + 3_000_000_000))
        XCTAssertFalse(budget.observeCallbacks([.microphone: 4, .output: 1], at: origin + 4_000_000_000))
        XCTAssertTrue(budget.observeCallbacks([.microphone: 5, .output: 2], at: origin + 6_000_000_000))
    }

    func testFaultedSourceEvidenceIncludesPeerReconfigurationDuringTeardown() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([100]))
        try runtime.prepare(selection: selection, readiness: ready, at: origin)
        try runtime.start(readiness: ready, at: origin)
        microphone.receiver?.fail(.sourceReconfigured)
        output.onStop = { output.receiver?.fail(.sourceReconfigured) }
        _ = try runtime.service(at: origin + 1)
        XCTAssertEqual(runtime.recoveryFaultSources, [.microphone, .output])
        XCTAssertTrue(runtime.canRecoverSources)
        output.onStop = nil
        try runtime.terminate(at: origin + 2)
    }

    func testRecoveryGapUsesMappedTailWithoutHostJitterOrWireOverlap() throws {
        for jitter in [Int64(-10_000), 10_000] {
            let buffer = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: origin)
            buffer.receive(sampleTime: 0, hostTimeNanoseconds: origin, sampleRate: 48000,
                frameCount: 1, sampleAt: { _ in 0.25 })
            buffer.receive(sampleTime: 1, hostTimeNanoseconds: UInt64(Int64(origin + 20_834) + jitter), sampleRate: 48000,
                frameCount: 1, sampleAt: { _ in 0.25 })
            let packet = try XCTUnwrap(buffer.peekChunk(targetDurationNanoseconds: 1_000_000, cutoffNanoseconds: nil, allowPartial: true)?.packet)
            XCTAssertEqual(buffer.recoveryBoundaryNanoseconds, packet.endNanoseconds)
            var timeline = MeetingCaptureTimeline()
            timeline.originNanoseconds = origin
            let choice = MeetingCaptureChoice(mode: "microphone-only", microphone: .init(deviceId: "mic", sourceId: "mic"),
                outputSourceId: nil, appProcessTreeId: nil, scope: nil)
            timeline.epochs[1] = .init(remoteEpoch: 1, generation: 1, choice: choice, startNanoseconds: origin)
            let gap = try XCTUnwrap(timeline.map(.init(source: .microphone, epoch: 1,
                startNanoseconds: buffer.recoveryBoundaryNanoseconds, endNanoseconds: origin + 2_000_000,
                reason: .captureFailure(.sourceReconfigured))))
            let audio = try XCTUnwrap(timeline.audioBody(for: packet, meetingId: "meeting", grantId: "grant"))
            XCTAssertEqual(gap.startMs, audio.endMs, "Recovery gap must never overlap the mapped or quantized audio tail")
        }
    }

    func testSoftFaultClosesPairAndRequiresFreshEpochWithSameSelection() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([100]))
        try runtime.prepare(selection: selection, readiness: ready, at: origin)
        try runtime.start(readiness: ready, at: origin)
        let old = try XCTUnwrap(microphone.receiver)
        old.fail(.sourceReconfigured)
        _ = try runtime.service(at: origin + 1_000_000_000)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        XCTAssertEqual(microphone.stops, 1)
        XCTAssertEqual(output.stops, 1)
        XCTAssertTrue(runtime.canRecoverSources)
        XCTAssertThrowsError(try runtime.resume(selection: .init(microphoneDeviceID: 43, output: selection.output),
            readiness: ready, permitRetainedAudio: true, at: origin + 1_000_000_000, recoveringSameSources: true))
        try runtime.resume(selection: selection, readiness: ready, permitRetainedAudio: true,
            at: origin + 1_000_000_000, recoveringSameSources: true)
        XCTAssertEqual(runtime.snapshot.epoch, 2)
        XCTAssertEqual(runtime.snapshot.originNanoseconds, origin)
        old.receive(hostTimeNanoseconds: origin + 1_100_000_000, sampleRate: 8000, frameCount: 8,
            sampleAt: { _ in XCTFail("A closed callback may not publish into the replacement ring"); return 1 })
        XCTAssertEqual(runtime.audioDiagnostics[.microphone]?.acceptedCallbacks, 0)
    }

    func testHardFailureOnEitherClosedSourceWinsAfterSoftFault() throws {
        for failure in [MeetingAudioFailure.invalidSelection, .invalidTimestamp, .bufferFull, .leaseExpired] {
            let microphone = Device(), output = Device()
            let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
            let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([100]))
            try runtime.prepare(selection: selection, readiness: ready, at: origin)
            try runtime.start(readiness: ready, at: origin)
            microphone.receiver?.fail(.sourceReconfigured)
            _ = try runtime.service(at: origin + 1)
            output.receiver?.fail(failure)
            XCTAssertFalse(runtime.canRecoverSources, "A later hard fault must invalidate retained evidence")
            XCTAssertThrowsError(try runtime.resume(selection: selection, readiness: ready,
                permitRetainedAudio: true, at: origin + 2, recoveringSameSources: true))
            XCTAssertEqual(microphone.starts, 1)
        }
    }

    func testConcurrentAndTeardownScopeFaultDiscardUncertainRetainedTail() throws {
        for duringTeardown in [false, true] {
            let microphone = Device(), output = Device()
            let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
            let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([100]))
            try runtime.prepare(selection: selection, readiness: ready, at: origin)
            try runtime.start(readiness: ready, at: origin)
            let oldOutput = try XCTUnwrap(output.receiver as? MeetingAudioBuffer)
            oldOutput.receive(hostTimeNanoseconds: origin, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.25 })
            microphone.receiver?.fail(.sourceReconfigured)
            if duringTeardown { output.onStop = { oldOutput.fail(.invalidSelection) } }
            else { oldOutput.fail(.invalidSelection) }
            _ = try runtime.service(at: origin + 200_000_000)
            XCTAssertFalse(runtime.canRecoverSources)
            XCTAssertEqual(oldOutput.diagnostics.bufferedSamples, 0,
                "Hard scope failure must discard even when a soft fault won the first race")
            output.onStop = nil
        }
    }

    func testHardOldEvidenceDuringAcquisitionDiscardsUnmappedReplacement() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: nil)
        try runtime.prepare(selection: selection, readiness: ready, at: origin)
        try runtime.start(readiness: ready, at: origin)
        let old = try XCTUnwrap(device.receiver as? MeetingAudioBuffer)
        old.fail(.sourceReconfigured)
        _ = try runtime.service(at: origin + 1_000_000_000)
        var unconfirmed: MeetingAudioBuffer?
        device.onStart = { receiver in
            unconfirmed = receiver as? MeetingAudioBuffer
            receiver.receive(hostTimeNanoseconds: self.origin + 1_000_000_000, sampleRate: 8000,
                frameCount: 800, sampleAt: { _ in 0.5 })
            old.fail(.invalidSelection)
        }
        XCTAssertThrowsError(try runtime.resume(selection: selection, readiness: ready,
            permitRetainedAudio: true, at: origin + 1_000_000_000, recoveringSameSources: true))
        XCTAssertEqual(unconfirmed?.diagnostics.bufferedSamples, 0)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        device.onStart = nil
        try runtime.resume(selection: selection, readiness: ready, permitRetainedAudio: true, at: origin + 2_000_000_000)
        XCTAssertEqual(runtime.snapshot.epoch, 3)
        device.receiver?.receive(hostTimeNanoseconds: origin + 2_000_000_000, sampleRate: 8000,
            frameCount: 800, sampleAt: { _ in 0.75 })
        XCTAssertTrue(try runtime.dispatchNext(at: origin + 2_100_000_000) { packet in
            XCTAssertEqual(packet.epoch, 3)
            XCTAssertEqual(packet.samples, [Float](repeating: 0.75, count: 800))
        }, "A retired hard microphone tail must not block explicit Resume")
    }

    func testCleanupFailureNeverAllowsRecovery() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try runtime.prepare(selection: .init(microphoneDeviceID: 42, output: nil), readiness: ready, at: origin)
        try runtime.start(readiness: ready, at: origin)
        device.failCleanup = true
        device.receiver?.fail(.sourceReconfigured)
        XCTAssertThrowsError(try runtime.service(at: origin + 1))
        XCTAssertFalse(runtime.canRecoverSources)
        XCTAssertEqual(device.starts, 1)
        device.failCleanup = false
        try runtime.terminate(at: origin + 2)
    }

    func testResumeAfterUnknownReceiptExpiryKeepsFreshCaptureRecording() throws {
        for resumeSeconds in [UInt64(31), 61] {
        for offered in [false, true] {
            let device = Device()
            let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
            let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: nil)
            try runtime.prepare(selection: selection, readiness: ready, at: origin)
            try runtime.start(readiness: ready, at: origin)
            device.receiver?.receive(hostTimeNanoseconds: origin, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.25 })
            var oldPacket: MeetingAudioPacket?
            if offered {
                XCTAssertTrue(try runtime.dispatchNext(at: origin + 100_000_000) { oldPacket = $0 })
            }
            try runtime.pause(at: origin + 200_000_000)
            let later = origin + 61_000_000_000
            try runtime.resume(selection: selection, readiness: ready, permitRetainedAudio: true, at: origin + resumeSeconds * 1_000_000_000)
            let gaps = try runtime.service(at: later)
            XCTAssertTrue(gaps.contains { $0.reason == .expired })
            XCTAssertEqual(runtime.snapshot.state, .recording)
            if let oldPacket {
                runtime.completeSend(source: oldPacket.source, epoch: oldPacket.epoch,
                    sequence: oldPacket.sequence, received: true)
            }
            device.receiver?.receive(hostTimeNanoseconds: later, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.75 })
            XCTAssertTrue(try runtime.dispatchNext(at: later + 100_000_000) { packet in
                XCTAssertEqual(packet.epoch, 2)
                XCTAssertEqual(packet.sequence, 0)
                XCTAssertEqual(packet.samples, [Float](repeating: 0.75, count: 800))
            })
            XCTAssertEqual(runtime.snapshot.state, .recording, "Old expiry and late receipts cannot pause a new stream")
        }
        }
    }
}

@MainActor
final class MeetingSourceRecoveryHostTests: XCTestCase {
    private typealias Fixture = MeetingHostLifecycleTests.Fixture
    private func waitUntil(timeout: TimeInterval = 6, _ condition: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(condition(), "Condition did not become true")
    }

    func testSameSourceRecoveryUsesExplicitControlAndWaitsForRecordingStatus() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.validateGapBoundsStrictly()
        fixture.server.holdRecordingStatusReplies(forGeneration: 2)
        let host = fixture.host { XCTFail("Recovery must not prompt for permissions"); return false }
        defer { host.shutdown(reason: "Recovery test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.monotonic += 1_000_000_000
        fixture.server.advanceElapsed(to: 2000)
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        XCTAssertEqual(host.phase, .recovering)
        XCTAssertTrue(host.canStop)
        try await waitUntil { fixture.device.starts == 2 && host.phase == .recording }
        XCTAssertEqual(fixture.server.captureEpoch, 2)
        XCTAssertTrue(fixture.server.resumeKeys.isEmpty)
        let body = try XCTUnwrap(fixture.server.sourceBodies.first)
        let control = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(control["command"] as? String, "recover-sources")
        let newReceiver = try XCTUnwrap(fixture.device.receiver)
        for index in 0..<5 {
            newReceiver.receive(sampleTime: Double(index * 8000),
                hostTimeNanoseconds: fixture.monotonic + UInt64(index) * 1_000_000_000,
                sampleRate: 8000, frameCount: 8000, sampleAt: { _ in 0.5 })
        }
        fixture.monotonic += 5_000_000_000
        fixture.server.advanceElapsed(to: 7000)
        host.service()
        try await waitUntil { fixture.server.heldRecordingStatusCount > 0 }
        host.service()
        XCTAssertEqual(fixture.server.audioCount, 0, "Replacement PCM must await exact recording acknowledgment")
        fixture.server.releaseRecordingStatusReplies()
        try await waitUntil { fixture.server.audioCount == 1 }
        let audio = try XCTUnwrap(fixture.server.audioBodies.first)
        XCTAssertEqual(audio["epoch"] as? Int, 2)
        XCTAssertEqual(audio["sequence"] as? Int, 0)
        XCTAssertEqual(host.phase, .recording)
        XCTAssertNil(host.interruptionWarning)
        XCTAssertEqual(host.synchronizedOriginNanoseconds, 9_000_000_000)
    }

    func testPauseCancelsRecoveryAndNoLaterRetryReopensHardware() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.configureSource(unavailable: true)
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Cancelled recovery test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.monotonic += 1_000_000_000
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        XCTAssertEqual(host.phase, .recovering)
        host.pauseFromUserClick()
        XCTAssertEqual(host.phase, .paused)
        fixture.server.configureSource()
        fixture.monotonic += 2_000_000_000
        host.service()
        try await waitUntil { fixture.server.lastObservation?.phase == "paused" }
        XCTAssertEqual(fixture.device.starts, 1)
    }

    func testLostRecoveryReplyReusesOneIdentityAndOneEpoch() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.configureSource(loseReplies: 1)
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Lost reply test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        try await waitUntil { fixture.server.sourceBodies.count == 1 }
        fixture.monotonic += 1_000_000_000
        host.service()
        try await waitUntil { fixture.server.sourceBodies.count == 2 && fixture.device.starts == 2 }
        XCTAssertEqual(fixture.server.sourceBodies[0], fixture.server.sourceBodies[1])
        XCTAssertEqual(fixture.server.captureEpoch, 2)
        XCTAssertTrue(fixture.server.resumeKeys.isEmpty)
    }

    func testLateSuccessfulRecoveryCannotOverridePauseStopRevocationOrSourceLoss() async throws {
        for action in ["pause", "stop", "revoke", "permission"] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            fixture.server.holdRecoveryReplies()
            let host = fixture.host { false }
            defer { host.shutdown(reason: "Recovery race test") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            fixture.device.receiver?.fail(.sourceReconfigured)
            host.service()
            try await waitUntil { fixture.server.heldRecoveryReplyCount == 1 }
            switch action {
            case "pause": host.pauseFromUserClick()
            case "stop": host.stopFromUserClick()
            case "revoke": fixture.server.browserState("revoked", generation: 3)
            default: fixture.permission = .denied; host.service()
            }
            fixture.server.releaseRecoveryReplies()
            try await waitUntil { host.phase != .recovering }
            try await Task.sleep(nanoseconds: 2_200_000_000)
            host.service()
            XCTAssertNotEqual(host.phase, .recording, "Late recovery must not override \(action)")
            XCTAssertEqual(fixture.device.starts, 1)
            XCTAssertEqual(fixture.server.audioCount, 0)
        }
    }

    func testPostAcquisitionInventoryFailureDiscardsUnmappedRingAndExplicitResumeWorks() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.configureSource()
        let wire = MeetingCaptureInventory(microphones: [.init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic")],
            applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
            microphonePermission: .granted, systemAudioPermission: .unknown)
        let snapshot = MeetingInventorySnapshot(wire: wire, microphones: ["mic-uid": 42], applications: [:],
            processes: [], audioObjects: [:], excluded: [])
        var failedPostAcquisition = false
        var readUnconfirmedPCM = false
        let host = fixture.host(readInventory: {
            if fixture.device.starts == 2, !failedPostAcquisition {
                failedPostAcquisition = true
                fixture.device.receiver?.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000,
                    frameCount: 800, sampleAt: { _ in readUnconfirmedPCM = true; return 0.8 })
                throw MeetingHostError.sourceChanged
            }
            return snapshot
        }) { false }
        defer { host.shutdown(reason: "Post-acquisition failure test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        try await waitUntil { failedPostAcquisition && host.canResumeFromUserClick }
        XCTAssertFalse(readUnconfirmedPCM, "Unconfirmed acquisition must never retain an unmapped ring")
        XCTAssertFalse(fixture.runtime.hasPendingAcquisition)
        XCTAssertEqual(fixture.runtime.snapshot.epoch, 1, "Rejected staged acquisition must not advance the native timeline")
        host.resumeFromUserClick()
        try await waitUntil { fixture.device.starts == 3 && host.phase == .recording }
        XCTAssertNil(host.interruptionWarning)
        // Server epoch 2 existed during recovery, but its staged native epoch was never adopted.
        // Explicit Resume therefore maps local epoch 2 to the independently advanced server epoch 3.
        XCTAssertEqual(fixture.runtime.snapshot.epoch, 2)
        XCTAssertEqual(fixture.server.captureEpoch, 3)
    }

    func testAcknowledgedQuietRecoveryCoolsDownOnlyAtThirtySeconds() async throws {
        let cases: [(UInt64, Bool)] = [(29_999_999_999, false), (30_000_000_000, false), (30_000_000_000, true)]
        for (elapsed, hardFailure) in cases {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            fixture.server.configureSource()
            let host = fixture.host { false }
            defer { host.shutdown(reason: "Quiet recovery cooldown test") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
                credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            fixture.device.receiver?.fail(.sourceReconfigured)
            host.service()
            try await waitUntil { fixture.device.starts == 2 && host.phase == .recording && !host.sourceRecoveryPending }
            let completedAt = fixture.monotonic
            XCTAssertEqual(fixture.runtime.audioDiagnostics[.microphone]?.acceptedCallbacks, 0)
            // Renew genuine recording authorization independently of the expired 12s episode.
            fixture.monotonic = completedAt + 15_000_000_000
            fixture.server.advanceElapsed(to: 16000)
            host.service()
            try await waitUntil { host.remote?.elapsedMs == 16000 }
            XCTAssertEqual(host.phase, .recording)
            fixture.monotonic = completedAt + elapsed
            fixture.server.advanceElapsed(to: 1000 + elapsed / 1_000_000)
            fixture.device.receiver?.fail(hardFailure ? .invalidSelection : .sourceReconfigured)
            host.service()
            if hardFailure {
                XCTAssertEqual(host.phase, .paused)
                XCTAssertEqual(host.message, MeetingHostError.sourceChanged.message)
                XCTAssertEqual(fixture.device.starts, 2,
                    "Completed cooldown must not erase hard source evidence or reopen an unauthorized source")
                XCTAssertEqual(fixture.server.sourceBodies.count, 1)
            } else if elapsed < 30_000_000_000 {
                XCTAssertEqual(host.phase, .paused, "An immediate recurring fault must not reset an expired episode")
                XCTAssertEqual(host.message, MeetingHostError.recoveryExhausted.message)
                XCTAssertEqual(fixture.server.sourceBodies.count, 1)
                try await waitUntil { host.canResumeFromUserClick }
            } else {
                try await waitUntil { fixture.device.starts == 3 && host.phase == .recording && !host.sourceRecoveryPending }
                XCTAssertEqual(fixture.server.sourceBodies.count, 2,
                    "A later fault after completed cooldown must get a new local recovery episode")
                XCTAssertEqual(fixture.server.captureEpoch, 3)
                XCTAssertNil(host.interruptionWarning)
            }
        }
    }

    func testRecoveryDeadlineFailsVisiblyEvenWhenPillWasHidden() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.configureSource(unavailable: true)
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Recovery deadline test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        host.hideRecordingPill()
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        fixture.monotonic += 12_000_000_000
        host.service()
        XCTAssertEqual(host.phase, .paused)
        XCTAssertEqual(host.message, "Audio recovery could not finish. Capture is paused. Press Resume in Moss to try again.",
            "Recovery exhaustion must explain resumable audio recovery rather than a server outage")
        XCTAssertFalse(host.message.contains("unreachable"))
        XCTAssertNil(host.connectivityMessage)
        XCTAssertNotNil(host.interruptionWarning)
        XCTAssertTrue(host.recordingPresentation.showsPill)
        XCTAssertEqual(fixture.device.starts, 1)
    }
}
