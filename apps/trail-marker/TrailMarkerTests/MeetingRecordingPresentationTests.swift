import AppKit
import XCTest
@testable import TrailMarker

final class MeetingRecordingPresentationTests: XCTestCase {
    func testPillAndRedDotShowThroughPauseAndHideResetsOnlyAtNextStart() {
        var presentation = MeetingRecordingPresentation()
        XCTAssertFalse(presentation.showsPill)
        presentation.acceptedStart()
        XCTAssertTrue(presentation.showsPill)
        XCTAssertTrue(presentation.showsRedDot)
        presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 61000, level: 0.5)
        XCTAssertEqual(presentation.state, .recording)
        XCTAssertEqual(presentation.elapsedText, "01:01")
        XCTAssertEqual(presentation.waveform.last, 0.5)
        presentation.hide()
        XCTAssertFalse(presentation.showsPill)
        XCTAssertTrue(presentation.showsRedDot, "Hide must not stop the recording session")
        presentation.update(phase: .paused, reconnecting: false, elapsedMilliseconds: 61000, level: 1)
        XCTAssertTrue(presentation.showsRedDot, "Pause keeps the session's red dot")
        XCTAssertFalse(presentation.showsPill)
        XCTAssertEqual(presentation.state, .paused)
        XCTAssertTrue(presentation.waveform.allSatisfy { $0 == 0 })
        presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 62000, level: 0.25)
        XCTAssertFalse(presentation.showsPill, "Resume does not undo Hide")
        presentation.stop()
        XCTAssertFalse(presentation.showsPill)
        XCTAssertFalse(presentation.showsRedDot)
        presentation.acceptedStart()
        XCTAssertTrue(presentation.showsPill, "A new accepted Start shows it again")
    }

    func testEveryTerminalPhaseClearsBothSurfacesAndWaveform() {
        for phase in [MeetingCaptureHost.Phase.stopping, .stopped, .error, .unprepared] {
            var presentation = MeetingRecordingPresentation()
            presentation.acceptedStart()
            presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 1000, level: 0.9)
            presentation.update(phase: phase, reconnecting: false, elapsedMilliseconds: 1000, level: 0.9)
            XCTAssertFalse(presentation.showsPill, phase.rawValue)
            XCTAssertFalse(presentation.showsRedDot, phase.rawValue)
            XCTAssertTrue(presentation.waveform.allSatisfy { $0 == 0 })
        }
    }

    func testWaveformIsFlatOnSilentMissingOrNonfiniteInputIncludingReconnect() {
        for silent in [Float(0), -.infinity, .infinity, .nan] {
            var presentation = MeetingRecordingPresentation()
            presentation.acceptedStart()
            presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 0, level: 0.7)
            presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 250, level: silent)
            XCTAssertEqual(presentation.state, .noAudio)
            XCTAssertTrue(presentation.waveform.allSatisfy { $0 == 0 }, "Silence must clear prior waveform immediately")
            presentation.update(phase: .recording, reconnecting: true, elapsedMilliseconds: 500, level: 0)
            XCTAssertEqual(presentation.state, .reconnecting)
            XCTAssertTrue(presentation.waveform.allSatisfy { $0 == 0 })
        }
    }

    func testActualCapturedPeakExpiresAndPauseNeverDisplaysRetainedAudio() throws {
        final class Device: MeetingAudioCapturing {
            var receiver: MeetingAudioReceiving?
            func start(into receiver: MeetingAudioReceiving) throws { self.receiver = receiver }
            func stop() throws {}
        }
        let microphone = Device(), output = Device()
        let runtime = MeetingCaptureRuntime(factory: { _ in [.microphone: microphone, .output: output] })
        let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true, meetingDeviceAuthorized: true)
        try runtime.prepare(selection: .init(microphoneDeviceID: 1, output: .selectedProcesses([2])), readiness: ready, at: 1_000_000_000)
        try runtime.start(readiness: ready, at: 1_000_000_000)
        defer { try? runtime.terminate(at: 2_000_000_000) }
        XCTAssertEqual(runtime.capturedLevel(at: 1_000_000_000), 0)
        microphone.receiver?.receive(hostTimeNanoseconds: 1_000_000_000, sampleRate: 8000, frameCount: 800, sampleAt: { _ in -0.25 })
        output.receiver?.receive(hostTimeNanoseconds: 1_000_000_000, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.75 })
        XCTAssertEqual(runtime.capturedLevel(at: 1_100_000_000), 0.75, accuracy: 0.0001, "Display the maximum actual source peak")
        microphone.receiver?.receive(hostTimeNanoseconds: 1_100_000_000, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0 })
        output.receiver?.receive(hostTimeNanoseconds: 1_100_000_000, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0 })
        XCTAssertEqual(runtime.capturedLevel(at: 1_200_000_000), 0, "Actual silent callbacks replace the previous peak")
        microphone.receiver?.receive(hostTimeNanoseconds: 1_200_000_000, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
        XCTAssertGreaterThan(runtime.capturedLevel(at: 1_200_000_000), 0)
        XCTAssertEqual(runtime.capturedLevel(at: 1_700_000_000), 0, "Missing callbacks must go flat")
        try runtime.pause(at: 1_700_000_001)
        XCTAssertEqual(runtime.capturedLevel(at: 1_700_000_002), 0, "Retained audio is not live input")
    }

    @MainActor
    func testPanelFloatsOnEverySpaceWithoutActivationOrHardware() {
        let host = MeetingCaptureHost(connection: ConnectionRuntime(), factory: { _ in
            XCTFail("Presentation must not open audio devices")
            return [:]
        })
        let controller = MeetingRecordingPillController(host: host)
        XCTAssertEqual(controller.panel.frame.size, NSSize(width: 250, height: 80))
        XCTAssertEqual(controller.panel.contentView?.frame.size, NSSize(width: 250, height: 80))
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingControlDiameter, 54)
        XCTAssertEqual(controller.panel.level, .floating)
        XCTAssertTrue(controller.panel.collectionBehavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(controller.panel.collectionBehavior.contains(.fullScreenAuxiliary))
        XCTAssertTrue(controller.panel.styleMask.contains(.nonactivatingPanel))
        XCTAssertTrue(controller.panel.isMovableByWindowBackground)
        XCTAssertTrue(controller.panel.isFloatingPanel)
        XCTAssertTrue(controller.panel.canBecomeKey)
        XCTAssertFalse(controller.panel.hidesOnDeactivate)
        XCTAssertFalse(controller.panel.isVisible)
    }
}
