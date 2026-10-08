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
                throw MeetingAudioFailure.deviceFailure(operation: name, status: -99)
            }
        }

        func capture(device: AudioDeviceID = 42) -> MeetingMicrophoneCapture {
            MeetingMicrophoneCapture(
                selectedDeviceID: device,
                makeUnit: { try self.step("create"); return self },
                hostTimeToNanoseconds: { $0 * 10 }
            )
        }

        func enableInput() throws { try step("input") }
        func disableOutput() throws { try step("output") }
        func selectDevice(_ deviceID: AudioDeviceID) throws { try step("device"); selectedDevice = deviceID }
        func inputFormat() throws -> AudioStreamBasicDescription {
            formatReads += 1
            try step(formatReads == 1 ? "format" : "verifyFormat")
            onFormatRead?()
            return formatReads == 1 ? format : (verifiedFormat ?? format)
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
        func start() throws { try step("start") }
        func stop() throws { try step("stop") }
        func uninitialize() throws { try step("uninitialize") }
        func dispose() throws { try step("dispose"); context = nil }

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
