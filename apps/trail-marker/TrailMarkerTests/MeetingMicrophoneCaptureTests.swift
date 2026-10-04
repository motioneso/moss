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
            "initialize", "listener", "verifyFormat", "verifyCapacity", "start",
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
        var capacity: UInt32 = 8
        var verifiedCapacity: UInt32?
        var context: MeetingMicrophoneRenderContext?
        var onRender: (() -> Void)?
        var onListener: (() -> Void)?
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
            return formatReads == 1 ? format : (verifiedFormat ?? format)
        }
        func configureMonoOutput(sampleRate: Double) throws { try step("mono"); configuredRate = sampleRate }
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
            validHostTime: Bool = true, to savedContext: MeetingMicrophoneRenderContext? = nil
        ) -> OSStatus {
            guard let target = savedContext ?? context else { return kAudioUnitErr_Uninitialized }
            var flags: AudioUnitRenderActionFlags = []
            var timestamp = AudioTimeStamp()
            timestamp.mHostTime = hostTime
            timestamp.mFlags = validHostTime ? .hostTimeValid : .sampleTimeValid
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

    func testFormatNotificationDuringStartupPreventsStart() {
        let unit = FakeUnit()
        unit.onListener = { [weak unit] in unit?.context?.formatDidChange() }
        let capture = unit.capture()
        XCTAssertThrowsError(try capture.start(into: Receiver())) {
            XCTAssertEqual($0 as? MeetingAudioFailure, .invalidFormat)
        }
        XCTAssertFalse(unit.events.contains("start"))
        XCTAssertNil(unit.context)
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

    func testMissingOrNonMonotonicHostTimestampFailsClosed() throws {
        for missingFlag in [true, false] {
            let unit = FakeUnit()
            let capture = unit.capture()
            let receiver = Receiver()
            try capture.start(into: receiver)
            if !missingFlag { unit.emit(at: 100) }
            unit.emit(at: 99, validHostTime: !missingFlag)
            unit.emit(at: 200)
            XCTAssertEqual(receiver.failures, [.invalidTimestamp])
            XCTAssertEqual(unit.renderCount, missingFlag ? 0 : 1)
            XCTAssertEqual(receiver.batches.count, missingFlag ? 0 : 1)
            try capture.stop()
        }
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
        unit.onRender = { [weak unit] in unit?.context?.formatDidChange() }
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

    func testOverlappingRenderReportsFailureInsteadOfSilentlyDroppingSamples() throws {
        let unit = FakeUnit()
        unit.onRender = { [weak unit] in _ = unit?.emit(at: 200) }
        let capture = unit.capture()
        let receiver = Receiver()
        try capture.start(into: receiver)
        unit.emit()
        XCTAssertEqual(receiver.failures, [.bufferFull])
        XCTAssertTrue(receiver.batches.isEmpty)
        XCTAssertEqual(unit.renderCount, 1)
        try capture.stop()
    }
}
