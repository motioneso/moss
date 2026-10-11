import AppKit
import SwiftUI
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
        XCTAssertEqual(presentation.meterLevels.last, 0.5)
        presentation.hide()
        XCTAssertFalse(presentation.showsPill)
        XCTAssertTrue(presentation.showsRedDot, "Hide must not stop the recording session")
        presentation.update(phase: .paused, reconnecting: false, elapsedMilliseconds: 61000, level: 1)
        XCTAssertTrue(presentation.showsRedDot, "Pause keeps the session's red dot")
        XCTAssertFalse(presentation.showsPill)
        XCTAssertEqual(presentation.state, .paused)
        XCTAssertTrue(presentation.meterLevels.allSatisfy { $0 == 0 })
        presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 62000, level: 0.25)
        XCTAssertFalse(presentation.showsPill, "Resume does not undo Hide")
        presentation.stop()
        XCTAssertFalse(presentation.showsPill)
        XCTAssertFalse(presentation.showsRedDot)
        presentation.acceptedStart()
        XCTAssertTrue(presentation.showsPill, "A new accepted Start shows it again")
    }

    func testRecoveringOverridesHideWithDistinctVisibleStatusAndPauseControl() {
        var presentation = MeetingRecordingPresentation()
        presentation.acceptedStart()
        presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 1000, level: 0.8)
        presentation.hide()
        presentation.update(phase: .recovering, reconnecting: true, elapsedMilliseconds: 1000, level: 0.8)
        XCTAssertEqual(presentation.state, .recovering)
        XCTAssertEqual(presentation.state.rawValue, "Recovering audio…")
        XCTAssertNotEqual(presentation.state, .reconnecting, "Network delay and interrupted capture are different states")
        XCTAssertTrue(presentation.showsPill, "A hidden pill must surface the audio interruption")
        XCTAssertTrue(presentation.showsAttention)
        XCTAssertTrue(presentation.canPause, "Pause remains usable while recovery is pending")
        XCTAssertFalse(presentation.canHide)
        XCTAssertEqual(presentation.meterLevels, [0, 0, 0], "Recovery must never imply live input")
        presentation.hide()
        XCTAssertTrue(presentation.showsPill)
        presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 2000, level: 0.2)
        XCTAssertFalse(presentation.showsPill, "Successful recovery restores the ordinary Hide preference")
        XCTAssertFalse(presentation.showsAttention)
        XCTAssertTrue(presentation.canHide)
    }

    func testInterruptionWarningForcesHiddenPillVisibleUntilExplicitlyCleared() {
        var presentation = MeetingRecordingPresentation()
        let reason = "The selected microphone is unavailable. Reconnect it, then press Resume."
        presentation.acceptedStart()
        presentation.hide()
        for _ in 0..<3 {
            presentation.update(phase: .paused, reconnecting: true, elapsedMilliseconds: 61000,
                                level: 0.8, interruptionWarning: reason)
            XCTAssertEqual(presentation.state, .interrupted)
            XCTAssertEqual(presentation.interruptionWarning, reason)
            XCTAssertTrue(presentation.showsPill)
            XCTAssertTrue(presentation.showsRedDot)
            XCTAssertFalse(presentation.canHide)
            XCTAssertFalse(presentation.canPause)
            XCTAssertEqual(presentation.elapsedText, "01:01")
            XCTAssertEqual(presentation.meterLevels, [0, 0, 0])
            presentation.hide()
            XCTAssertTrue(presentation.showsPill, "The warning cannot be dismissed by X or native Close")
        }
        presentation.update(phase: .paused, reconnecting: false, elapsedMilliseconds: 61000, level: 0)
        XCTAssertNil(presentation.interruptionWarning)
        XCTAssertEqual(presentation.state, .paused)
        XCTAssertFalse(presentation.showsPill, "Explicitly clearing the warning preserves ordinary user Pause/Hide")
    }

    func testCleanupErrorRemainsVisibleAfterRecordingSurfacesWereStopped() {
        var presentation = MeetingRecordingPresentation()
        presentation.acceptedStart()
        presentation.hide()
        presentation.stop()
        let reason = "Audio cleanup failed. Stop recording and retry before continuing."
        for _ in 0..<3 {
            presentation.update(phase: .error, reconnecting: false, elapsedMilliseconds: 1000,
                                level: 0.8, interruptionWarning: reason)
            XCTAssertTrue(presentation.showsPill, "A real cleanup error must survive terminal-phase presentation updates")
            XCTAssertEqual(presentation.state, .error)
            XCTAssertEqual(presentation.interruptionWarning, reason)
            XCTAssertFalse(presentation.showsRedDot, "A warning must not claim an active recording")
            XCTAssertFalse(presentation.canPause)
            XCTAssertFalse(presentation.canHide)
            presentation.hide()
            XCTAssertTrue(presentation.showsPill)
        }
        presentation.acceptedStart()
        XCTAssertNil(presentation.interruptionWarning, "A new accepted Start clears the previous interruption")
        XCTAssertTrue(presentation.canHide)
        presentation.stop()
        XCTAssertFalse(presentation.showsPill)
        XCTAssertNil(presentation.interruptionWarning)
    }

    func testEveryTerminalPhaseClearsBothSurfacesAndMeter() {
        for phase in [MeetingCaptureHost.Phase.stopping, .stopped, .error, .unprepared] {
            var presentation = MeetingRecordingPresentation()
            presentation.acceptedStart()
            presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 1000, level: 0.9)
            presentation.update(phase: phase, reconnecting: false, elapsedMilliseconds: 1000, level: 0.9)
            XCTAssertFalse(presentation.showsPill, phase.rawValue)
            XCTAssertFalse(presentation.showsRedDot, phase.rawValue)
            XCTAssertTrue(presentation.meterLevels.allSatisfy { $0 == 0 })
            presentation.show()
            XCTAssertFalse(presentation.showsPill, "Show cannot restore a terminal session")
            XCTAssertFalse(presentation.showsRedDot)
        }
    }

    func testShowOnlyRestoresVisibilityAndNextStartResetsHide() {
        var presentation = MeetingRecordingPresentation()
        presentation.show()
        XCTAssertFalse(presentation.showsPill, "Show cannot accept a Start")
        for phase in [MeetingCaptureHost.Phase.recording, .paused] {
            presentation.acceptedStart()
            presentation.update(phase: phase, reconnecting: false, elapsedMilliseconds: 1000, level: 0.5)
            let visible = presentation
            presentation.hide()
            presentation.show()
            XCTAssertEqual(presentation, visible, "Show preserves the recording state, duration and levels")
            presentation.hide()
            presentation.acceptedStart()
            XCTAssertTrue(presentation.showsPill, "Every new recording resets the previous Hide")
            XCTAssertFalse(presentation.hidden)
        }
    }

    func testMeterIsFlatOnSilentMissingOrNonfiniteInputIncludingReconnect() {
        for silent in [Float(0), -0.5, -.infinity, .infinity, .nan] {
            var presentation = MeetingRecordingPresentation()
            presentation.acceptedStart()
            presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 0, level: 0.7)
            presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 250, level: silent)
            XCTAssertEqual(presentation.state, .noAudio)
            XCTAssertTrue(presentation.meterLevels.allSatisfy { $0 == 0 }, "Silence must clear prior meter levels immediately")
            presentation.update(phase: .recording, reconnecting: true, elapsedMilliseconds: 500, level: 0)
            XCTAssertEqual(presentation.state, .reconnecting)
            XCTAssertTrue(presentation.meterLevels.allSatisfy { $0 == 0 })
        }
    }

    func testMeterContainsOnlyThreeLatestCapturedPeaks() {
        var presentation = MeetingRecordingPresentation()
        presentation.acceptedStart()
        XCTAssertEqual(presentation.meterLevels, [0, 0, 0])
        for level in [Float(0.1), 0.25, 0.5, 2] {
            presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 0, level: level)
        }
        XCTAssertEqual(presentation.meterLevels, [0.25, 0.5, 1], "The three bars show only actual, clamped captured peaks")
        presentation.update(phase: .recording, reconnecting: true, elapsedMilliseconds: 0, level: 0.75)
        XCTAssertEqual(presentation.meterLevels, [0.5, 1, 0.75], "A valid reconnecting capture can still show real input")
        presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 0, level: 0)
        XCTAssertEqual(presentation.meterLevels, [0, 0, 0], "Silence clears all three bars, not just the newest one")
        presentation.update(phase: .recording, reconnecting: false, elapsedMilliseconds: 0, level: 0.4)
        XCTAssertEqual(presentation.meterLevels, [0, 0, 0.4], "Audio after silence must not restore historical activity")
        presentation.update(phase: .ready, reconnecting: false, elapsedMilliseconds: 0, level: 0.9)
        XCTAssertEqual(presentation.meterLevels, [0, 0, 0], "A session without active capture cannot display input")
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
    func testRecordingPillPaletteMatchesReferenceInLightAndDarkAppearance() {
        let colors: [(SwiftUI.Color, UInt32)] = [
            (TrailMarkerTokens.Color.recordingSurface, 0xFFFFFF),
            (TrailMarkerTokens.Color.recordingBorder, 0xD8D8D2),
            (TrailMarkerTokens.Color.recordingControlBorder, 0xCBD0D6),
            (TrailMarkerTokens.Color.recordingForeground, 0x6B7280),
            (TrailMarkerTokens.Color.recordingDanger, 0xDB3D38),
            (TrailMarkerTokens.Color.recordingOnDanger, 0xFFFFFF),
        ]
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            guard let appearance = NSAppearance(named: name) else { XCTFail("Missing appearance"); return }
            appearance.performAsCurrentDrawingAppearance {
                for (color, expected) in colors {
                    guard let resolved = NSColor(color).usingColorSpace(.sRGB) else {
                        XCTFail("Missing sRGB recording color"); continue
                    }
                    XCTAssertEqual(resolved.redComponent, CGFloat((expected >> 16) & 0xFF) / 255, accuracy: 0.0001)
                    XCTAssertEqual(resolved.greenComponent, CGFloat((expected >> 8) & 0xFF) / 255, accuracy: 0.0001)
                    XCTAssertEqual(resolved.blueComponent, CGFloat(expected & 0xFF) / 255, accuracy: 0.0001)
                    XCTAssertEqual(resolved.alphaComponent, 1)
                }
            }
        }
    }

    @MainActor
    func testActualCleanupErrorShowsPanelAndRejectsEveryHideAction() {
        let host = MeetingCaptureHost(connection: ConnectionRuntime(), factory: { _ in
            XCTFail("A cleanup warning must not open audio devices")
            return [:]
        })
        let controller = MeetingRecordingPillController(host: host)
        defer {
            host.shutdown(reason: "Synthetic cleanup-warning test finished")
            controller.panel.orderOut(nil)
        }
        host.hideRecordingPill()
        XCTAssertFalse(controller.panel.isVisible)
        host.interrupt(error: MeetingAudioFailure.cleanupFailed)
        XCTAssertEqual(host.phase, .error)
        XCTAssertEqual(host.recordingPresentation.interruptionWarning, MeetingHostError.cleanupFailed.message)
        XCTAssertTrue(host.canStop, "Cleanup failures retain Stop so disposal can be retried")
        XCTAssertFalse(host.canResumeFromUserClick, "Cleanup failure must block Resume")
        let hideActions: [() -> Void] = [host.hideRecordingPill, { controller.panel.close() }, { controller.panel.performClose(nil) }]
        for hide in hideActions {
            hide()
            XCTAssertTrue(controller.panel.isVisible, "The actual cleanup warning cannot be hidden")
            XCTAssertTrue(host.recordingPresentation.showsPill)
        }
    }

    @MainActor
    func testPanelExpandsForRecoveryAndFullWarningThenReturnsToCompactSize() {
        let host = MeetingCaptureHost(connection: ConnectionRuntime(), factory: { _ in
            XCTFail("Presentation must not open audio devices")
            return [:]
        })
        let controller = MeetingRecordingPillController(host: host)
        defer { controller.panel.orderOut(nil) }
        var presentation = MeetingRecordingPresentation()
        presentation.acceptedStart()
        presentation.hide()
        controller.present(presentation)
        XCTAssertFalse(controller.panel.isVisible)
        presentation.update(phase: .recovering, reconnecting: false, elapsedMilliseconds: 1000, level: 0)
        controller.present(presentation)
        XCTAssertTrue(controller.panel.isVisible)
        XCTAssertEqual(controller.panel.frame.width, TrailMarkerTokens.Layout.menuPopoverWidth)
        XCTAssertGreaterThan(controller.panel.frame.height, TrailMarkerTokens.Layout.recordingPillHeight)
        let recoveryHeight = controller.panel.frame.height
        presentation.update(phase: .paused, reconnecting: false, elapsedMilliseconds: 1000, level: 0,
            interruptionWarning: "The selected microphone disconnected while capturing audio. Reconnect the same microphone and check its permission in macOS Settings, then press Resume. Capture will remain paused until you choose Resume or Stop.")
        controller.present(presentation)
        XCTAssertTrue(controller.panel.isVisible)
        XCTAssertGreaterThan(controller.panel.frame.height, recoveryHeight, "The full reason must wrap instead of being clipped to pill height")
        XCTAssertEqual(controller.panel.contentView?.frame.size, controller.panel.frame.size)
        presentation.update(phase: .paused, reconnecting: false, elapsedMilliseconds: 1000, level: 0)
        controller.present(presentation)
        XCTAssertFalse(controller.panel.isVisible)
        XCTAssertEqual(controller.panel.frame.size, NSSize(width: 222, height: 32))
    }

    @MainActor
    func testPanelFloatsOnEverySpaceWithoutActivationOrHardware() {
        let host = MeetingCaptureHost(connection: ConnectionRuntime(), factory: { _ in
            XCTFail("Presentation must not open audio devices")
            return [:]
        })
        let controller = MeetingRecordingPillController(host: host)
        XCTAssertEqual(controller.panel.frame.size, NSSize(width: 222, height: 32))
        XCTAssertEqual(controller.panel.contentView?.frame.size, NSSize(width: 222, height: 32))
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingControlDiameter, 24)
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingMeterWidth, 24)
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingMeterHeight, 18)
        XCTAssertEqual(3 * TrailMarkerTokens.Layout.recordingMeterBarWidth + 2 * TrailMarkerTokens.Layout.recordingMeterBarSpacing,
                       TrailMarkerTokens.Layout.recordingMeterWidth, accuracy: 0.001)
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingControlBorderWidth, 0.8)
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingCloseDiameter, 20)
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingCloseSectionWidth, 24)
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingCloseDividerWidth +
                       TrailMarkerTokens.Layout.recordingCloseSectionSpacing +
                       TrailMarkerTokens.Layout.recordingCloseDiameter,
                       TrailMarkerTokens.Layout.recordingCloseSectionWidth)
        XCTAssertEqual(TrailMarkerTokens.Layout.recordingCloseSectionWidth +
                       TrailMarkerTokens.Layout.recordingPillTrailingInset, 26.8, accuracy: 0.001)
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
