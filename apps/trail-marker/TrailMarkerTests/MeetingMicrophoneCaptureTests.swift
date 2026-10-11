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
        var onStop: (() -> Void)?
        var referenceSelections: [AudioDeviceID] = []
        var verifyReference: ((AudioDeviceID) throws -> Void)?
        var onInitialize: (() -> Void)?
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
        var initializationAttempted = false
        var measurementsBefore: MeetingMicrophoneStartupMeasurements?
        var measurementsAfter: MeetingMicrophoneStartupMeasurements?
        var measurementError: Error?
        var measurementReads = 0
        var lastFlags: AudioUnitRenderActionFlags?
        var lastTimestamp: UInt64?

        func step(_ name: String) throws {
            events.append(name)
            if failAt.contains(name) {
                throw failureOverride ?? MeetingAudioFailure.deviceFailure(operation: name, status: -99)
            }
        }

        func capture(device: AudioDeviceID = 42, voiceProcessing: Bool = false,
                     diagnosticSink: @escaping (MeetingMicrophoneStartupDiagnostic) -> Void = { _ in }) -> MeetingMicrophoneCapture {
            MeetingMicrophoneCapture(
                selectedDeviceID: device, voiceProcessing: voiceProcessing,
                makeUnit: { _ in try self.step("create"); return self },
                hostTimeToNanoseconds: { $0 * 10 }, diagnosticSink: diagnosticSink
            )
        }

        func enableInput() throws { try step("input") }
        func configureOutput() throws { try step("output") }
        func selectReferenceDevice(_ deviceID: AudioDeviceID) throws {
            referenceSelections.append(deviceID)
            try verifyReference?(deviceID)
        }
        func selectDevice(_ deviceID: AudioDeviceID) throws { try step("device"); selectedDevice = deviceID }
        func inputFormat() throws -> AudioStreamBasicDescription {
            formatReads += 1
            try step(formatReads == 1 ? "format" : "verifyFormat")
            onFormatRead?()
            return formatReads == 1 ? format : (verifiedFormat ?? format)
        }
        var referenceOutput: AudioStreamBasicDescription?
        var referenceReadError: Error?
        var outputReadError: Error?
        var referenceReads = 0
        func referenceFormat() throws -> AudioStreamBasicDescription? {
            referenceReads += 1
            if let referenceReadError { throw referenceReadError }
            return referenceOutput ?? configuredOutput
        }
        func outputFormat() throws -> AudioStreamBasicDescription {
            if let outputReadError { throw outputReadError }
            return configuredOutput
        }
        func configureMonoOutput(sampleRate: Double) throws {
            try step("mono"); configuredRate = sampleRate; configuredOutput.mSampleRate = sampleRate
        }
        func maximumFramesPerSlice() throws -> UInt32 {
            capacityReads += 1
            try step(capacityReads == 1 ? "capacity" : "verifyCapacity")
            return capacityReads == 1 ? capacity : (verifiedCapacity ?? capacity)
        }
        func startupMeasurements() throws -> MeetingMicrophoneStartupMeasurements {
            measurementReads += 1
            if let measurementError { throw measurementError }
            if let measurements = initializationAttempted ? measurementsAfter : measurementsBefore { return measurements }
            return MeetingMicrophoneStartupMeasurements(
                maximumFramesPerSlice: initializationAttempted ? (verifiedCapacity ?? capacity) : capacity,
                inputSampleRate: format.mSampleRate, clientSampleRate: configuredOutput.mSampleRate,
                referenceSampleRate: referenceOutput?.mSampleRate)
        }
        func installInputCallback(_ context: MeetingMicrophoneRenderContext) throws {
            // Emulate partial registration: even a failing install can retain the context.
            self.context = context
            try step("callback")
        }
        func initialize() throws { initializationAttempted = true; onInitialize?(); try step("initialize") }
        func installFormatListener(_ context: MeetingMicrophoneRenderContext) throws {
            try step("listener")
            onListener?()
        }
        func installDeviceListener(_ context: MeetingMicrophoneRenderContext) throws { try step("deviceListener") }
        func start() throws { onStart?(); try step("start") }
        func stop() throws { onStop?(); try step("stop") }
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
        XCTAssertEqual(receiver.failures, [.sourceReconfigured])
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
            }, reportCaptureDiagnostic: { logs.append($0) })
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
        }, reportCaptureDiagnostic: { logs.append($0) })
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
        for processing in [false, true] {
            for capacity in [UInt32(0), MeetingMicrophoneCapture.maximumBufferedFrames + 1, UInt32.max] {
                let unit = FakeUnit()
                unit.capacity = capacity
                let capture = unit.capture(voiceProcessing: processing)
                XCTAssertThrowsError(try capture.start(into: Receiver())) {
                    XCTAssertEqual($0 as? MeetingAudioFailure, .bufferFull)
                }
                XCTAssertFalse(unit.events.contains("callback"))
                XCTAssertEqual(unit.events.filter { $0 == "create" }.count, 1, "Invalid capacity must not select HAL fallback")
                XCTAssertNil(unit.context)
            }
        }
    }

    func testHALInitializationCannotSilentlyChangeRateOrRequiredBufferCapacity() {
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

    func testConcreteVoiceSetupFailuresFallBackAfterCleanupAndPreservePermissionFailures() throws {
        typealias Step = (String, AudioUnitPropertyID, AudioUnitScope, AudioUnitElement,
                          MeetingAudioFailureDiagnostic.Code, (MeetingMicrophoneIOUnit) throws -> Void)
        let context = MeetingMicrophoneRenderContext(unit: FakeUnit(), receiver: Receiver(),
            format: FakeUnit().format, capacity: 8, hostTimeToNanoseconds: { $0 })
        let steps: [Step] = [
            ("buffer ownership", kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, .voiceBufferOwnership,
             { try $0.configureMonoOutput(sampleRate: 48000) }),
            ("input callback", kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, .voiceInputCallback,
             { try $0.installInputCallback(context) }),
            ("input format", kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, .voiceClientFormat,
             { _ = try $0.inputFormat() }),
            ("output format", kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, .voiceClientFormat,
             { _ = try $0.outputFormat() }),
            ("reference format", kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, .voiceReferenceFormatRead,
             { _ = try $0.referenceFormat() }),
            ("maximum frames", kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, .voiceMaximumFrames,
             { _ = try $0.maximumFramesPerSlice() }),
            ("microphone readback", kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 1, .voiceEndpointReadback,
             { _ = try $0.currentDevice(bus: 1) }),
            ("reference readback", kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, .voiceEndpointReadback,
             { _ = try $0.currentDevice(bus: 0) }),
        ]
        for (name, property, scope, bus, label, operation) in steps {
            for status in [kAudioUnitErr_InvalidProperty, kAudioUnitErr_Unauthorized, kAudioDevicePermissionsError,
                           kAudioHardwareBadDeviceError, kAudioHardwareBadObjectError] {
                let native = MeetingMicrophoneIOUnit(voiceProcessing: true, propertySet: { p, s, b, _, _ in
                    p == property && s == scope && b == bus ? status : noErr
                }, propertyGet: { p, s, b, _, _ in
                    p == property && s == scope && b == bus ? status : noErr
                })
                var failure: Error?
                XCTAssertThrowsError(try operation(native), name) { failure = $0 }
                try native.dispose()
                let error = try XCTUnwrap(failure, name)
                let permitted = status == kAudioUnitErr_InvalidProperty
                XCTAssertEqual((error as? MeetingVoiceProcessingUnavailable)?.diagnostic, permitted ? label : nil,
                    "Direct VPIO setup must classify capability errors for fallback")
                if !permitted { XCTAssertEqual(MeetingAudioFailureDiagnostic.status(error), status, name) }

                let voice = FakeUnit(), plain = FakeUnit(), receiver = Receiver()
                voice.failAt = ["initialize"]
                voice.failureOverride = error
                var modes: [Bool] = []
                let capture = MeetingMicrophoneCapture(selectedDeviceID: 42, voiceProcessing: true, makeUnit: { mode in
                    modes.append(mode)
                    if !mode {
                        XCTAssertEqual(voice.events.last, "dispose", name)
                        XCTAssertNil(voice.context, name)
                        XCTAssertTrue(receiver.batches.isEmpty, name)
                        XCTAssertTrue(receiver.failures.isEmpty, name)
                    }
                    return mode ? voice : plain
                })
                if permitted {
                    XCTAssertNoThrow(try capture.start(into: receiver),
                        "Every direct VPIO setup capability failure must reach the cleaned-up same-mic fallback")
                    XCTAssertEqual(modes, [true, false], name)
                    XCTAssertEqual(plain.selectedDevice, 42, name)
                    plain.emit()
                    XCTAssertEqual(receiver.batches.count, 1, name)
                } else {
                    XCTAssertThrowsError(try capture.start(into: receiver), name)
                    XCTAssertEqual(modes, [true], name)
                    XCTAssertTrue(receiver.batches.isEmpty, name)
                }
                try capture.stop()
            }
        }
    }

    func testMalformedVoiceReadbackCanFallBackButActualReferenceLossCannot() throws {
        for processing in [false, true] {
            let native = MeetingMicrophoneIOUnit(voiceProcessing: processing, propertySet: { _, _, _, _, _ in noErr },
                propertyGet: { _, _, _, _, size in size.pointee = 0; return noErr })
            XCTAssertThrowsError(try native.currentDevice(bus: 1)) {
                XCTAssertEqual($0 is MeetingVoiceProcessingUnavailable, processing)
            }
            try native.dispose()
        }
        XCTAssertFalse(try MeetingMicrophoneIOUnit.validateReferenceAliveRead(status: noErr, size: 4, alive: 0))
        XCTAssertTrue(try MeetingMicrophoneIOUnit.validateReferenceAliveRead(status: noErr, size: 4, alive: 1))
        for status in [kAudioUnitErr_InvalidProperty, kAudioUnitErr_Unauthorized, kAudioDevicePermissionsError,
                           kAudioHardwareBadDeviceError, kAudioHardwareBadObjectError] {
            let referenceFailure = MeetingMicrophoneIOUnit.referenceSetupError(
                MeetingAudioFailure.deviceFailure(operation: "read default output", status: status))
            XCTAssertEqual(referenceFailure is MeetingVoiceProcessingUnavailable, status == kAudioUnitErr_InvalidProperty)
            XCTAssertEqual(MeetingAudioFailureDiagnostic.status(referenceFailure), status)
            XCTAssertThrowsError(try MeetingMicrophoneIOUnit.validateReferenceAliveRead(status: status, size: 4, alive: 1)) {
                XCTAssertEqual($0 is MeetingVoiceProcessingUnavailable, status == kAudioUnitErr_InvalidProperty)
            }
        }
        XCTAssertEqual(MeetingMicrophoneIOUnit.referenceSetupError(MeetingAudioFailure.invalidSelection) as? MeetingAudioFailure,
                       .invalidSelection, "A missing default output is actual source loss, not compatibility")
        XCTAssertFalse(MeetingMicrophoneIOUnit.referenceSetupError(NSError(domain: "unknown", code: -1)) is MeetingVoiceProcessingUnavailable)
        XCTAssertThrowsError(try MeetingMicrophoneIOUnit.validateReferenceAliveRead(status: noErr, size: 0, alive: 1)) {
            XCTAssertTrue($0 is MeetingVoiceProcessingUnavailable)
        }
    }

    func testCapabilityReadsBeforeAdmissionFallBackButPermissionReadsDoNot() throws {
        for reference in [false, true] {
            for permitted in [false, true] {
                let voice = FakeUnit(), plain = FakeUnit(), receiver = Receiver()
                let error: Error
                if permitted { error = MeetingVoiceProcessingUnavailable(diagnostic: .voiceClientFormat, status: kAudioUnitErr_InvalidProperty) }
                else { error = MeetingAudioFailure.deviceFailure(operation: "read format", status: kAudioUnitErr_Unauthorized) }
                if reference { voice.referenceReadError = error }
                else {
                    voice.outputReadError = error
                    voice.onListener = { [weak voice] in voice?.context?.formatDidChange() }
                }
                var modes: [Bool] = []
                let capture = MeetingMicrophoneCapture(selectedDeviceID: 42, voiceProcessing: true, makeUnit: { mode in
                    modes.append(mode)
                    if !mode { XCTAssertEqual(voice.events.last, "dispose"); XCTAssertNil(voice.context) }
                    return mode ? voice : plain
                })
                if permitted {
                    XCTAssertNoThrow(try capture.start(into: receiver), "A pre-admission capability read may use the clean same-mic fallback")
                    XCTAssertEqual(modes, [true, false])
                    XCTAssertTrue(capture.startupDiagnostic?.contains("status=-10879") == true)
                    XCTAssertEqual(plain.selectedDevice, 42)
                } else {
                    XCTAssertThrowsError(try capture.start(into: receiver))
                    XCTAssertEqual(modes, [true], "Permission read failure must not trigger compatibility fallback")
                }
                XCTAssertTrue(receiver.batches.isEmpty)
                XCTAssertTrue(receiver.failures.isEmpty)
                try capture.stop()
            }
        }
    }

    func testCapabilityReadAfterAdmissionPausesWithoutFallback() throws {
        for reference in [false, true] {
            let unit = FakeUnit(), receiver = Receiver()
            var modes: [Bool] = []
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 42, voiceProcessing: true, makeUnit: { mode in
                modes.append(mode); return unit
            })
            try capture.start(into: receiver)
            let context = try XCTUnwrap(unit.context)
            let error = MeetingVoiceProcessingUnavailable(diagnostic: .voiceClientFormat, status: kAudioUnitErr_InvalidProperty)
            if reference {
                unit.referenceReadError = error
                context.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
            } else {
                unit.outputReadError = error
                context.formatDidChange()
            }
            context.verifyFormatIfNeeded()
            XCTAssertEqual(receiver.failures, [.invalidFormat])
            XCTAssertEqual(receiver.diagnostics.last?.status, kAudioUnitErr_InvalidProperty)
            XCTAssertEqual(modes, [true], "An admitted recording must never switch to fallback on a read failure")
            unit.emit()
            XCTAssertTrue(receiver.batches.isEmpty)
            try capture.stop()
        }
    }

    func testObservedMacStartupMaximumGrowthKeepsFirst512FrameCallback() throws {
        // Live proof 6065930437: maxima 512 -> 960; the observed first callback was 512, not 960.
        let unit = FakeUnit(), receiver = Receiver()
        unit.capacity = 512
        unit.verifiedCapacity = 960
        var diagnostics: [MeetingMicrophoneStartupDiagnostic] = []
        let capture = unit.capture(voiceProcessing: true, diagnosticSink: { diagnostics.append($0) })
        XCTAssertNoThrow(try capture.start(into: receiver), "The observed Mac startup maxima must fit the reserved buffer")
        XCTAssertEqual(unit.emit(frames: 512), noErr)
        try capture.stop()
        XCTAssertEqual(receiver.batches.first?.samples.count, 512)
        XCTAssertTrue(receiver.failures.isEmpty)
        XCTAssertEqual(diagnostics.first?.before.maximumFramesPerSlice, 512)
        XCTAssertEqual(diagnostics.first?.after.maximumFramesPerSlice, 960)
        XCTAssertEqual(diagnostics.first?.firstCallbackFrameCount, 512)
    }

    func testSyntheticVoiceInitializationGrowthFitsReservedCallbackCeiling() throws {
        // Synthetic sizes, not hardware measurements. The hard ceiling remains 8192.
        let sizes: [(UInt32, UInt32)] = [(128, 512), (512, 4096), (4096, 8192)]
        for (before, after) in sizes {
            let unit = FakeUnit(), receiver = Receiver()
            unit.capacity = before
            unit.verifiedCapacity = after
            let capture = unit.capture(voiceProcessing: true)
            XCTAssertNoThrow(try capture.start(into: receiver),
                "Voice processing must reserve the bounded callback ceiling across initialization growth")
            guard unit.context != nil else { continue }
            XCTAssertEqual(unit.emit(frames: after), noErr)
            XCTAssertEqual(receiver.batches.count, 1)
            XCTAssertEqual(receiver.batches.first?.samples.count, Int(after))
            XCTAssertTrue(receiver.failures.isEmpty)
            try capture.stop()
        }
    }

    func testVoicePostInitializeMaximumStillRejectsZeroAndAboveCeilingWithoutFallback() {
        for capacity in [UInt32(0), MeetingMicrophoneCapture.maximumBufferedFrames + 1, UInt32.max] {
            let unit = FakeUnit()
            unit.verifiedCapacity = capacity
            let capture = unit.capture(voiceProcessing: true)
            XCTAssertThrowsError(try capture.start(into: Receiver())) {
                XCTAssertEqual($0 as? MeetingAudioFailure, .bufferFull)
            }
            XCTAssertFalse(unit.events.contains("start"))
            XCTAssertEqual(Array(unit.events.suffix(2)), ["uninitialize", "dispose"])
            XCTAssertEqual(unit.events.filter { $0 == "create" }.count, 1)
            XCTAssertNil(unit.context)
        }
    }

    func testVoiceRuntimeCallbackAndCapacityVerificationKeepExistingCeiling() throws {
        for verifyProperty in [false, true] {
            let unit = FakeUnit(), receiver = Receiver()
            let capture = unit.capture(voiceProcessing: true)
            try capture.start(into: receiver)
            let context = try XCTUnwrap(unit.context)
            // A supported increase after Start fits the same preallocated storage.
            unit.verifiedCapacity = MeetingMicrophoneCapture.maximumBufferedFrames
            context.formatDidChange()
            context.verifyFormatIfNeeded()
            XCTAssertEqual(unit.emit(frames: MeetingMicrophoneCapture.maximumBufferedFrames), noErr)
            XCTAssertTrue(receiver.failures.isEmpty)
            if verifyProperty {
                unit.verifiedCapacity = MeetingMicrophoneCapture.maximumBufferedFrames + 1
                context.formatDidChange()
                context.verifyFormatIfNeeded()
            } else {
                XCTAssertEqual(unit.emit(frames: MeetingMicrophoneCapture.maximumBufferedFrames + 1),
                               kAudioUnitErr_TooManyFramesToProcess)
            }
            XCTAssertEqual(receiver.failures, [.bufferFull])
            XCTAssertEqual(receiver.diagnostics.last?.code,
                           verifyProperty ? .microphoneCapacityVerification : .microphoneFrameCapacity)
            XCTAssertEqual(unit.renderCount, 1, "Oversized callbacks must not reach AudioUnitRender")
            try capture.stop()
        }
    }

    func testNumericStartupDiagnosticsPublishActualFirstCallbackOnceWithoutFormatNotices() throws {
        let unit = FakeUnit(), receiver = Receiver()
        var diagnostics: [MeetingMicrophoneStartupDiagnostic] = []
        unit.capacity = 128
        unit.verifiedCapacity = 8192
        unit.measurementsBefore = MeetingMicrophoneStartupMeasurements(
            inputSampleRate: 48000, clientSampleRate: 48000, referenceSampleRate: 48000,
            microphone: .init(bufferFrameSize: 128, nominalSampleRate: 48000),
            reference: .init(bufferFrameSize: 256, nominalSampleRate: 44100))
        unit.measurementsAfter = MeetingMicrophoneStartupMeasurements(
            inputSampleRate: 48000, clientSampleRate: 48000, referenceSampleRate: 48000,
            microphone: .init(bufferFrameSize: 512, nominalSampleRate: 48000),
            reference: .init(bufferFrameSize: 1024, nominalSampleRate: 48000))
        let capture = unit.capture(voiceProcessing: true, diagnosticSink: { diagnostics.append($0) })
        try capture.start(into: receiver)
        let context = try XCTUnwrap(unit.context)
        context.verifyFormatIfNeeded()
        XCTAssertTrue(diagnostics.isEmpty, "No callback count may be invented at Start")
        unit.emit(frames: 512)
        XCTAssertTrue(diagnostics.isEmpty, "The audio callback must not invoke the diagnostic sink")
        context.verifyFormatIfNeeded()
        unit.emit(frames: 1024)
        context.verifyFormatIfNeeded()
        try capture.stop()
        try capture.stop()
        XCTAssertEqual(diagnostics.count, 1)
        let diagnostic = try XCTUnwrap(diagnostics.first)
        XCTAssertTrue(diagnostic.voiceProcessing)
        XCTAssertEqual(diagnostic.before.maximumFramesPerSlice, 128)
        XCTAssertEqual(diagnostic.after.maximumFramesPerSlice, 8192)
        XCTAssertEqual(diagnostic.allocationFrames, 8192)
        XCTAssertEqual(diagnostic.firstCallbackFrameCount, 512)
        XCTAssertEqual(diagnostic.before.microphone, unit.measurementsBefore?.microphone)
        XCTAssertEqual(diagnostic.after.microphone, unit.measurementsAfter?.microphone)
        XCTAssertEqual(diagnostic.before.reference, unit.measurementsBefore?.reference)
        XCTAssertEqual(diagnostic.after.reference, unit.measurementsAfter?.reference)
        XCTAssertEqual(unit.measurementReads, 2)
    }

    func testNumericDiagnosticsRecordPreAdmissionCallbacksIncludingActualZeroOnFailure() throws {
        for frames in [UInt32(0), UInt32(1024)] {
            let unit = FakeUnit(), receiver = Receiver()
            var diagnostics: [MeetingMicrophoneStartupDiagnostic] = []
            unit.onInitialize = { [weak unit] in unit?.emit(frames: frames) }
            unit.failAt = ["initialize"]
            let capture = unit.capture(voiceProcessing: true, diagnosticSink: { diagnostics.append($0) })
            XCTAssertThrowsError(try capture.start(into: receiver))
            XCTAssertEqual(diagnostics.count, 1)
            XCTAssertEqual(diagnostics.first?.firstCallbackFrameCount, frames)
            XCTAssertEqual(unit.renderCount, 0)
            XCTAssertTrue(receiver.batches.isEmpty)
            XCTAssertTrue(receiver.failures.isEmpty, "Pre-admission diagnostic capture must not change fallback guards")
            try capture.stop()
            XCTAssertEqual(diagnostics.count, 1)
        }
    }

    func testNumericDiagnosticsFlushWithoutCallbacksOnStopAndEveryStartupFailure() throws {
        let stages: [String?] = [nil] + FakeUnit.startup.map { Optional($0) }
        for stage in stages {
            let unit = FakeUnit()
            var diagnostics: [MeetingMicrophoneStartupDiagnostic] = []
            if let stage { unit.failAt = [stage] }
            let capture = unit.capture(diagnosticSink: { diagnostics.append($0) })
            if stage != nil { XCTAssertThrowsError(try capture.start(into: Receiver())) }
            else {
                try capture.start(into: Receiver())
                XCTAssertTrue(diagnostics.isEmpty)
            }
            try capture.stop()
            XCTAssertEqual(diagnostics.count, 1, stage ?? "successful Start then Stop")
            XCTAssertNil(diagnostics.first?.firstCallbackFrameCount)
            XCTAssertTrue(diagnostics.first?.message.contains("firstCallbackFrameCount=-1") == true)
        }
    }

    func testNumericDiagnosticReadsCannotFailCaptureOrEnableFallback() throws {
        for processing in [false, true] {
            let unit = FakeUnit(), receiver = Receiver()
            unit.measurementError = MeetingAudioFailure.deviceFailure(operation: "private-device-name", status: -50)
            var diagnostics: [MeetingMicrophoneStartupDiagnostic] = []
            let capture = unit.capture(voiceProcessing: processing, diagnosticSink: { diagnostics.append($0) })
            try capture.start(into: receiver)
            unit.emit()
            try capture.stop()
            XCTAssertEqual(receiver.batches.count, 1)
            XCTAssertTrue(receiver.failures.isEmpty)
            XCTAssertEqual(unit.events.filter { $0 == "create" }.count, 1)
            let diagnostic = try XCTUnwrap(diagnostics.first)
            XCTAssertEqual(diagnostic.before.maximumFramesPerSlice, unit.capacity)
            XCTAssertEqual(diagnostic.after.maximumFramesPerSlice, unit.capacity)
            XCTAssertNil(diagnostic.before.microphone.bufferFrameSize)
            XCTAssertNil(diagnostic.after.reference.nominalSampleRate)
            XCTAssertFalse(diagnostic.message.contains("private-device-name"))
            XCTAssertFalse(diagnostic.message.contains("-50"))
        }
    }

    func testNumericDiagnosticsAreFreshForFallbackAndExplicitRestart() throws {
        let voice = FakeUnit(), fallback = FakeUnit(), restarted = FakeUnit()
        voice.failAt = ["initialize"]
        voice.failureOverride = MeetingVoiceProcessingUnavailable(diagnostic: .voiceInitialize, status: -10863)
        var diagnostics: [MeetingMicrophoneStartupDiagnostic] = []
        var createdModes: [Bool] = []
        let capture = MeetingMicrophoneCapture(selectedDeviceID: 42, voiceProcessing: true, makeUnit: { mode in
            createdModes.append(mode)
            return createdModes.count == 1 ? voice : (createdModes.count == 2 ? fallback : restarted)
        }, diagnosticSink: { diagnostics.append($0) })
        try capture.start(into: Receiver())
        fallback.emit(frames: 3)
        try capture.stop()
        try capture.start(into: Receiver())
        restarted.emit(frames: 7)
        try capture.stop()
        XCTAssertEqual(createdModes, [true, false, true])
        XCTAssertEqual(diagnostics.map { $0.voiceProcessing }, [true, false, true])
        XCTAssertEqual(diagnostics.map { $0.firstCallbackFrameCount }, [nil, 3, 7])
        XCTAssertEqual(diagnostics.map { $0.allocationFrames }, [8192, 8, 8192])
    }

    func testCleanupFailureDoesNotInventUnavailableCallbackBeforeDisposalSucceeds() throws {
        let unit = FakeUnit()
        var diagnostics: [MeetingMicrophoneStartupDiagnostic] = []
        let capture = unit.capture(voiceProcessing: true, diagnosticSink: { diagnostics.append($0) })
        try capture.start(into: Receiver())
        unit.failAt = ["stop"]
        XCTAssertThrowsError(try capture.stop())
        XCTAssertTrue(diagnostics.isEmpty, "Failed teardown cannot prove callbacks have finished")
        unit.emit(frames: 512)
        XCTAssertTrue(diagnostics.isEmpty, "Even a closed-admission callback only publishes atomics")
        unit.failAt = []
        try capture.stop()
        XCTAssertEqual(diagnostics.count, 1)
        XCTAssertEqual(diagnostics.first?.firstCallbackFrameCount, 512)
        XCTAssertEqual(unit.renderCount, 0)
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
        XCTAssertEqual(receiver.failures, [.sourceReconfigured])
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
        XCTAssertEqual(receiver.failures, [.sourceReconfigured])
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

    private func diagnosticBuffer() throws -> MeetingAudioBuffer {
        try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: 0,
                               sampleCapacity: 32, blockCapacity: 4)
    }

    private func assertCallbackFailure(_ failure: MeetingAudioFailure,
                                       diagnostic: MeetingAudioFailureDiagnostic,
                                       in ring: MeetingAudioBuffer,
                                       file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(ring.failure, failure, file: file, line: line)
        XCTAssertEqual(ring.failureDiagnostic, diagnostic, file: file, line: line)
        XCTAssertNil(ring.peek(), file: file, line: line)
        XCTAssertFalse(ring.withSendAdmission {}, file: file, line: line)
    }

    func testMalformedNativeTimestampsPublishMicrophoneTimestampDiagnosticToBuffer() throws {
        for malformed in 0..<5 {
            let unit = FakeUnit(), ring = try diagnosticBuffer()
            let capture = unit.capture()
            try capture.start(into: ring)
            let status: OSStatus
            switch malformed {
            case 0: status = unit.emit(validHostTime: false)
            case 1: status = unit.emit(validSampleTime: false)
            case 2: status = unit.emit(sampleTime: .nan)
            case 3: status = unit.emit(sampleTime: .infinity)
            default: status = unit.emit(sampleTime: 0.5)
            }
            XCTAssertEqual(status, kAudio_ParamError)
            assertCallbackFailure(.invalidTimestamp, diagnostic: .init(.microphoneTimestamp), in: ring)
            XCTAssertEqual(unit.renderCount, 0)
            try capture.stop()
        }
    }

    func testNativeFrameCapacityFailuresPublishMicrophoneCapacityDiagnosticToBuffer() throws {
        for frames in [UInt32(0), 9, UInt32.max] {
            let unit = FakeUnit(), ring = try diagnosticBuffer()
            let capture = unit.capture()
            try capture.start(into: ring)
            XCTAssertEqual(unit.emit(frames: frames), kAudioUnitErr_TooManyFramesToProcess)
            assertCallbackFailure(.bufferFull, diagnostic: .init(.microphoneFrameCapacity), in: ring)
            XCTAssertEqual(unit.renderCount, 0)
            try capture.stop()
        }
    }

    func testNativeRenderFailurePublishesActualStatusToBufferAndCannotBeOverwritten() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        unit.renderStatus = -77
        let capture = unit.capture()
        try capture.start(into: ring)
        XCTAssertEqual(unit.emit(), -77)
        unit.renderStatus = -88
        unit.emit(at: 200)
        assertCallbackFailure(.deviceFailure(operation: "AudioUnitRender", status: -77),
                              diagnostic: .init(.microphoneRender, status: -77), in: ring)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }

    func testNativeBufferLayoutFailurePublishesMicrophoneLayoutDiagnosticToBuffer() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        unit.corruptBuffer = { $0.pointee.mBuffers.mNumberChannels = 2 }
        let capture = unit.capture()
        try capture.start(into: ring)
        XCTAssertEqual(unit.emit(), kAudio_ParamError)
        assertCallbackFailure(.invalidFormat, diagnostic: .init(.microphoneBufferLayout), in: ring)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }

    func testNativeFormatVerificationFailurePublishesMicrophoneFormatDiagnosticToBuffer() throws {
        for changesOutput in [true, false] {
            let unit = FakeUnit(), ring = try diagnosticBuffer()
            let capture = unit.capture()
            try capture.start(into: ring)
            if changesOutput {
                unit.configuredOutput.mSampleRate = 44_100
            } else {
                var changed = unit.format
                changed.mSampleRate = 44_100
                unit.verifiedFormat = changed
            }
            let context = try XCTUnwrap(unit.context)
            context.formatDidChange()
            context.verifyFormatIfNeeded()
            unit.emit()
            assertCallbackFailure(.sourceReconfigured, diagnostic: .init(.microphoneFormatVerification), in: ring)
            XCTAssertEqual(unit.renderCount, 0)
            try capture.stop()
        }
    }

    func testNativeFormatReadFailurePublishesActualStatusToBuffer() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        let capture = unit.capture()
        try capture.start(into: ring)
        unit.failAt = ["verifyFormat"]
        let context = try XCTUnwrap(unit.context)
        context.formatDidChange()
        context.verifyFormatIfNeeded()
        assertCallbackFailure(.invalidFormat, diagnostic: .init(.microphoneFormatRead, status: -99), in: ring)
        try capture.stop()
    }

    func testNativeCapacityVerificationFailurePublishesMicrophoneCapacityDiagnosticToBuffer() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        let capture = unit.capture()
        try capture.start(into: ring)
        unit.verifiedCapacity = unit.capacity + 1
        let context = try XCTUnwrap(unit.context)
        context.formatDidChange()
        context.verifyFormatIfNeeded()
        assertCallbackFailure(.bufferFull, diagnostic: .init(.microphoneCapacityVerification), in: ring)
        try capture.stop()
    }

    func testNativeDeviceDisappearanceDuringRenderPublishesDeviceGoneDiagnosticToBuffer() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        unit.onRender = { [weak unit] in unit?.context?.deviceDidDisappear() }
        let capture = unit.capture()
        try capture.start(into: ring)
        unit.emit()
        assertCallbackFailure(.invalidSelection, diagnostic: .init(.microphoneDeviceGone), in: ring)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }

    func testMalformedOverlappingCallbackPublishesContendedTimestampDiagnosticToBuffer() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        unit.onRender = { [weak unit] in _ = unit?.emit(at: 200, validHostTime: false) }
        let capture = unit.capture()
        try capture.start(into: ring)
        unit.emit()
        assertCallbackFailure(.invalidTimestamp, diagnostic: .init(.microphoneContendedTimestamp), in: ring)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }

    func testRenderHeldBeforeReceiverCannotPublishPreRecheckAudioAfterHostGateReopens() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        unit.format.mSampleRate = 8_000
        let capture = unit.capture()
        try capture.start(into: ring)
        unit.emit(at: 0, frames: 8, sampleTime: 0)
        XCTAssertEqual(ring.diagnostics.bufferedSamples, 8)

        let enteredRender = DispatchSemaphore(value: 0), releaseRender = DispatchSemaphore(value: 0)
        let renderFinished = expectation(description: "Late native render returns")
        unit.onRender = {
            enteredRender.signal()
            XCTAssertEqual(releaseRender.wait(timeout: .now() + 5), .success)
        }
        defer { releaseRender.signal() }
        DispatchQueue.global().async {
            unit.emit(at: 100_000, frames: 8, sampleTime: 8)
            renderFinished.fulfill()
        }
        XCTAssertEqual(enteredRender.wait(timeout: .now() + 2), .success)
        ring.setHostSourceVerificationPending(true)
        XCTAssertEqual(ring.discardUnsentStartupAudio(), MeetingAudioGap(source: .microphone,
            epoch: 1, startNanoseconds: 0, endNanoseconds: 1_000_000, reason: .sourceVerification))
        ring.setHostSourceVerificationPending(false, confirmedAt: 2_000_000)
        releaseRender.signal()
        wait(for: [renderFinished], timeout: 2)
        unit.onRender = nil

        XCTAssertNil(ring.failure)
        XCTAssertNil(ring.failureDiagnostic)
        XCTAssertEqual(ring.diagnostics.bufferedSamples, 0)
        XCTAssertNil(ring.peek())
        var sentPackets: [MeetingAudioPacket] = []
        if let packet = ring.peek() { _ = ring.withSendAdmission { sentPackets.append(packet) } }
        XCTAssertTrue(sentPackets.isEmpty, "A native callback held before receive must not escape after recheck")
        XCTAssertEqual(ring.drainCaptureGaps(), [MeetingAudioGap(source: .microphone,
            epoch: 1, startNanoseconds: 1_000_000, endNanoseconds: 2_000_000, reason: .sourceVerification)])

        unit.sampleOffset = 20
        unit.emit(at: 200_000, frames: 8, sampleTime: 16)
        let packet = try XCTUnwrap(ring.peek())
        XCTAssertEqual(packet.startNanoseconds, 2_000_000)
        XCTAssertEqual(packet.endNanoseconds, 3_000_000)
        XCTAssertEqual(packet.samples, (0..<8).map { Float(20 + $0) })
        XCTAssertTrue(ring.withSendAdmission { sentPackets.append(packet) })
        XCTAssertEqual(sentPackets, [packet])
        XCTAssertNil(ring.failure)
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        try capture.stop()
    }


    func testSoftFormatFailureCannotHideDeviceLossWhileDisposingUnit() throws {
        let unit = FakeUnit(), ring = try diagnosticBuffer()
        let capture = unit.capture(voiceProcessing: true)
        try capture.start(into: ring)
        unit.referenceOutput = unit.configuredOutput
        unit.referenceOutput?.mSampleRate = 44_100
        let context = try XCTUnwrap(unit.context)
        context.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0)
        context.verifyFormatIfNeeded()
        XCTAssertEqual(ring.failure, .sourceReconfigured)
        unit.onStop = { context.deviceDidDisappear() }
        try capture.stop()
        XCTAssertEqual(ring.failure, .invalidSelection, "Teardown must retain hard route evidence after a soft format fault")
        context.referenceDidDisappear()
        XCTAssertEqual(ring.failureDiagnostic?.code, .microphoneDeviceGone, "Disposed contexts must be inert")
    }

    func testPendingMicrophoneCapacityAndReadFaultsDrainBeforeDisposal() throws {
        for readFailure in [false, true] {
            let unit = FakeUnit(), ring = try diagnosticBuffer()
            let capture = unit.capture()
            try capture.start(into: ring)
            ring.fail(.sourceReconfigured) // The peer source triggered paired quiescence.
            if readFailure { unit.failAt = ["verifyFormat"] }
            else { unit.verifiedCapacity = 9 }
            unit.context?.formatDidChange()
            try capture.stop()
            XCTAssertEqual(ring.failure, readFailure ? .invalidFormat : .bufferFull,
                "Pending hard verification must run before closing the peer unit")
            XCTAssertEqual(unit.events.last, "dispose")
        }
    }

    func testPinnedReferenceIsVerifiedBeforeAndAfterAcquisitionWithoutRetargeting() throws {
        for changesRoute in [false, true] {
            let unit = FakeUnit(), receiver = Receiver()
            var modes: [Bool] = []
            unit.verifyReference = { expected in
                XCTAssertEqual(expected, 11)
                if changesRoute, unit.referenceSelections.count == 2 { throw MeetingAudioFailure.invalidSelection }
            }
            let capture = MeetingMicrophoneCapture(selectedDeviceID: 42, voiceProcessing: true,
                expectedReferenceDeviceID: 11, makeUnit: { mode in modes.append(mode); return unit })
            if changesRoute {
                XCTAssertThrowsError(try capture.start(into: receiver)) {
                    XCTAssertEqual($0 as? MeetingAudioFailure, .invalidSelection)
                }
                XCTAssertEqual(unit.events.last, "dispose")
            } else { try capture.start(into: receiver) }
            XCTAssertEqual(unit.referenceSelections, [11, 11])
            XCTAssertEqual(unit.selectedDevice, 42)
            XCTAssertEqual(modes, [true], "Physical route loss must not select HAL fallback")
            try capture.stop()
        }
    }

    func testPinnedReferenceLossDuringStartupNeverBecomesCompatibilityFallback() throws {
        let unit = FakeUnit(), receiver = Receiver()
        var modes: [Bool] = []
        unit.onStart = { unit.context?.defaultOutputDidChange() }
        let capture = MeetingMicrophoneCapture(selectedDeviceID: 42, voiceProcessing: true,
            expectedReferenceDeviceID: 11, makeUnit: { mode in modes.append(mode); return unit })
        XCTAssertThrowsError(try capture.start(into: receiver))
        XCTAssertEqual(modes, [true])
        XCTAssertEqual(unit.events.last, "dispose")
        XCTAssertTrue(receiver.batches.isEmpty)
    }
}
