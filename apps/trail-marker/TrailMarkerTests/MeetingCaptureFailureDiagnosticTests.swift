import Foundation
import XCTest
@testable import TrailMarker

final class MeetingCaptureFailureDiagnosticTests: XCTestCase {
    private let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true,
                                              meetingDeviceAuthorized: true)
    private let microphoneOnly = MeetingNativeSelection(microphoneDeviceID: 42, output: nil)
    private let bothSources = MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([7]))

    private final class Device: MeetingAudioCapturing {
        var receiver: MeetingAudioReceiving?
        var onStart: ((MeetingAudioReceiving) throws -> Void)?
        var stops = 0

        func start(into receiver: MeetingAudioReceiving) throws {
            self.receiver = receiver
            try onStart?(receiver)
        }
        func stop() throws { stops += 1 }
        func emit(at: UInt64 = 0) {
            receiver?.receive(hostTimeNanoseconds: at, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 0.25 })
        }
    }

    private func start(_ runtime: MeetingCaptureRuntime, selection: MeetingNativeSelection? = nil) throws {
        try runtime.prepare(selection: selection ?? microphoneOnly, readiness: ready, at: 0)
        try runtime.start(readiness: ready, at: 0)
    }

    private func buffer(lease: MeetingAudioLease? = nil) throws -> MeetingAudioBuffer {
        try MeetingAudioBuffer(source: .output, epoch: 1, originNanoseconds: 0,
                               sampleCapacity: 8, blockCapacity: 4, lease: lease)
    }

    func testEveryDiagnosticCodeHasAFixedPublicLabelAndSignedStatusRoundTrip() {
        let labels: [(MeetingAudioFailureDiagnostic.Code, String)] = [
            (.outputStart, "outputStart"),
            (.outputTimestamp, "outputTimestamp"),
            (.outputBufferLayout, "outputBufferLayout"),
            (.outputFrameCapacity, "outputFrameCapacity"),
            (.outputDeviceAlive, "outputDeviceAlive"),
            (.outputDeviceList, "outputDeviceList"),
            (.outputDefaultRoute, "outputDefaultRoute"),
            (.outputSystemRoute, "outputSystemRoute"),
            (.outputProcessRoute, "outputProcessRoute"),
            (.outputFormatVerification, "outputFormatVerification"),
            (.outputProcessScope, "outputProcessScope"),
            (.microphoneFormatVerification, "microphoneFormatVerification"),
            (.microphoneCapacityVerification, "microphoneCapacityVerification"),
            (.microphoneFormatRead, "microphoneFormatRead"),
            (.microphoneDeviceGone, "microphoneDeviceGone"),
            (.microphoneContendedTimestamp, "microphoneContendedTimestamp"),
            (.microphoneFrameCapacity, "microphoneFrameCapacity"),
            (.microphoneTimestamp, "microphoneTimestamp"),
            (.microphoneRender, "microphoneRender"),
            (.microphoneBufferLayout, "microphoneBufferLayout"),
            (.bufferCapacity, "bufferCapacity"),
            (.bufferSample, "bufferSample"),
            (.bufferDropFrames, "bufferDropFrames"),
            (.bufferDropMailbox, "bufferDropMailbox"),
            (.bufferFormat, "bufferFormat"),
            (.bufferTimestamp, "bufferTimestamp"),
            (.bufferSampleContinuity, "bufferSampleContinuity"),
            (.bufferClockRange, "bufferClockRange"),
            (.bufferLease, "bufferLease"),
            (.bufferGapCapacity, "bufferGapCapacity"),
            (.captureStart, "captureStart"),
            (.voiceReferenceRoute, "voiceReferenceRoute"),
            (.voiceReferenceFormatVerification, "voiceReferenceFormatVerification"),
            (.voiceReferenceFormatRead, "voiceReferenceFormatRead"),
            (.voiceComponent, "voiceComponent"),
            (.voiceInputEnable, "voiceInputEnable"),
            (.voiceOutputEnable, "voiceOutputEnable"),
            (.voiceBypass, "voiceBypass"),
            (.voiceAGC, "voiceAGC"),
            (.voiceDucking, "voiceDucking"),
            (.voiceRenderCallback, "voiceRenderCallback"),
            (.voiceReferenceSelection, "voiceReferenceSelection"),
            (.voiceDeviceSelection, "voiceDeviceSelection"),
            (.voiceEndpointReadback, "voiceEndpointReadback"),
            (.voiceChannelMap, "voiceChannelMap"),
            (.voiceClientFormat, "voiceClientFormat"),
            (.voiceInitialize, "voiceInitialize"),
            (.voiceStart, "voiceStart"),
            (.voiceDefaultOutputChanged, "voiceDefaultOutputChanged")
        ]
        let statuses: [Int32?] = [nil, 0, -1, -10863, Int32.min, Int32.max]
        for (code, label) in labels {
            for status in statuses {
                let diagnostic = MeetingAudioFailureDiagnostic(code, status: status)
                XCTAssertEqual(MeetingAudioFailureDiagnostic(packed: diagnostic.packed), diagnostic)
                let renderedStatus = status.map { String($0) } ?? "unavailable"
                XCTAssertEqual(MeetingAudioFailureDiagnostic.message(source: .output,
                    failure: MeetingAudioFailure.invalidFormat, diagnostic: diagnostic),
                    "capture-failure source=output callback=\(label) reason=invalidFormat status=\(renderedStatus)")
            }
        }
        XCTAssertNotEqual(MeetingAudioFailureDiagnostic(.microphoneRender).packed,
                          MeetingAudioFailureDiagnostic(.microphoneRender, status: 0).packed)
        XCTAssertNil(MeetingAudioFailureDiagnostic(packed: 0))
        XCTAssertNil(MeetingAudioFailureDiagnostic(packed: UInt64.max))
    }

    func testOnlyExactEchoCancellationOnDiagnosticUsesInfoLogLevel() {
        XCTAssertEqual(MeetingAudioFailureDiagnostic.logLevel(for: "microphone-echo-cancellation=on"), .info)
        for message in [
            "microphone-echo-cancellation=off reason=microphoneOnly",
            "microphone-echo-cancellation=off reason=voiceStart status=-10863",
            "microphone-echo-cancellation=on extra",
            "prefix microphone-echo-cancellation=on",
            "capture-failure source=microphone callback=microphoneRender reason=deviceFailure status=-50",
            ""
        ] {
            XCTAssertEqual(MeetingAudioFailureDiagnostic.logLevel(for: message), .error, message)
        }
    }

    func testDiagnosticSlotPublishesCodeAndStatusTogetherAndStartsEmpty() {
        let slot = MeetingAudioFailureDiagnosticSlot()
        XCTAssertNil(slot.latest)
        for diagnostic in [MeetingAudioFailureDiagnostic(.microphoneRender, status: Int32.min),
                           .init(.outputDeviceAlive, status: Int32.max),
                           .init(.outputTimestamp), .init(.bufferFormat, status: 0)] {
            slot.store(diagnostic)
            XCTAssertEqual(slot.latest, diagnostic)
        }
    }

    func testMessageDoesNotRenderOperationPathsOrNSErrorDetails() {
        let operation = "private-device-name /private/meeting-audio.wav"
        let failure = MeetingAudioFailure.deviceFailure(operation: operation, status: -50)
        XCTAssertEqual(MeetingAudioFailureDiagnostic.message(source: .microphone,
            failure: failure, diagnostic: nil),
            "capture-failure source=microphone callback=unspecifiedCaptureFailure reason=deviceFailure status=-50")
        XCTAssertEqual(MeetingAudioFailureDiagnostic.status(failure), -50)

        let error = NSError(domain: "private-device-domain", code: -10863,
            userInfo: [NSLocalizedDescriptionKey: operation, NSFilePathErrorKey: "/private/meeting-audio.wav"])
        XCTAssertEqual(MeetingAudioFailureDiagnostic.status(error), -10863)
        XCTAssertEqual(MeetingAudioFailureDiagnostic.message(source: .output,
            failure: error, diagnostic: .init(.captureStart)),
            "capture-failure source=output callback=captureStart reason=unknownFailure status=-10863")
        let oversized = NSError(domain: "private-domain", code: Int.max)
        XCTAssertNil(MeetingAudioFailureDiagnostic.status(oversized))
    }

    func testContendedBufferRetainsActualCallbackCodeAndStatusWithoutChangingSemanticFallback() throws {
        let ring = try buffer()
        let diagnostic = MeetingAudioFailureDiagnostic(.microphoneRender, status: -10863)
        ring.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1) { _ in
            // The sample reader holds the ring lock, forcing fail onto its nonblocking path.
            ring.fail(.deviceFailure(operation: "private-render-operation", status: -10863), diagnostic: diagnostic)
            XCTAssertEqual(ring.failureDiagnostic, diagnostic)
            return 0.25
        }
        let failure = try XCTUnwrap(ring.failure)
        XCTAssertEqual(failure, .deviceFailure(operation: "audio-callback", status: -1))
        XCTAssertEqual(ring.failureDiagnostic, diagnostic)
        XCTAssertNil(ring.peek(), "The callback fault must still prevent audio publication")
        XCTAssertEqual(MeetingAudioFailureDiagnostic.message(source: .microphone,
            failure: failure, diagnostic: ring.failureDiagnostic),
            "capture-failure source=microphone callback=microphoneRender reason=deviceFailure status=-10863")
    }

    func testBufferOriginFailuresPublishTheirOwnCheckLabels() throws {
        let cases: [(MeetingAudioFailure, MeetingAudioFailureDiagnostic.Code, (MeetingAudioBuffer) -> Void)] = [
            (.invalidFormat, .bufferFormat, { ring in
                ring.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 7999,
                             frameCount: 1, sampleAt: { _ in 0 })
            }),
            (.invalidTimestamp, .bufferTimestamp, { ring in
                ring.receive(sampleTime: .nan, hostTimeNanoseconds: 0, sampleRate: 8000,
                             frameCount: 1, sampleAt: { _ in 0 })
            }),
            (.invalidTimestamp, .bufferSampleContinuity, { ring in
                ring.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000,
                             frameCount: 1, sampleAt: { _ in 0 })
                ring.receive(sampleTime: 2, hostTimeNanoseconds: 250_000, sampleRate: 8000,
                             frameCount: 1, sampleAt: { _ in 0 })
            }),
            (.invalidTimestamp, .bufferClockRange, { ring in
                ring.receive(sampleTime: 0, hostTimeNanoseconds: UInt64.max - 125_000, sampleRate: 8000,
                             frameCount: 1, sampleAt: { _ in 0 })
                ring.receive(sampleTime: 1, hostTimeNanoseconds: 0, sampleRate: 8000,
                             frameCount: 1, sampleAt: { _ in 0 })
            }),
            (.bufferFull, .bufferCapacity, { ring in
                ring.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 9, sampleAt: { _ in 0 })
            }),
            (.invalidFormat, .bufferSample, { ring in
                ring.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1, sampleAt: { _ in .nan })
            }),
            (.invalidFormat, .bufferDropFrames, { ring in
                ring.drop(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 0)
            }),
            (.bufferFull, .bufferDropMailbox, { ring in
                for index in 0...64 {
                    ring.drop(sampleTime: Double(index), hostTimeNanoseconds: UInt64(index) * 125_000,
                              sampleRate: 8000, frameCount: 1)
                }
            }),
            (.bufferFull, .bufferGapCapacity, { ring in
                for index in 0...64 {
                    ring.drop(sampleTime: Double(index * 2), hostTimeNanoseconds: UInt64(index * 2) * 125_000,
                              sampleRate: 8000, frameCount: 1)
                    ring.receive(sampleTime: Double(index * 2 + 1),
                        hostTimeNanoseconds: UInt64(index * 2 + 1) * 125_000,
                        sampleRate: 8000, frameCount: 1, sampleAt: { _ in 0 })
                    _ = ring.acknowledge(sequence: UInt64(index))
                }
            })
        ]
        for (failure, code, exercise) in cases {
            let ring = try buffer()
            XCTAssertNil(ring.failureDiagnostic)
            exercise(ring)
            XCTAssertEqual(ring.failure, failure, "\(code)")
            XCTAssertEqual(ring.failureDiagnostic, .init(code), "\(code)")
        }
        let expired = try buffer(lease: MeetingAudioLease(deadline: 0))
        expired.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(expired.failure, .leaseExpired)
        XCTAssertEqual(expired.failureDiagnostic, .init(.bufferLease))
    }

    func testClosedOutputGateIgnoresLateFailureAndItsDiagnostic() throws {
        let ring = try buffer()
        let gate = MeetingOutputReceiverGate(ring)
        try gate.open()
        gate.close()
        gate.fail(.invalidSelection, diagnostic: .init(.outputProcessRoute, status: -50))
        gate.fail(.invalidFormat, diagnostic: .init(.outputBufferLayout))
        XCTAssertNil(ring.failure)
        XCTAssertNil(ring.failureDiagnostic)
        XCTAssertThrowsError(try gate.open())
    }

    func testPreOpenOutputFailureRejectsStartupWithoutPublishingDiagnostic() throws {
        let ring = try buffer()
        let gate = MeetingOutputReceiverGate(ring)
        gate.fail(.invalidFormat, diagnostic: .init(.outputFormatVerification))
        XCTAssertThrowsError(try gate.open())
        XCTAssertNil(ring.failure)
        XCTAssertNil(ring.failureDiagnostic)
    }

    func testOutputGateRetainsScopeOverrideAndRejectsLaterNonScopeMetadata() throws {
        let ring = try buffer()
        let gate = MeetingOutputReceiverGate(ring)
        try gate.open()
        gate.fail(.invalidFormat, diagnostic: .init(.outputBufferLayout))
        XCTAssertEqual(ring.failure, .invalidFormat)
        XCTAssertEqual(ring.failureDiagnostic, .init(.outputBufferLayout))
        gate.fail(.invalidSelection, diagnostic: .init(.outputProcessScope))
        XCTAssertEqual(ring.failure, .invalidSelection)
        XCTAssertEqual(ring.failureDiagnostic, .init(.outputProcessScope))
        gate.fail(.invalidTimestamp, diagnostic: .init(.outputTimestamp))
        XCTAssertEqual(ring.failureDiagnostic, .init(.outputProcessScope))
        gate.close()
        gate.fail(.invalidSelection, diagnostic: .init(.outputDefaultRoute))
        XCTAssertEqual(ring.failure, .invalidSelection)
        XCTAssertEqual(ring.failureDiagnostic, .init(.outputProcessScope))
    }

    func testLaterCallbackCannotOverrideBufferScopeFailureOrDiagnostic() throws {
        let ring = try buffer()
        ring.fail(.invalidFormat, diagnostic: .init(.outputBufferLayout))
        ring.fail(.invalidSelection, diagnostic: .init(.outputProcessScope))
        ring.fail(.deviceFailure(operation: "private-operation", status: -50),
                  diagnostic: .init(.outputDeviceAlive, status: -50))
        XCTAssertEqual(ring.failure, .invalidSelection)
        XCTAssertEqual(ring.failureDiagnostic, .init(.outputProcessScope))
        XCTAssertFalse(ring.withSendAdmission { XCTFail("Scope failure must still block sending") })
    }

    func testScopeDiagnosticSurvivesAContendedNonFiniteSampleFailure() throws {
        let ring = try buffer()
        ring.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1) { _ in
            ring.fail(.invalidSelection, diagnostic: .init(.outputProcessScope))
            return .nan
        }
        XCTAssertEqual(ring.failure, .invalidSelection)
        XCTAssertEqual(ring.failureDiagnostic, .init(.outputProcessScope))
        XCTAssertNil(ring.peek())
    }

    func testLegacyScopeFailureDoesNotBorrowEarlierFormatDiagnostic() throws {
        let ring = try buffer()
        ring.fail(.invalidFormat, diagnostic: .init(.outputBufferLayout))
        ring.fail(.invalidSelection)
        XCTAssertEqual(ring.failure, .invalidSelection)
        XCTAssertNil(ring.failureDiagnostic)
    }

    func testHealthyRuntimeDoesNotReportCaptureFailures() throws {
        let microphone = Device()
        var reports: [String] = []
        let runtime = MeetingCaptureRuntime(factory: { _ in [.microphone: microphone] },
                                            reportCaptureFailure: { reports.append($0) })
        try start(runtime)
        microphone.emit()
        XCTAssertTrue(try runtime.service(at: 1_000_000).isEmpty)
        XCTAssertTrue(try runtime.service(at: 2_000_000).isEmpty)
        try runtime.stop(at: 2_000_000)
        XCTAssertTrue(try runtime.dispatchNext(at: 2_000_000) { _ in })
        runtime.completeSend(source: .microphone, epoch: 1, sequence: 0, received: true)
        try runtime.finish(at: 2_000_000)
        XCTAssertTrue(reports.isEmpty)
    }

    func testRuntimeReportsOnceBeforeDiscardingFailedOutputScopeAndKeepsWireGapReason() throws {
        let microphone = Device(), output = Device()
        var reports: [String] = []
        var hadAudioWhenReported = false
        let runtime = MeetingCaptureRuntime(factory: { _ in [.microphone: microphone, .output: output] },
            reportCaptureFailure: { message in
                reports.append(message)
                hadAudioWhenReported = (output.receiver as? MeetingAudioBuffer)?.peek() != nil
                    && (microphone.receiver as? MeetingAudioBuffer)?.peek() != nil
                XCTAssertEqual(output.stops, 0)
                XCTAssertEqual(microphone.stops, 0)
            })
        try start(runtime, selection: bothSources)
        microphone.emit()
        output.emit()
        output.receiver?.fail(.invalidSelection, diagnostic: .init(.outputProcessRoute, status: -50))
        let gaps = try runtime.service(at: 1_000_000)
        XCTAssertTrue(hadAudioWhenReported)
        XCTAssertEqual(reports, ["capture-failure source=output callback=outputProcessRoute reason=invalidSelection status=-50"])
        XCTAssertEqual(gaps, [.init(source: .output, epoch: 1, startNanoseconds: 0,
                                   endNanoseconds: 1_000_000, reason: .captureFailure(.invalidSelection))])
        XCTAssertEqual(runtime.snapshot.state, .paused)
        XCTAssertNil((output.receiver as? MeetingAudioBuffer)?.peek())
        XCTAssertNil((microphone.receiver as? MeetingAudioBuffer)?.peek())
        XCTAssertTrue(runtime.audioDiagnostics.isEmpty)
        XCTAssertEqual(output.stops, 1)
        XCTAssertEqual(microphone.stops, 1)

        var timeline = MeetingCaptureTimeline()
        timeline.originNanoseconds = 0
        timeline.epochs[1] = .init(remoteEpoch: 9, generation: 2,
            choice: .init(mode: "computer-audio", microphone: nil, outputSourceId: "output-source",
                          appProcessTreeId: nil, scope: nil), startNanoseconds: 0)
        let wireGap = try XCTUnwrap(timeline.map(try XCTUnwrap(gaps.first)))
        XCTAssertEqual(wireGap.reason, "source-unavailable")
        XCTAssertEqual(wireGap.sourceId, "output-source")
        XCTAssertEqual(wireGap.epoch, 9)
        XCTAssertEqual(wireGap.startMs, 0)
        XCTAssertEqual(wireGap.endMs, 1)

        XCTAssertTrue(try runtime.service(at: 2_000_000).isEmpty)
        try runtime.stop(at: 2_000_000)
        XCTAssertFalse(try runtime.dispatchNext(at: 2_000_000) { _ in XCTFail("Discarded scope must not flush") })
        XCTAssertEqual(reports.count, 1)
    }

    func testStartupCallbackFailureReportsFreshRingBeforeRollback() throws {
        let microphone = Device()
        let failure = MeetingAudioFailure.deviceFailure(operation: "private-startup-device", status: -10863)
        microphone.onStart = { receiver in
            receiver.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 0.25 })
            receiver.fail(failure, diagnostic: .init(.microphoneRender, status: -10863))
        }
        var reports: [String] = []
        var hadAudioWhenReported = false
        let runtime = MeetingCaptureRuntime(factory: { _ in [.microphone: microphone] },
            reportCaptureFailure: { message in
                reports.append(message)
                hadAudioWhenReported = (microphone.receiver as? MeetingAudioBuffer)?.peek() != nil
                XCTAssertEqual(microphone.stops, 0)
            })
        XCTAssertThrowsError(try start(runtime)) { XCTAssertEqual($0 as? MeetingAudioFailure, failure) }
        XCTAssertTrue(hadAudioWhenReported)
        XCTAssertEqual(reports, ["capture-failure source=microphone callback=microphoneRender reason=deviceFailure status=-10863"])
        XCTAssertEqual(runtime.snapshot.state, .failed)
        XCTAssertEqual(microphone.stops, 1)
        XCTAssertNil((microphone.receiver as? MeetingAudioBuffer)?.peek())
        XCTAssertFalse(try runtime.dispatchNext(at: 1_000_000) { _ in XCTFail("Failed startup must not publish audio") })
        XCTAssertTrue(try runtime.service(at: 2_000_000).isEmpty)
        XCTAssertEqual(reports.count, 1)
    }

    func testThrownStartupErrorUsesActualStartingSourceAndFixedFallbackLabel() throws {
        let microphone = Device(), output = Device()
        output.onStart = { _ in
            throw NSError(domain: "private-output-domain", code: -50,
                          userInfo: [NSLocalizedDescriptionKey: "/private/recording.wav private-device-name"])
        }
        var reports: [String] = []
        let runtime = MeetingCaptureRuntime(factory: { _ in [.microphone: microphone, .output: output] },
                                            reportCaptureFailure: { reports.append($0) })
        XCTAssertThrowsError(try start(runtime, selection: bothSources))
        XCTAssertEqual(reports, ["capture-failure source=output callback=captureStart reason=unknownFailure status=-50"])
        XCTAssertEqual(runtime.snapshot.state, .failed)
        XCTAssertEqual(microphone.stops, 1)
        XCTAssertEqual(output.stops, 1)
        XCTAssertTrue(try runtime.service(at: 1_000_000).isEmpty)
        XCTAssertEqual(reports.count, 1)
    }
}
