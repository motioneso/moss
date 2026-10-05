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

}
