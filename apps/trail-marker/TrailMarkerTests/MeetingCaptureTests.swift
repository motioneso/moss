import XCTest
@testable import TrailMarker

final class MeetingCaptureTests: XCTestCase {
    private let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true,
                                              noticeAcknowledged: true, meetingDeviceAuthorized: true)
    private let mic = MeetingNativeSelection(microphoneDeviceID: 42, output: nil)
    private final class Device: MeetingAudioCapturing {
        var receiver: MeetingAudioReceiving?
        var starts = 0
        var stops = 0
        var failStart = false
        var failStop = false
        func start(into receiver: MeetingAudioReceiving) throws {
            self.receiver = receiver
            starts += 1
            if failStart { throw MeetingAudioFailure.invalidSelection }
        }
        func stop() throws {
            stops += 1
            if failStop { throw MeetingAudioFailure.cleanupFailed }
        }
        func emit(at: UInt64, count: Int = 8) {
            receiver?.receive(hostTimeNanoseconds: at, sampleRate: 8000, frameCount: count, sampleAt: { _ in 0.25 })
        }
    }
    private func start(_ runtime: MeetingCaptureRuntime, selection: MeetingNativeSelection? = nil) throws {
        try runtime.prepare(selection: selection ?? mic, readiness: ready, at: 0)
        try runtime.start(readiness: ready, at: 0)
    }
    func testConstructionAndPreflightDoNotActivateDevices() throws {
        let device = Device()
        var factories = 0
        let runtime = MeetingCaptureRuntime { _ in factories += 1; return [.microphone: device] }
        try runtime.prepare(selection: mic, readiness: ready, at: 0)
        XCTAssertEqual(factories, 0)
        XCTAssertEqual(device.starts, 0)
        XCTAssertEqual(runtime.snapshot.state, .ready)
    }
    func testMicrophoneOnlyNeverStartsOutputAndDuplicateStartFails() throws {
        let microphone = Device()
        let runtime = MeetingCaptureRuntime { selection in
            XCTAssertNil(selection.output)
            return [.microphone: microphone]
        }
        try start(runtime)
        XCTAssertEqual(microphone.starts, 1)
        XCTAssertThrowsError(try runtime.start(readiness: ready, at: 0))
        try runtime.stop(at: 1)
    }
    func testBothSourcesRollbackWhenOutputCannotStart() throws {
        let microphone = Device(), output = Device()
        output.failStart = true
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: .selectedProcesses([7]))
        XCTAssertThrowsError(try start(runtime, selection: selection))
        XCTAssertEqual(microphone.stops, 1)
        XCTAssertEqual(output.stops, 1)
        XCTAssertEqual(runtime.snapshot.state, .failed)
        XCTAssertFalse(try runtime.dispatchNext(at: 10) { _ in XCTFail("No failed-start audio") })
    }
    func testPauseBlocksQueuedAudioAndRejectsLateCallbacks() throws {
        let microphone = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone] }
        try start(runtime)
        microphone.emit(at: 0)
        try runtime.pause(at: 1_000_000)
        microphone.emit(at: 2_000_000)
        XCTAssertFalse(try runtime.dispatchNext(at: 3_000_000) { _ in XCTFail("Paused") })
        try runtime.stop(at: 3_000_000)
        var sent: [MeetingAudioPacket] = []
        XCTAssertTrue(try runtime.dispatchNext(at: 3_000_000) { sent.append($0) })
        XCTAssertEqual(sent.map(\.sequence), [0])
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: true)
        XCTAssertFalse(try runtime.dispatchNext(at: 3_000_000) { _ in XCTFail("Late audio") })
    }
    func testResumeExplicitlyControlsRetainedAudioAndCreatesNewEpoch() throws {
        let first = Device(), second = Device()
        var starts = 0
        let runtime = MeetingCaptureRuntime { _ in starts += 1; return [.microphone: starts == 1 ? first : second] }
        try start(runtime)
        first.emit(at: 0)
        try runtime.pause(at: 1_000_000)
        try runtime.resume(selection: mic, readiness: ready, permitRetainedAudio: false, at: 2_000_000)
        XCTAssertEqual(runtime.snapshot.epoch, 2)
        XCTAssertFalse(try runtime.dispatchNext(at: 3_000_000) { _ in XCTFail("Retained audio not permitted") })
        second.emit(at: 2_000_000)
        var sent: MeetingAudioPacket?
        XCTAssertTrue(try runtime.dispatchNext(at: 3_000_000) { sent = $0 })
        XCTAssertEqual(sent?.epoch, 2)
        try runtime.stop(at: 3_000_000)
    }
    func testStopTrimsFinalPartialBlockAndCannotExtendDeadline() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        try runtime.stop(at: 500_000, finalizationNanoseconds: 1_000_000)
        try runtime.stop(at: 10_000_000, finalizationNanoseconds: 60_000_000_000)
        XCTAssertEqual(runtime.snapshot.stopCutoffNanoseconds, 500_000)
        XCTAssertEqual(runtime.snapshot.finalizationDeadlineNanoseconds, 1_500_000)
        var packet: MeetingAudioPacket?
        XCTAssertTrue(try runtime.dispatchNext(at: 500_000) { packet = $0 })
        XCTAssertEqual(packet?.samples.count, 4)
        XCTAssertThrowsError(try runtime.finish(at: 500_000))
        XCTAssertFalse(try runtime.dispatchNext(at: 1_500_000) { _ in XCTFail("Deadline reached") })
        XCTAssertEqual(runtime.snapshot.state, .finished)
        XCTAssertTrue(runtime.snapshot.finalizationExpired)
        XCTAssertThrowsError(try runtime.resume(selection: mic, readiness: ready, permitRetainedAudio: true, at: 2_000_000))
    }
    func testReceiptRetriesKeepIdentityAndFinishedDrainIsDistinct() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        try runtime.stop(at: 1_000_000)
        var packets: [MeetingAudioPacket] = []
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { packets.append($0) })
        XCTAssertFalse(try runtime.dispatchNext(at: 1_000_000) { _ in XCTFail("Already in flight") })
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: false)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { packets.append($0) })
        XCTAssertEqual(packets[0], packets[1])
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: true)
        try runtime.finish(at: 1_000_000)
        XCTAssertFalse(runtime.snapshot.finalizationExpired)
    }
    func testFailedTeardownStillAttemptsBothSourcesAndCanRetryStop() throws {
        let microphone = Device(), output = Device()
        microphone.failStop = true
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([1])))
        XCTAssertThrowsError(try runtime.stop(at: 0))
        XCTAssertEqual(output.stops, 1)
        XCTAssertEqual(microphone.stops, 1)
        XCTAssertThrowsError(try runtime.finish(at: 60_000_000_000))
        microphone.failStop = false
        try runtime.stop(at: 0)
        XCTAssertEqual(microphone.stops, 2)
        XCTAssertEqual(output.stops, 1)
    }
    func testFaultServicePausesBothSourcesAndReportsGap() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .selectedProcesses([8])))
        output.receiver?.fail(.invalidFormat)
        let gaps = try runtime.service(at: 10)
        XCTAssertEqual(gaps.first?.reason, .captureFailure(.invalidFormat))
        XCTAssertEqual(runtime.snapshot.state, .paused)
        XCTAssertEqual(microphone.stops, 1)
        XCTAssertEqual(output.stops, 1)
        XCTAssertTrue(try runtime.service(at: 20).isEmpty)
        XCTAssertEqual(microphone.starts, 1)
    }
    func testClockCannotMoveBehindAnAlreadyInitiatedSend() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        XCTAssertTrue(try runtime.dispatchNext(at: 2_000_000) { _ in })
        XCTAssertThrowsError(try runtime.stop(at: 500_000))
        try runtime.stop(at: 2_000_000)
    }
    func testReadinessScopeAndDeadlineFailuresDoNotOpenDevices() throws {
        var calls = 0
        let runtime = MeetingCaptureRuntime { _ in calls += 1; return [:] }
        let denied = MeetingNativeReadiness(permissionsGranted: false, processingReady: true,
                                           noticeAcknowledged: true, meetingDeviceAuthorized: true)
        XCTAssertThrowsError(try runtime.prepare(selection: mic, readiness: denied, at: 0))
        XCTAssertThrowsError(try runtime.prepare(selection: MeetingNativeSelection(microphoneDeviceID: 0, output: nil), readiness: ready, at: 0))
        XCTAssertThrowsError(try runtime.prepare(selection: MeetingNativeSelection(microphoneDeviceID: 1, output: .selectedProcesses([])), readiness: ready, at: 0))
        XCTAssertEqual(calls, 0)
        var machine = MeetingCaptureMachine()
        try machine.prepare(selection: mic, readiness: ready, at: 0)
        try machine.start(readiness: ready, at: 0)
        XCTAssertThrowsError(try machine.stop(at: 1, finalizationNanoseconds: 60_000_000_001))
        XCTAssertThrowsError(try machine.stop(at: UInt64.max, finalizationNanoseconds: 1))
    }
    func testDefaultDeadlineCannotTurnExpiredUnsentAudioIntoSuccessfulDrain() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        try runtime.stop(at: 1_000_000)
        let gaps = try runtime.service(at: 60_001_000_000)
        XCTAssertEqual(gaps.first?.reason, .expired)
        XCTAssertEqual(runtime.snapshot.state, .finished)
        XCTAssertTrue(runtime.snapshot.finalizationExpired)
    }
    func testRuntimeReleaseClosesAdmissionAndStopsDevices() throws {
        let device = Device()
        var runtime: MeetingCaptureRuntime? = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(try XCTUnwrap(runtime))
        device.emit(at: 0)
        runtime = nil
        XCTAssertEqual(device.stops, 1)
        device.emit(at: 2_000_000)
        XCTAssertNil((device.receiver as? MeetingAudioBuffer)?.peek())
    }

    func testResumeReportsPauseGapEvenWhenNoSamplesWereProduced() throws {
        let runtime = MeetingCaptureRuntime { _ in [.microphone: Device()] }
        try start(runtime)
        try runtime.pause(at: 10)
        try runtime.resume(selection: mic, readiness: ready, permitRetainedAudio: false, at: 20)
        let gaps = try runtime.service(at: 20)
        XCTAssertEqual(gaps, [MeetingAudioGap(source: .microphone, epoch: 1,
            startNanoseconds: 10, endNanoseconds: 20, reason: .paused)])
        try runtime.stop(at: 20)
    }

    func testRealChunkDispatchWaitsThenRetriesIdenticalAudioWithAppendedCallbacks() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        for second in 0..<4 { device.emit(at: UInt64(second) * 1_000_000_000, count: 8000) }
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 4_000_000_000, targetDurationNanoseconds: 5_000_000_000) { _ in XCTFail("Too short") })
        device.emit(at: 4_000_000_000, count: 8000)
        var packets: [MeetingAudioPacket] = []
        XCTAssertTrue(try runtime.dispatchNextChunk(at: 5_000_000_000, targetDurationNanoseconds: 5_000_000_000) { packets.append($0) })
        device.emit(at: 5_000_000_000, count: 8000)
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: false)
        XCTAssertTrue(try runtime.dispatchNextChunk(at: 6_000_000_000, targetDurationNanoseconds: 5_000_000_000) { packets.append($0) })
        XCTAssertEqual(packets[0], packets[1])
        XCTAssertEqual(packets[0].samples.count, 40_000)
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: true)
        try runtime.stop(at: 6_000_000_000)
        XCTAssertTrue(try runtime.dispatchNextChunk(at: 6_000_000_000, targetDurationNanoseconds: 5_000_000_000) { packets.append($0) })
        XCTAssertEqual(packets.last?.sequence, 5)
        XCTAssertEqual(packets.last?.samples.count, 8000)
    }

    func testResumeDeclinesOldAudioPermanentlyIncludingLaterStop() throws {
        let first = Device(), second = Device()
        var factories = 0
        let runtime = MeetingCaptureRuntime { _ in
            factories += 1
            return [.microphone: factories == 1 ? first : second]
        }
        try start(runtime)
        first.emit(at: 0)
        try runtime.pause(at: 1_000_000)
        try runtime.resume(selection: mic, readiness: ready, permitRetainedAudio: false, at: 2_000_000)
        try runtime.stop(at: 3_000_000)
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 3_000_000) { _ in XCTFail("Declined retention") })
        XCTAssertTrue(try runtime.service(at: 3_000_000).contains { $0.reason == .retentionDeclined })
    }

    func testTerminateIsImmediateNoFlushBarrierEvenWhenCleanupFails() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        device.failStop = true
        XCTAssertThrowsError(try runtime.terminate(at: 1_000_000))
        XCTAssertEqual(runtime.snapshot.state, .finished)
        device.emit(at: 1_000_000)
        XCTAssertFalse(try runtime.dispatchNext(at: 2_000_000) { _ in XCTFail("Termination never flushes") })
        XCTAssertThrowsError(try runtime.reset(at: 2_000_000))
        device.failStop = false
        try runtime.terminate(at: 2_000_000)
        try runtime.reset(at: 2_000_000)
        XCTAssertEqual(runtime.snapshot.state, .idle)
    }

    func testResetFencesOldReceiptsAndRequiresExplicitStart() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { _ in })
        try runtime.terminate(at: 1_000_000)
        try runtime.reset(at: 1_000_000)
        XCTAssertThrowsError(try runtime.start(readiness: ready, at: 1_000_000))
        try runtime.prepare(selection: mic, readiness: ready, at: 1_000_000)
        try runtime.start(readiness: ready, at: 1_000_000)
        XCTAssertEqual(runtime.snapshot.epoch, 2)
        device.emit(at: 1_000_000)
        XCTAssertTrue(try runtime.dispatchNext(at: 2_000_000) { _ in })
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: true)
        XCTAssertFalse(try runtime.dispatchNext(at: 2_000_000) { _ in XCTFail("Still in flight") })
        runtime.completeSend(source: .microphone, epoch: 2, sequence: 0, received: false)
        XCTAssertTrue(try runtime.dispatchNext(at: 2_000_000) { _ in })
        try runtime.terminate(at: 2_000_000)
    }

    func testDelayedServerStopUsesEarlierCutoffWithoutReversingControlClock() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        _ = try runtime.service(at: 2_000_000)
        try runtime.stop(at: 3_000_000, captureCutoffNanoseconds: 500_000)
        var sent: MeetingAudioPacket?
        XCTAssertTrue(try runtime.dispatchNextChunk(at: 3_000_000) { sent = $0 })
        XCTAssertEqual(sent?.samples.count, 4)
        XCTAssertEqual(runtime.snapshot.stopCutoffNanoseconds, 500_000)
        try runtime.tightenStopCutoff(to: 1_000_000)
        XCTAssertEqual(runtime.snapshot.stopCutoffNanoseconds, 500_000)
    }

    func testTightenedCutoffNeverRetriesChangedBytesUnderOfferedIdentity() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { _ in })
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: false)
        try runtime.stop(at: 2_000_000)
        try runtime.tightenStopCutoff(to: 500_000)
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 2_000_000) { _ in XCTFail("Changed retry body") })
        XCTAssertTrue(try runtime.service(at: 2_000_000).contains { $0.reason == .cutoffChanged })
    }

    func testUncertainOutputScopeDiscardsQueuedAudioBeforeStopCanFlushIt() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([7])))
        microphone.emit(at: 0)
        output.emit(at: 0)
        output.receiver?.fail(.invalidSelection)
        let gaps = try runtime.service(at: 1_000_000)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        XCTAssertTrue(gaps.contains { $0.reason == .captureFailure(.invalidSelection) })
        try runtime.stop(at: 1_000_000)
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 1_000_000) { _ in XCTFail("Uncertain capture scope") })
    }

    func testChunkCannotBeAdmittedAheadOfAcknowledgedServerClock() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        try runtime.stop(at: 2_000_000)
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 2_000_000, latestEndNanoseconds: 999_999) { _ in
            XCTFail("Server has not acknowledged the packet end")
        })
        XCTAssertTrue(try runtime.dispatchNextChunk(at: 2_000_000, latestEndNanoseconds: 1_000_000) { packet in
            XCTAssertEqual(packet.sequence, 0)
            XCTAssertEqual(packet.samples.count, 8)
        })
    }

    func testOutputDispatchDoesNotWaitForSlowMicrophoneReceipt() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .selectedProcesses([7])))
        microphone.emit(at: 0)
        output.emit(at: 0)
        var first: MeetingAudioPacket?
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { first = $0 })
        XCTAssertEqual(first?.source, .microphone)
        // No microphone receipt has arrived. Output has its own admission and request slot.
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { XCTAssertEqual($0.source, .output) })
        runtime.completeSend(source: .output, epoch: 1, sequence: 0, received: true)
        output.emit(at: 1_000_000)
        XCTAssertTrue(try runtime.dispatchNext(at: 2_000_000) { XCTAssertEqual($0.source, .output) })
        XCTAssertEqual(runtime.snapshot.state, .recording)
        try runtime.stop(at: 2_000_000)
    }

    func testFairSourceSelectionAvoidsStarvationOnSameChunkRetry() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .selectedProcesses([7])))
        microphone.emit(at: 0)
        output.emit(at: 0)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { XCTAssertEqual($0.source, .microphone) })
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: false)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { XCTAssertEqual($0.source, .output) })
        runtime.completeSend(source: .output, epoch: 1, sequence: 0, received: true)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { XCTAssertEqual($0.source, .microphone) })
        try runtime.stop(at: 1_000_000)
    }

    func testTerminalTranscriptionFailureDoesNotPauseEitherDevice() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .selectedProcesses([7])))
        microphone.emit(at: 0)
        output.emit(at: 0)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { _ in })
        let receipt = MeetingCaptureReceipt(requestKey: "chunk", status: "failed", code: "processing_failed", retryable: false)
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: receipt.releasesAudio(matching: "chunk"))
        XCTAssertEqual(runtime.snapshot.state, .recording)
        XCTAssertEqual(microphone.stops, 0)
        XCTAssertEqual(output.stops, 0)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { XCTAssertEqual($0.source, .output) })
        try runtime.stop(at: 1_000_000)
    }

    func testRuntimeOriginatedPauseFreezesReportedCaptureDuration() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        var duration = MeetingRecordingDuration()
        try start(runtime)
        duration.start(at: 0)
        device.receiver?.fail(.bufferFull)
        _ = try runtime.service(at: 1_000_000_000)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        duration.observeCaptureState(runtime.snapshot.state, at: 1_000_000_000)
        XCTAssertEqual(duration.milliseconds(at: 50_000_000_000), 1000)
        try runtime.stop(at: 50_000_000_000)
    }

    func testExplicitResumeRetainsOnlyAudioBeforeAcknowledgedPauseCutoff() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        try runtime.pause(at: 2_000_000, captureCutoffNanoseconds: 500_000)
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 2_000_000) { _ in XCTFail("Pause forbids retained sends") })
        try runtime.resume(selection: mic, readiness: ready, permitRetainedAudio: true, at: 3_000_000)
        XCTAssertTrue(try runtime.dispatchNextChunk(at: 3_000_000) { packet in
            XCTAssertEqual(packet.epoch, 1)
            XCTAssertEqual(packet.samples.count, 4)
            XCTAssertEqual(packet.endNanoseconds, 500_000)
        })
        try runtime.stop(at: 3_000_000)
    }

    func testLaterPauseAcknowledgmentCannotWidenOrRewriteOfferedAudio() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { _ in })
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: false)
        try runtime.pause(at: 2_000_000)
        runtime.tightenPauseCutoff(to: 500_000)
        runtime.tightenPauseCutoff(to: 1_000_000)
        try runtime.resume(selection: mic, readiness: ready, permitRetainedAudio: true, at: 3_000_000)
        XCTAssertFalse(try runtime.dispatchNextChunk(at: 3_000_000) { _ in XCTFail("Never alter an already offered request") })
        XCTAssertTrue(try runtime.service(at: 3_000_000).contains { $0.reason == .cutoffChanged })
        try runtime.stop(at: 3_000_000)
    }

    func testUnknownReceiptExpiryRetiresOnlyItsSourceAndRequiresExplicitResume() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .selectedProcesses([7])))
        microphone.emit(at: 0)
        microphone.emit(at: 1_000_000)
        output.emit(at: 1_000_000)
        XCTAssertTrue(try runtime.dispatchNext(at: 2_000_000) { XCTAssertEqual($0.source, .microphone) })
        let gaps = try runtime.service(at: 60_000_000_000)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        XCTAssertTrue(gaps.contains { $0.source == .microphone && $0.reason == .expired })
        XCTAssertTrue(gaps.contains { $0.source == .microphone && $0.reason == .retentionDeclined })
        XCTAssertFalse(try runtime.dispatchNext(at: 60_000_000_000) { _ in XCTFail("No send without explicit Resume") })
        try runtime.stop(at: 60_000_000_000)
        XCTAssertTrue(try runtime.dispatchNext(at: 60_000_000_000) { XCTAssertEqual($0.source, .output) })
    }

    func testQueuedSourceDoesNotSendDuringScopeRevalidation() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        device.receiver?.setScopeVerificationPending(true)
        XCTAssertFalse(try runtime.dispatchNext(at: 1_000_000) { _ in XCTFail("Unverified source") })
        device.receiver?.setScopeVerificationPending(false)
        XCTAssertTrue(try runtime.dispatchNext(at: 1_000_000) { _ in })
        try runtime.stop(at: 1_000_000)
    }

    func testScopeChangeAfterPacketSelectionBlocksActualRequestInitiation() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        var requested = false
        XCTAssertTrue(try runtime.dispatchNextChunkWithAdmission(at: 1_000_000, targetDurationNanoseconds: 1_000_000) { _, admission in
            admission.setScopeVerificationPending(true)
            XCTAssertFalse(admission.withSendAdmission { requested = true })
            admission.fail(.invalidSelection)
            admission.setScopeVerificationPending(false)
            XCTAssertFalse(admission.withSendAdmission { requested = true })
        })
        XCTAssertFalse(requested)
        _ = try runtime.service(at: 1_000_000)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        try runtime.stop(at: 1_000_000)
    }

    func testClosedPreLimitAudioCanDrainAfterExplicitResume() throws {
        let device = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: device] }
        try start(runtime)
        device.emit(at: 0)
        device.receiver?.fail(.bufferFull)
        _ = try runtime.service(at: 1_000_000)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        try runtime.resume(selection: mic, readiness: ready, permitRetainedAudio: true, at: 2_000_000)
        var initiated = false
        XCTAssertTrue(try runtime.dispatchNextChunkWithAdmission(at: 2_000_000) { packet, admission in
            XCTAssertEqual(packet.epoch, 1)
            XCTAssertTrue(admission.withSendAdmission { initiated = true })
        })
        XCTAssertTrue(initiated)
        try runtime.stop(at: 2_000_000)
    }

    func testOutputHealthWaitsForValidCallbackAndAcceptsLegitimateSilence() throws {
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime { _ in [.microphone: microphone, .output: output] }
        try start(runtime, selection: MeetingNativeSelection(microphoneDeviceID: 42, output: .selectedProcesses([7])))
        XCTAssertTrue(runtime.isAwaitingOutputAudio)
        microphone.emit(at: 0)
        XCTAssertTrue(runtime.isAwaitingOutputAudio, "Microphone callbacks do not prove output flow")
        output.receiver?.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 0 })
        XCTAssertFalse(runtime.isAwaitingOutputAudio, "Zero-valued valid samples are legitimate silence")
        XCTAssertEqual(runtime.snapshot.state, .recording)
        try runtime.pause(at: 1_000_000)
        XCTAssertFalse(runtime.isAwaitingOutputAudio)
        try runtime.stop(at: 1_000_000)
    }

}
