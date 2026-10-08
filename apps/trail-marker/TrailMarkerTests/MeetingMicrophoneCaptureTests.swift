import AudioToolbox
import CoreAudio
import XCTest
@testable import TrailMarker

/// Synthetic only: every test injects FakeUnit. No test constructs the concrete AUHAL unit.
final class MeetingMicrophoneCaptureTests: XCTestCase {
    private final class Receiver: MeetingAudioReceiving {
        struct Batch {
            let hostTime: UInt64
            let sampleRate: Double
            let samples: [Float]
        }
        var batches: [Batch] = []
        var failures: [MeetingAudioFailure] = []
        var diagnostics: [MeetingAudioFailureDiagnostic] = []
        func fail(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic) {
            failures.append(failure); diagnostics.append(diagnostic)
        }
        var droppedSampleTimes: [Double] = []
        var receivedSampleTimes: [Double] = []
        func receive(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double,
                     frameCount: Int, sampleAt: (Int) -> Float) {
            receivedSampleTimes.append(sampleTime)
            receive(hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate, frameCount: frameCount, sampleAt: sampleAt)
        }
        func drop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int) {
            droppedSampleTimes.append(sampleTime)
        }

        func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float) {
            batches.append(Batch(
                hostTime: hostTimeNanoseconds, sampleRate: sampleRate,
                samples: (0..<frameCount).map(sampleAt)
            ))
        }

        func fail(_ failure: MeetingAudioFailure) { failures.append(failure) }
    }

    private final class FakeUnit: MeetingMicrophoneUnit {
        static let startup = [
            "create", "input", "output", "device", "format", "mono", "capacity", "callback",
            "initialize", "listener", "deviceListener", "verifyFormat", "verifyCapacity", "start",
        ]
        var events: [String] = []
        var failAt: Set<String> = []
        var failureOverride: Error?
        var onStart: (() -> Void)?
        var onDispose: (() -> Void)?
        var selectedDevice: AudioDeviceID?
        var configuredRate: Double?
        var format = AudioStreamBasicDescription(
            mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked, mBytesPerPacket: 8, mFramesPerPacket: 1,
            mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0
        )
        var verifiedFormat: AudioStreamBasicDescription?
        var configuredOutput = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked, mBytesPerPacket: 4, mFramesPerPacket: 1,
            mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var nextSampleTime: Double = 0
        var capacity: UInt32 = 8
        var verifiedCapacity: UInt32?
        var context: MeetingMicrophoneRenderContext?
        var onRender: (() -> Void)?
        var onListener: (() -> Void)?
        var onFormatRead: (() -> Void)?
        var corruptBuffer: ((UnsafeMutablePointer<AudioBufferList>) -> Void)?
        var renderStatus: OSStatus = noErr
        var renderCount = 0
        var sampleOffset: Float = 0
        var formatReads = 0
        var capacityReads = 0
        var lastFlags: AudioUnitRenderActionFlags?
        var lastTimestamp: UInt64?

        func step(_ name: String) throws {
            events.append(name)
            if failAt.contains(name) {
                throw failureOverride ?? MeetingAudioFailure.deviceFailure(operation: name, status: -99)
            }
        }

        func capture(device: AudioDeviceID = 42, voiceProcessing: Bool = false) -> MeetingMicrophoneCapture {
            MeetingMicrophoneCapture(
                selectedDeviceID: device, voiceProcessing: voiceProcessing,
                makeUnit: { _ in try self.step("create"); return self },
                hostTimeToNanoseconds: { $0 * 10 }
            )
        }

        func enableInput() throws { try step("input") }
        func configureOutput() throws { try step("output") }
        func selectDevice(_ deviceID: AudioDeviceID) throws { try step("device"); selectedDevice = deviceID }
        func inputFormat() throws -> AudioStreamBasicDescription {
            formatReads += 1
            try step(formatReads == 1 ? "format" : "verifyFormat")
            onFormatRead?()
            return formatReads == 1 ? format : (verifiedFormat ?? format)
        }
        var referenceOutput: AudioStreamBasicDescription?
        var referenceReadError: Error?
        var referenceReads = 0
        func referenceFormat() throws -> AudioStreamBasicDescription? {
            referenceReads += 1
            if let referenceReadError { throw referenceReadError }
            return referenceOutput ?? configuredOutput
        }
        func outputFormat() throws -> AudioStreamBasicDescription { configuredOutput }
        func configureMonoOutput(sampleRate: Double) throws {
            try step("mono"); configuredRate = sampleRate; configuredOutput.mSampleRate = sampleRate
        }
        func maximumFramesPerSlice() throws -> UInt32 {
            capacityReads += 1
            try step(capacityReads == 1 ? "capacity" : "verifyCapacity")
            return capacityReads == 1 ? capacity : (verifiedCapacity ?? capacity)
        }
        func installInputCallback(_ context: MeetingMicrophoneRenderContext) throws {
            // Emulate partial registration: even a failing install can retain the context.
            self.context = context
            try step("callback")
        }
        func initialize() throws { try step("initialize") }
        func installFormatListener(_ context: MeetingMicrophoneRenderContext) throws {
            try step("listener")
            onListener?()
        }
        func installDeviceListener(_ context: MeetingMicrophoneRenderContext) throws { try step("deviceListener") }
        func start() throws { onStart?(); try step("start") }
        func stop() throws { try step("stop") }
        func uninitialize() throws { try step("uninitialize") }
        func dispose() throws { try step("dispose"); context = nil; onDispose?() }

        func render(
            flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, timestamp: UnsafePointer<AudioTimeStamp>,
            frameCount: UInt32, buffers: UnsafeMutablePointer<AudioBufferList>
        ) -> OSStatus {
            renderCount += 1
            lastFlags = flags.pointee
            lastTimestamp = timestamp.pointee.mHostTime
            if let data = buffers.pointee.mBuffers.mData {
                let samples = data.assumingMemoryBound(to: Float.self)
                for index in 0..<Int(frameCount) { samples[index] = sampleOffset + Float(index) }
            }
            onRender?()
            corruptBuffer?(buffers)
            return renderStatus
        }

        @discardableResult
        func emit(
            at hostTime: UInt64 = 100, frames: UInt32 = 3,
            validHostTime: Bool = true, validSampleTime: Bool = true, sampleTime: Double? = nil, to savedContext: MeetingMicrophoneRenderContext? = nil
        ) -> OSStatus {
            guard let target = savedContext ?? context else { return kAudioUnitErr_Uninitialized }
            var flags: AudioUnitRenderActionFlags = []
            var timestamp = AudioTimeStamp()
            timestamp.mHostTime = hostTime
            timestamp.mSampleTime = sampleTime ?? nextSampleTime
            nextSampleTime = timestamp.mSampleTime + Double(frames)
            timestamp.mFlags = []
            if validHostTime { timestamp.mFlags.insert(.hostTimeValid) }
            if validSampleTime { timestamp.mFlags.insert(.sampleTimeValid) }
            return target.render(flags: &flags, timestamp: &timestamp, frameCount: frames)
        }
    }

    func testConstructionIsInertAndStopBeforeStartIsIdempotent() throws {
        let unit = FakeUnit()
        let capture = unit.capture()
        try capture.stop()
        try capture.stop()
        XCTAssertTrue(unit.events.isEmpty)
    }

    func testSelectedDeviceAndHardwareRateAreUsedInRequiredOrder() throws {
        let unit = FakeUnit()
        let capture = unit.capture(device: 71)
        try capture.start(into: Receiver())
        XCTAssertEqual(unit.events, FakeUnit.startup)
        XCTAssertEqual(unit.selectedDevice, 71)
        XCTAssertEqual(unit.configuredRate, 48_000)
        try capture.stop()
        XCTAssertEqual(Array(unit.events.suffix(3)), ["stop", "uninitialize", "dispose"])
        let afterStop = unit.events
        try capture.stop()
        XCTAssertEqual(unit.events, afterStop)
    }

    func testReferenceRouteChangesCloseMicrophoneAdmissionWithoutRetargeting() throws {
        for (current, alive) in [(Optional<UInt32>(12), true), (nil, true), (11, false)] {
            let unit = FakeUnit()
            let receiver = Receiver()
            let capture = unit.capture(device: 71, voiceProcessing: true)
            try capture.start(into: receiver)
            let context = try XCTUnwrap(unit.context)
            unit.emit()
            XCTAssertEqual(receiver.batches.count, 1)
            MeetingVoiceProcessing.verifyReference(expected: 11, current: current, alive: alive, context: context)
            unit.emit()
            XCTAssertEqual(receiver.failures, [.invalidSelection], "Changed reference must close microphone admission")
            XCTAssertEqual(receiver.batches.count, 1, "No microphone samples after reference loss")
            XCTAssertEqual(unit.selectedDevice, 71)
            try capture.stop()
        }
    }

    func testUnchangedReferenceAndLateRouteNoticesAreInert() throws {
        let unit = FakeUnit()
        let receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        let context = try XCTUnwrap(unit.context)
        MeetingVoiceProcessing.verifyReference(expected: 11, current: 11, alive: true, context: context)
        unit.emit()
        XCTAssertEqual(receiver.batches.count, 1)
        XCTAssertTrue(receiver.failures.isEmpty)
        try capture.stop()
        MeetingVoiceProcessing.verifyReference(expected: 11, current: nil, alive: false, context: context)
        XCTAssertTrue(receiver.failures.isEmpty)
    }

    func testReferenceFormatChangeClosesAdmissionUntilExplicitRestart() throws {
        let unit = FakeUnit()
        let receiver = Receiver()
        let capture = unit.capture(voiceProcessing: true)
        try capture.start(into: receiver)
        unit.referenceOutput = unit.configuredOutput
        unit.referenceOutput?.mSampleRate = 44_100
        unit.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
        unit.context?.verifyFormatIfNeeded()
        unit.emit()
        XCTAssertEqual(receiver.failures, [.invalidFormat])
        XCTAssertEqual(receiver.diagnostics.last?.code, .voiceReferenceFormatVerification)
        XCTAssertTrue(receiver.batches.isEmpty)
        try capture.stop()
    }

    func testMicrophoneOnlyIgnoresPlaybackFormatNotices() throws {
        let unit = FakeUnit()
        let receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        unit.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Output, element: 0)
        unit.emit()
        XCTAssertTrue(receiver.failures.isEmpty)
        XCTAssertEqual(receiver.batches.count, 1)
        try capture.stop()
    }

    func testSourceModesOnlyUseVoiceProcessingWithMicrophoneAndOutput() throws {
        let micOnly = try MeetingCaptureHost.devices(.init(microphoneDeviceID: 71, output: nil))
        XCTAssertEqual(Set(micOnly.keys), [.microphone])
        XCTAssertFalse(try XCTUnwrap(micOnly[.microphone] as? MeetingMicrophoneCapture).voiceProcessing)
        if #available(macOS 14.2, *) {
            let both = try MeetingCaptureHost.devices(.init(microphoneDeviceID: 71, output: .excludingProcesses([12])))
            XCTAssertEqual(Set(both.keys), [.microphone, .output])
            XCTAssertTrue(try XCTUnwrap(both[.microphone] as? MeetingMicrophoneCapture).voiceProcessing)
            let selected = try MeetingCaptureHost.devices(.init(microphoneDeviceID: 71, output: .selectedProcesses([12])))
            XCTAssertTrue(try XCTUnwrap(selected[.microphone] as? MeetingMicrophoneCapture).voiceProcessing)
            let outputOnly = try MeetingCaptureHost.devices(.init(microphoneDeviceID: nil, output: .excludingProcesses([12])))
            XCTAssertEqual(Set(outputOnly.keys), [.output])
            XCTAssertNil(outputOnly[.microphone])
        }
    }

    func testUnchangedReferenceClientNoticeResumesAndHardwareNoticeIsInert() throws {
        let unit = FakeUnit()
        let receiver = Receiver()
        let capture = unit.capture(voiceProcessing: true)
        try capture.start(into: receiver)
        let reads = unit.referenceReads
        unit.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Output, element: 0)
        unit.emit()
        XCTAssertEqual(unit.referenceReads, reads)
        XCTAssertEqual(receiver.batches.count, 1)
        unit.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
        unit.emit()
        XCTAssertEqual(receiver.batches.count, 1, "Unverified client notice quarantines samples")
        unit.context?.verifyFormatIfNeeded()
        unit.emit()
        XCTAssertEqual(unit.referenceReads, reads + 1)
        XCTAssertEqual(receiver.batches.count, 2, "Unchanged reference client format must keep recording")
        XCTAssertTrue(receiver.failures.isEmpty)
        try capture.stop()
    }

    func testReferenceReadFailureHasItsOwnDiagnostic() throws {
        let unit = FakeUnit()
        let receiver = Receiver()
        let capture = unit.capture(voiceProcessing: true)
        try capture.start(into: receiver)
        unit.referenceReadError = MeetingAudioFailure.deviceFailure(operation: "synthetic", status: -50)
        unit.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
        unit.context?.verifyFormatIfNeeded()
        unit.emit()
        XCTAssertEqual(receiver.diagnostics.last?.code, .voiceReferenceFormatRead)
        XCTAssertTrue(receiver.batches.isEmpty)
        try capture.stop()
    }

    private final class OutputDevice: MeetingAudioCapturing {
        var starts = 0
        func start(into receiver: MeetingAudioReceiving) throws { starts += 1 }
        func stop() throws {}
    }

    func testProductionCompositionStartsPlainMicAfterVoiceStartFailureAndLogsOnce() throws {
        guard #available(macOS 14.2, *) else { return }
        let cases: [(String, MeetingAudioFailureDiagnostic.Code)] = [("start", .voiceStart), ("deviceListener", .voiceEndpointReadback)]
        for (stage, diagnostic) in cases {
            let voice = FakeUnit(), plain = FakeUnit(), output = OutputDevice()
            voice.failAt = [stage]
            voice.failureOverride = MeetingVoiceProcessingUnavailable(diagnostic: diagnostic, status: -10875)
            voice.onStart = {
                voice.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
                voice.emit() // Unchanged notice plus a failed Start still cannot publish this sample.
            }
            plain.onStart = { plain.emit() }
            var attempts: [Bool] = []
            var disposed = false
            voice.onDispose = { disposed = true }
            var logs: [String] = []
            let runtime = MeetingCaptureRuntime(factory: { selection in
                var devices = try MeetingCaptureHost.devices(selection, makeMicrophoneUnit: { processing in
                    attempts.append(processing)
                    if !processing { XCTAssertTrue(disposed, "Failed VPIO must be disposed before HAL opens") }
                    return processing ? voice : plain
                })
                devices[.output] = output
                return devices
            }, reportCaptureFailure: { logs.append($0) })
            let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true, meetingDeviceAuthorized: true)
            let selection = MeetingNativeSelection(microphoneDeviceID: 71, output: .excludingProcesses([12]))
            runtime.updateCaptureLease(until: UInt64.max)
            try runtime.prepare(selection: selection, readiness: ready, at: 0)
            XCTAssertNoThrow(try runtime.start(readiness: ready, at: 0))
            XCTAssertEqual(attempts, [true, false], "Production mic plus computer audio must attempt VPIO before HAL fallback")
            XCTAssertEqual(runtime.snapshot.state, .recording, "Unsupported VPIO must still allow exact-source recording")
            XCTAssertEqual(voice.selectedDevice, 71)
            XCTAssertEqual(plain.selectedDevice, 71)
            XCTAssertEqual(runtime.snapshot.selection, selection, "Fallback must preserve the authorized microphone and process scope")
            XCTAssertEqual(Array(voice.events.suffix(2)), ["uninitialize", "dispose"])
            XCTAssertEqual(output.starts, 1)
            XCTAssertEqual(runtime.audioDiagnostics[.microphone]?.acceptedCallbacks, 1, "Failed VPIO must publish no samples into fallback receiver")
            XCTAssertEqual(logs, ["microphone-echo-cancellation=off reason=\(diagnostic) status=-10875"])
            if runtime.snapshot.state == .recording { try runtime.pause(at: 1_000_000) }
        }
    }

    func testVoiceSuccessLogsOnOnceAndNeverCreatesFallback() throws {
        let unit = FakeUnit(), output = OutputDevice()
        var attempts: [Bool] = [], logs: [String] = []
        let runtime = MeetingCaptureRuntime(factory: { _ in
            [.microphone: MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true,
                makeUnit: { processing in attempts.append(processing); return unit }), .output: output]
        }, reportCaptureFailure: { logs.append($0) })
        let ready = MeetingNativeReadiness(permissionsGranted: true, processingReady: true, meetingDeviceAuthorized: true)
        try runtime.prepare(selection: .init(microphoneDeviceID: 71, output: .excludingProcesses([12])), readiness: ready, at: 0)
        try runtime.start(readiness: ready, at: 0)
        XCTAssertEqual(attempts, [true])
        XCTAssertEqual(logs, ["microphone-echo-cancellation=on"])
        try runtime.pause(at: 1_000_000)
    }

    func testVoiceConfigurationFailureFallsBackButSemanticAndPermissionFailuresDoNot() throws {
        let failures: [(Error, Bool)] = [
            (MeetingVoiceProcessingUnavailable(diagnostic: .voiceDucking, status: -10879), true),
            (MeetingAudioFailure.invalidSelection, false), (MeetingAudioFailure.invalidFormat, false),
            (MeetingAudioFailure.leaseExpired, false),
            (MeetingVoiceProcessingUnavailable.setupFailure(status: kAudioUnitErr_Unauthorized,
                operation: "permission", diagnostic: .voiceInitialize), false),
            (MeetingVoiceProcessingUnavailable.setupFailure(status: kAudioDevicePermissionsError,
                operation: "permission", diagnostic: .voiceStart), false),
        ]
        for (failure, fallbackAllowed) in failures {
            let voice = FakeUnit(), plain = FakeUnit()
            voice.failAt = ["output"]
            voice.failureOverride = failure
            var attempts: [Bool] = []
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true, makeUnit: { processing in
                attempts.append(processing); return processing ? voice : plain
            })
            if fallbackAllowed { try capture.start(into: Receiver()) }
            else { XCTAssertThrowsError(try capture.start(into: Receiver())) }
            XCTAssertEqual(attempts, fallbackAllowed ? [true, false] : [true], "Safety and permission failures must not select a fallback")
            if fallbackAllowed { XCTAssertEqual(plain.selectedDevice, 71) }
            try capture.stop()
        }
    }

    func testVoiceStartFailureCannotMaskReferenceOrMicrophoneLoss() throws {
        for microphoneLost in [false, true] {
            let unit = FakeUnit()
            unit.failAt = ["start"]
            unit.failureOverride = MeetingVoiceProcessingUnavailable(diagnostic: .voiceStart, status: -10875)
            unit.onStart = {
                if microphoneLost { unit.context?.deviceDidDisappear() }
                else { unit.context?.referenceDidDisappear() }
            }
            var attempts: [Bool] = []
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true, makeUnit: { processing in
                attempts.append(processing); return unit
            })
            XCTAssertThrowsError(try capture.start(into: Receiver()))
            XCTAssertEqual(attempts, [true], "Device loss must not be masked by a VPIO Start error")
            try capture.stop()
        }
    }

    func testStartupFormatSurprisesFallBackBeforeAnyVoiceSamplesAreAdmitted() throws {
        for stage in ["initial", "initialized", "reference", "input-notice", "reference-notice"] {
            let voice = FakeUnit(), plain = FakeUnit()
            switch stage {
            case "initial": voice.format.mSampleRate = 0
            case "initialized":
                voice.verifiedFormat = voice.format
                voice.verifiedFormat?.mSampleRate = 44_100
            case "reference":
                voice.referenceOutput = voice.configuredOutput
                voice.referenceOutput?.mSampleRate = 44_100
            default:
                voice.onStart = {
                    if stage == "input-notice" {
                        voice.verifiedFormat = voice.format
                        voice.verifiedFormat?.mSampleRate = 44_100
                        voice.context?.formatDidChange()
                    } else {
                        voice.referenceOutput = voice.configuredOutput
                        voice.referenceOutput?.mSampleRate = 44_100
                        voice.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
                    }
                    voice.emit()
                }
            }
            let receiver = Receiver()
            var attempts: [Bool] = []
            var disposed = false
            voice.onDispose = { disposed = true }
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true, makeUnit: { processing in
                attempts.append(processing)
                if !processing { XCTAssertTrue(disposed) }
                return processing ? voice : plain
            })
            try capture.start(into: receiver)
            XCTAssertEqual(attempts, [true, false], "Startup-only voice format surprises must retry the same mic")
            XCTAssertEqual(plain.selectedDevice, 71)
            XCTAssertTrue(receiver.batches.isEmpty, "Voice attempt must admit no samples before fallback")
            XCTAssertTrue(receiver.failures.isEmpty)
            XCTAssertEqual(capture.startupDiagnostic, "microphone-echo-cancellation=off reason=voiceClientFormat status=unavailable")
            plain.emit()
            XCTAssertEqual(receiver.batches.count, 1)
            try capture.stop()
        }
    }

    func testDefaultSpeakerChangesDuringStartupFallBackAfterDisposal() throws {
        for duringStart in [false, true] {
            let voice = FakeUnit(), plain = FakeUnit()
            if duringStart { voice.onStart = { voice.context?.defaultOutputDidChange(); voice.emit() } }
            else {
                voice.failAt = ["deviceListener"]
                voice.failureOverride = MeetingVoiceProcessingUnavailable(diagnostic: .voiceDefaultOutputChanged, status: nil)
            }
            var attempts: [Bool] = []
            var disposed = false
            voice.onDispose = { disposed = true }
            let receiver = Receiver()
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true, makeUnit: { processing in
                attempts.append(processing)
                if !processing { XCTAssertTrue(disposed) }
                return processing ? voice : plain
            })
            try capture.start(into: receiver)
            XCTAssertEqual(attempts, [true, false])
            XCTAssertEqual(plain.selectedDevice, 71)
            XCTAssertTrue(receiver.batches.isEmpty)
            XCTAssertTrue(receiver.failures.isEmpty)
            XCTAssertEqual(capture.startupDiagnostic, "microphone-echo-cancellation=off reason=voiceDefaultOutputChanged status=unavailable")
            try capture.stop()
        }
    }

    func testDefaultSpeakerChangeAfterAdmissionFailsWithoutFallback() throws {
        let unit = FakeUnit(), receiver = Receiver()
        var attempts: [Bool] = []
        let capture = MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true, makeUnit: { processing in
            attempts.append(processing); return unit
        })
        try capture.start(into: receiver)
        unit.emit()
        unit.context?.defaultOutputDidChange()
        unit.emit()
        XCTAssertEqual(receiver.batches.count, 1)
        XCTAssertEqual(receiver.failures, [.invalidSelection])
        XCTAssertEqual(receiver.diagnostics.last?.code, .voiceDefaultOutputChanged)
        XCTAssertEqual(attempts, [true], "A live route failure must not reopen capture on another path")
        try capture.stop()
    }

    func testStartupCompatibilityNeverMasksPermissionOrMicLoss() throws {
        for permissionFailure in [false, true] {
            let voice = FakeUnit(), plain = FakeUnit()
            voice.onStart = {
                voice.referenceOutput = voice.configuredOutput
                voice.referenceOutput?.mSampleRate = 44_100
                voice.context?.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
                if !permissionFailure { voice.context?.deviceDidDisappear() }
            }
            if permissionFailure {
                voice.failAt = ["start"]
                voice.failureOverride = MeetingVoiceProcessingUnavailable.setupFailure(status: kAudioUnitErr_Unauthorized,
                    operation: "permission", diagnostic: .voiceStart)
            }
            var attempts: [Bool] = []
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true, makeUnit: { processing in
                attempts.append(processing); return processing ? voice : plain
            })
            XCTAssertThrowsError(try capture.start(into: Receiver()))
            XCTAssertEqual(attempts, [true])
            try capture.stop()
        }
    }

    func testFailedVoiceCleanupNeverOpensFallback() throws {
        for stage in ["stop", "uninitialize", "dispose"] {
            let unit = FakeUnit()
            unit.failAt = ["start", stage]
            unit.failureOverride = MeetingVoiceProcessingUnavailable(diagnostic: .voiceStart, status: -10875)
            var attempts: [Bool] = []
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 71, voiceProcessing: true, makeUnit: { processing in
                attempts.append(processing); return unit
            })
            XCTAssertThrowsError(try capture.start(into: Receiver())) {
                XCTAssertEqual($0 as? MeetingAudioFailure, .cleanupFailed)
            }
            XCTAssertEqual(attempts, [true], "Cleanup failure must never open a second unit")
            unit.failAt = []
            try capture.stop()
        }
    }

    func testUnknownSelectedDeviceFailsWithoutOpeningAUnit() {
        let unit = FakeUnit()
        let capture = unit.capture(device: kAudioObjectUnknown)
        XCTAssertThrowsError(try capture.start(into: Receiver())) {
            XCTAssertEqual($0 as? MeetingAudioFailure, .invalidSelection)
        }
        XCTAssertTrue(unit.events.isEmpty)
    }

    func testDuplicateStartDoesNotOpenAnotherUnit() throws {
        let unit = FakeUnit()
        let capture = unit.capture()
        try capture.start(into: Receiver())
        XCTAssertThrowsError(try capture.start(into: Receiver())) {
            XCTAssertEqual($0 as? MeetingAudioFailure, .invalidTransition)
        }
        XCTAssertEqual(unit.events, FakeUnit.startup)
        try capture.stop()
    }

    func testEveryStartupFailureRollsBackOnlyAcquiredResourcesInReverseOrder() throws {
        for (index, stage) in FakeUnit.startup.enumerated() {
            let unit = FakeUnit()
            unit.failAt = [stage]
            let capture = unit.capture()
            XCTAssertThrowsError(try capture.start(into: Receiver()), stage) {
                XCTAssertEqual($0 as? MeetingAudioFailure, .deviceFailure(operation: stage, status: -99))
            }
            var expected = Array(FakeUnit.startup.prefix(index + 1))
            if stage == "start" { expected.append("stop") }
            if index > FakeUnit.startup.firstIndex(of: "initialize")! { expected.append("uninitialize") }
            if stage != "create" { expected.append("dispose") }
            XCTAssertEqual(unit.events, expected, stage)
            XCTAssertNil(unit.context, stage)
            let afterRollback = unit.events
            try capture.stop()
            XCTAssertEqual(unit.events, afterRollback, stage)
        }
    }

    func testInvalidHardwareFormatsFailBeforeRegisteringCallbacks() {
        for invalidCase in 0..<5 {
            let unit = FakeUnit()
            switch invalidCase {
            case 0: unit.format.mSampleRate = 0
            case 1: unit.format.mSampleRate = .nan
            case 2: unit.format.mSampleRate = .infinity
            case 3: unit.format.mChannelsPerFrame = 0
            default: unit.format.mFormatID = 0
            }
            let capture = unit.capture()
            XCTAssertThrowsError(try capture.start(into: Receiver())) {
                XCTAssertEqual($0 as? MeetingAudioFailure, .invalidFormat)
            }
            XCTAssertEqual(unit.events.last, "dispose")
            XCTAssertFalse(unit.events.contains("callback"))
        }
    }

    func testUnboundedOrEmptyHardwareSliceFailsBeforeAllocation() {
        for capacity in [UInt32(0), MeetingMicrophoneCapture.maximumBufferedFrames + 1, UInt32.max] {
            let unit = FakeUnit()
            unit.capacity = capacity
            let capture = unit.capture()
            XCTAssertThrowsError(try capture.start(into: Receiver())) {
                XCTAssertEqual($0 as? MeetingAudioFailure, .bufferFull)
            }
            XCTAssertFalse(unit.events.contains("callback"))
        }
    }

    func testInitializationCannotSilentlyChangeRateOrRequiredBufferCapacity() {
        for changesRate in [true, false] {
            let unit = FakeUnit()
            if changesRate {
                var changed = unit.format
                changed.mSampleRate = 44_100
                unit.verifiedFormat = changed
            } else {
                unit.verifiedCapacity = unit.capacity + 1
            }
            let capture = unit.capture()
            XCTAssertThrowsError(try capture.start(into: Receiver())) {
                XCTAssertEqual($0 as? MeetingAudioFailure, changesRate ? .invalidFormat : .bufferFull)
            }
            XCTAssertEqual(Array(unit.events.suffix(2)), ["uninitialize", "dispose"])
            XCTAssertFalse(unit.events.contains("start"))
        }
    }

    func testUnchangedFormatNotificationDuringStartupAllowsStart() throws {
        let unit = FakeUnit()
        unit.onListener = { [weak unit] in unit?.context?.formatDidChange() }
        let capture = unit.capture()
        try capture.start(into: Receiver())
        XCTAssertTrue(unit.events.contains("start"))
        XCTAssertGreaterThan(unit.formatReads, 2)
        try capture.stop()
    }

    func testStopFailureRetainsContextAndBlocksRestartUntilRetry() throws {
        let unit = FakeUnit()
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        weak var context = unit.context
        unit.failAt = ["stop"]
        XCTAssertThrowsError(try capture.stop())
        XCTAssertNotNil(context)
        XCTAssertFalse(unit.events.contains("uninitialize"))
        XCTAssertFalse(unit.events.contains("dispose"))
        XCTAssertThrowsError(try capture.start(into: Receiver()))
        unit.emit()
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertEqual(unit.renderCount, 0)
        unit.failAt = []
        try capture.stop()
        XCTAssertNil(context)
        XCTAssertEqual(Array(unit.events.suffix(3)), ["stop", "uninitialize", "dispose"])
    }

    func testUninitializeAndDisposeFailuresRetainContextForStageSpecificRetry() throws {
        for stage in ["uninitialize", "dispose"] {
            let unit = FakeUnit()
            let capture = unit.capture()
            try capture.start(into: Receiver())
            weak var context = unit.context
            unit.failAt = [stage]
            XCTAssertThrowsError(try capture.stop())
            XCTAssertNotNil(context)
            unit.failAt = []
            let previousEvents = unit.events.count
            try capture.stop()
            let expected = stage == "uninitialize" ? ["uninitialize", "dispose"] : ["dispose"]
            XCTAssertEqual(Array(unit.events.dropFirst(previousEvents)), expected)
            XCTAssertNil(context)
        }
    }

    func testFailedStartupWithFailedCleanupSurfacesCleanupFailureAndCanRetry() throws {
        let unit = FakeUnit()
        unit.failAt = ["start", "stop"]
        let capture = unit.capture()
        XCTAssertThrowsError(try capture.start(into: Receiver())) {
            XCTAssertEqual($0 as? MeetingAudioFailure, .cleanupFailed)
        }
        XCTAssertNotNil(unit.context)
        unit.failAt = []
        try capture.stop()
        XCTAssertNil(unit.context)
    }

    func testSamplesAreCopiedAndHardwareClockIsConvertedWithoutBorrowingStorage() throws {
        let unit = FakeUnit()
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        XCTAssertEqual(unit.emit(), noErr)
        unit.sampleOffset = 10
        XCTAssertEqual(unit.emit(at: 200, frames: 2), noErr)
        XCTAssertEqual(receiver.batches.map(\.samples), [[0, 1, 2], [10, 11]])
        XCTAssertEqual(receiver.batches.map(\.hostTime), [1_000, 2_000])
        XCTAssertEqual(receiver.batches.map(\.sampleRate), [48_000, 48_000])
        XCTAssertEqual(unit.lastTimestamp, 200)
        XCTAssertEqual(unit.lastFlags, AudioUnitRenderActionFlags())
        try capture.stop()
    }

    func testLateCallbacksAfterStopCannotRenderOrDeliver() throws {
        let unit = FakeUnit()
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        let savedContext = try XCTUnwrap(unit.context)
        try capture.stop()
        unit.emit(to: savedContext)
        savedContext.formatDidChange()
        XCTAssertEqual(unit.renderCount, 0)
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertTrue(receiver.failures.isEmpty)
    }

    func testOversizedAndEmptyCallbacksFailBeforeRenderingAndCloseAdmission() throws {
        for frames in [UInt32(0), 9, UInt32.max] {
            let unit = FakeUnit()
            let capture = unit.capture()
            let receiver = Receiver()
            try capture.start(into: receiver)
            XCTAssertEqual(unit.emit(frames: frames), kAudioUnitErr_TooManyFramesToProcess)
            unit.emit(at: 200)
            XCTAssertEqual(unit.renderCount, 0)
            XCTAssertEqual(receiver.failures, [.bufferFull])
            XCTAssertTrue(receiver.batches.isEmpty)
            try capture.stop()
        }
    }

    func testMissingHardwareClockFlagsFailClosed() throws {
        for missingHost in [true, false] {
            let unit = FakeUnit()
            let capture = unit.capture()
            let receiver = Receiver()
            try capture.start(into: receiver)
            unit.emit(validHostTime: !missingHost, validSampleTime: missingHost)
            unit.emit(at: 200)
            XCTAssertEqual(receiver.failures, [.invalidTimestamp])
            XCTAssertEqual(unit.renderCount, 0)
            XCTAssertTrue(receiver.batches.isEmpty)
            try capture.stop()
        }
    }

    func testSampleClockIsForwardedDespiteHarmlessHostJitter() throws {
        let unit = FakeUnit(), receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        unit.emit(at: 100)
        unit.emit(at: 99)
        XCTAssertEqual(receiver.receivedSampleTimes, [0, 3])
        XCTAssertTrue(receiver.failures.isEmpty)
        try capture.stop()
    }

    func testRenderFailureIsReportedOnceAndNoSamplesEscape() throws {
        let unit = FakeUnit()
        unit.renderStatus = -77
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        XCTAssertEqual(unit.emit(), -77)
        unit.emit(at: 200)
        XCTAssertEqual(receiver.failures, [.deviceFailure(operation: "AudioUnitRender", status: -77)])
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }

    func testUnexpectedRenderedBufferShapeFailsClosed() throws {
        for corruption in 0..<4 {
            let unit = FakeUnit()
            unit.corruptBuffer = { buffer in
                switch corruption {
                case 0: buffer.pointee.mNumberBuffers = 2
                case 1: buffer.pointee.mBuffers.mNumberChannels = 2
                case 2: buffer.pointee.mBuffers.mDataByteSize = 0
                default: buffer.pointee.mBuffers.mData = nil
                }
            }
            let capture = unit.capture()
            let receiver = Receiver()
            try capture.start(into: receiver)
            unit.emit()
            unit.emit(at: 200)
            XCTAssertEqual(receiver.failures, [.invalidFormat])
            XCTAssertTrue(receiver.batches.isEmpty)
            XCTAssertEqual(unit.renderCount, 1)
            try capture.stop()
        }
    }

    func testFormatChangeDuringRenderRejectsTheInFlightBatchAndLaterCallbacks() throws {
        let unit = FakeUnit()
        unit.onRender = { [weak unit] in
            guard let unit else { return }
            var changed = unit.format
            changed.mSampleRate = 44_100
            unit.verifiedFormat = changed
            unit.context?.formatDidChange()
            // Explicit synthetic control-plane recheck races the in-flight render.
            unit.context?.verifyFormatIfNeeded()
        }
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        unit.emit()
        unit.emit(at: 200)
        XCTAssertEqual(receiver.failures, [.invalidFormat])
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }

    func testOverlappingRenderReportsDroppedIntervalWithoutPausing() throws {
        let unit = FakeUnit()
        unit.onRender = { [weak unit] in _ = unit?.emit(at: 200) }
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        unit.emit()
        XCTAssertTrue(receiver.failures.isEmpty)
        XCTAssertEqual(receiver.droppedSampleTimes, [3])
        XCTAssertEqual(receiver.batches.count, 1)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }
    func testUnplugDuringRenderRejectsInFlightAudioAndDoesNotSwitchDevices() throws {
        let unit = FakeUnit()
        unit.onRender = { [weak unit] in unit?.context?.deviceDidDisappear() }
        let capture = unit.capture(device: 71)
        let receiver = Receiver()
        try capture.start(into: receiver)
        unit.emit()
        unit.emit(at: 200)
        XCTAssertEqual(receiver.failures, [.invalidSelection])
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertEqual(unit.renderCount, 1)
        XCTAssertEqual(unit.selectedDevice, 71)
        try capture.stop()
    }

    func testDeviceNotificationAfterStopCannotAffectNewReceiver() throws {
        let unit = FakeUnit()
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        let old = try XCTUnwrap(unit.context)
        try capture.stop()
        old.deviceDidDisappear()
        old.formatDidChange()
        XCTAssertTrue(receiver.failures.isEmpty)
        XCTAssertEqual(unit.emit(to: old), noErr)
        XCTAssertTrue(receiver.batches.isEmpty)
    }

    func testHardwareRateOutsideWireRangeFailsBeforeCallbackInstallation() {
        for rate in [7999.0, 192001.0] {
            let unit = FakeUnit()
            unit.format.mSampleRate = rate
            let capture = unit.capture()
            XCTAssertThrowsError(try capture.start(into: Receiver()))
            XCTAssertFalse(unit.events.contains("callback"))
        }
    }

    func testFormatNoticeNeverQueriesHardwareInsideTheNotification() throws {
        let unit = FakeUnit(), receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        let reads = unit.formatReads
        unit.context?.formatDidChange()
        XCTAssertEqual(unit.formatReads, reads)
        unit.context?.verifyFormatIfNeeded()
        XCTAssertEqual(unit.formatReads, reads + 1)
        unit.emit()
        XCTAssertTrue(receiver.failures.isEmpty)
        XCTAssertEqual(receiver.batches.count, 1)
        try capture.stop()
    }

    func testActualOutputFormatChangeClosesAdmissionEvenWhenInputIsUnchanged() throws {
        let unit = FakeUnit(), receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        unit.configuredOutput.mSampleRate = 44_100
        unit.context?.formatDidChange()
        unit.context?.verifyFormatIfNeeded()
        unit.emit()
        XCTAssertEqual(receiver.failures, [.invalidFormat])
        XCTAssertEqual(unit.renderCount, 0)
        try capture.stop()
    }

    func testPendingFormatNoticeQuarantinesCallbacksUntilUnchangedFormatIsVerified() throws {
        let unit = FakeUnit(), receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        unit.context?.formatDidChange()
        unit.emit()
        XCTAssertEqual(unit.renderCount, 0)
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertEqual(receiver.droppedSampleTimes, [0])
        XCTAssertTrue(receiver.failures.isEmpty)
        unit.context?.verifyFormatIfNeeded()
        unit.emit(at: 200)
        XCTAssertEqual(receiver.receivedSampleTimes, [3])
        XCTAssertTrue(receiver.failures.isEmpty)
        try capture.stop()
    }

    func testUnchangedNoticeDuringRenderDropsOnlyThatCallbackWithoutPausing() throws {
        let unit = FakeUnit(), receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        unit.onRender = { [weak unit] in unit?.context?.formatDidChange() }
        unit.emit()
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertEqual(receiver.droppedSampleTimes, [0])
        unit.onRender = nil
        unit.context?.verifyFormatIfNeeded()
        unit.emit(at: 200)
        XCTAssertEqual(receiver.receivedSampleTimes, [3])
        XCTAssertTrue(receiver.failures.isEmpty)
        try capture.stop()
    }

    func testNoticeDuringVerificationRequiresAnotherReadBeforeCallbackAdmission() throws {
        let unit = FakeUnit(), receiver = Receiver()
        let capture = unit.capture()
        try capture.start(into: receiver)
        unit.onFormatRead = { [weak unit] in
            unit?.context?.formatDidChange()
            unit?.context?.verifyFormatIfNeeded() // Reentrant control check must not clear quarantine.
        }
        unit.context?.formatDidChange()
        let before = unit.formatReads
        unit.context?.verifyFormatIfNeeded()
        XCTAssertEqual(unit.formatReads, before + 1)
        unit.emit()
        XCTAssertTrue(receiver.batches.isEmpty)
        unit.onFormatRead = nil
        unit.context?.verifyFormatIfNeeded()
        unit.emit(at: 200)
        XCTAssertEqual(receiver.receivedSampleTimes, [3])
        XCTAssertTrue(receiver.failures.isEmpty)
        try capture.stop()
    }

}
