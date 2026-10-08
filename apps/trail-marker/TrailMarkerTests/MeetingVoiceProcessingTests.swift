import AudioToolbox
import CoreAudio
import XCTest
@testable import TrailMarker

/// Hardware-free: records the real configuration writes and calls the installed render
/// function with owned memory. No AudioUnit, capture adapter, or permission flow is opened.
final class MeetingVoiceProcessingTests: XCTestCase {
    private struct PropertyWrite {
        let property: AudioUnitPropertyID
        let scope: AudioUnitScope
        let element: AudioUnitElement
        let size: UInt32
        var scalar: UInt32?
        var ducking: AUVoiceIOOtherAudioDuckingConfiguration?
        var callback: AURenderCallbackStruct?
    }

    private struct WriteFailure: Error, Equatable {
        let stage: Int
    }

    private let properties: [AudioUnitPropertyID] = [
        kAudioOutputUnitProperty_EnableIO,
        kAUVoiceIOProperty_BypassVoiceProcessing,
        kAUVoiceIOProperty_VoiceProcessingEnableAGC,
        kAUVoiceIOProperty_OtherAudioDuckingConfiguration,
        kAudioUnitProperty_SetRenderCallback,
    ]

    private func configuration() throws -> [PropertyWrite] {
        var writes: [PropertyWrite] = []
        try MeetingVoiceProcessing.configureOutput { property, scope, element, value, size in
            var write = PropertyWrite(property: property, scope: scope, element: element, size: size)
            switch property {
            case kAudioOutputUnitProperty_EnableIO,
                 kAUVoiceIOProperty_BypassVoiceProcessing,
                 kAUVoiceIOProperty_VoiceProcessingEnableAGC:
                if size == UInt32(MemoryLayout<UInt32>.size) {
                    write.scalar = value.load(as: UInt32.self)
                }
            case kAUVoiceIOProperty_OtherAudioDuckingConfiguration:
                if size == UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size) {
                    write.ducking = value.load(as: AUVoiceIOOtherAudioDuckingConfiguration.self)
                }
            case kAudioUnitProperty_SetRenderCallback:
                if size == UInt32(MemoryLayout<AURenderCallbackStruct>.size) {
                    write.callback = value.load(as: AURenderCallbackStruct.self)
                }
            default:
                break
            }
            writes.append(write)
        }
        return writes
    }

    func testOutputIsEnabledWithoutBypassingVoiceProcessingOrEnablingAGC() throws {
        let writes = try configuration()
        XCTAssertEqual(writes.map(\.property), properties,
                       "Output configuration must perform all five required writes in order")
        XCTAssertEqual(writes.map(\.scope), [kAudioUnitScope_Output, kAudioUnitScope_Global,
                       kAudioUnitScope_Global, kAudioUnitScope_Global, kAudioUnitScope_Input])
        XCTAssertEqual(writes.map(\.element), [0, 0, 0, 0, 0])
        XCTAssertEqual(writes.map(\.size), [
            UInt32(MemoryLayout<UInt32>.size), UInt32(MemoryLayout<UInt32>.size),
            UInt32(MemoryLayout<UInt32>.size),
            UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size),
            UInt32(MemoryLayout<AURenderCallbackStruct>.size),
        ])
        XCTAssertEqual(writes.filter { $0.property == kAudioOutputUnitProperty_EnableIO }.map(\.scalar), [1],
                       "The output bus must stay enabled to supply the echo reference")
        XCTAssertEqual(writes.filter { $0.property == kAUVoiceIOProperty_BypassVoiceProcessing }.map(\.scalar), [0],
                       "Microphone voice processing must never be bypassed")
        XCTAssertEqual(writes.filter { $0.property == kAUVoiceIOProperty_VoiceProcessingEnableAGC }.map(\.scalar), [0],
                       "Voice processing must not add automatic gain changes")
    }

    func testAdvancedDuckingUsesMinimumLevel() throws {
        let writes = try configuration()
        let write = try XCTUnwrap(writes.first { $0.property == kAUVoiceIOProperty_OtherAudioDuckingConfiguration })
        let ducking = try XCTUnwrap(write.ducking)
        XCTAssertTrue(ducking.mEnableAdvancedDucking.boolValue,
                      "Advanced ducking must be explicitly configured")
        XCTAssertEqual(ducking.mDuckingLevel, .min,
                       "Voice processing must request minimum other-audio ducking")
    }

    func testSilenceCallbackIsInstalledOnInputScopeOfOutputBus() throws {
        let writes = try configuration()
        let callbacks = writes.filter { $0.property == kAudioUnitProperty_SetRenderCallback }
        XCTAssertEqual(callbacks.count, 1)
        let write = try XCTUnwrap(callbacks.first)
        XCTAssertEqual(write.scope, kAudioUnitScope_Input)
        XCTAssertEqual(write.element, 0)
        let callback = try XCTUnwrap(write.callback)
        XCTAssertNotNil(callback.inputProc)
        XCTAssertNil(callback.inputProcRefCon,
                     "The silent output callback must not retain captured audio or a playback context")
    }

    func testInstalledCallbackWritesSilenceWithoutPlayingCapturedAudio() throws {
        let writes = try configuration()
        let callback = try XCTUnwrap(writes.first { $0.property == kAudioUnitProperty_SetRenderCallback }?.callback)
        let render = try XCTUnwrap(callback.inputProc)
        let frames: UInt32 = 4
        let byteCount = Int(frames) * MemoryLayout<Float>.size
        let guardSize = 16
        let storage = UnsafeMutableRawPointer.allocate(byteCount: byteCount + 2 * guardSize, alignment: 16)
        defer { storage.deallocate() }
        storage.initializeMemory(as: UInt8.self, repeating: 0xA5, count: byteCount + 2 * guardSize)
        var buffers = AudioBufferList(mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(byteCount),
                                  mData: storage.advanced(by: guardSize)))
        var flags: AudioUnitRenderActionFlags = .unitRenderAction_PreRender
        var timestamp = AudioTimeStamp()
        let status = render(storage, &flags, &timestamp, 0, frames, &buffers)
        XCTAssertEqual(status, noErr)
        XCTAssertTrue(flags.contains(.unitRenderAction_OutputIsSilence))
        XCTAssertTrue(flags.contains(.unitRenderAction_PreRender), "Existing render flags must survive")
        let bytes = Array(UnsafeBufferPointer(start: storage.assumingMemoryBound(to: UInt8.self),
                                             count: byteCount + 2 * guardSize))
        XCTAssertEqual(Array(bytes[guardSize..<(guardSize + byteCount)]), [UInt8](repeating: 0, count: byteCount),
                       "Playback reference must write zero bytes instead of replaying captured audio")
        XCTAssertEqual(Array(bytes.prefix(guardSize)), [UInt8](repeating: 0xA5, count: guardSize))
        XCTAssertEqual(Array(bytes.suffix(guardSize)), [UInt8](repeating: 0xA5, count: guardSize))
        XCTAssertEqual(buffers.mBuffers.mDataByteSize, UInt32(byteCount))
    }

    func testEveryPropertyWriteFailurePropagatesAndStopsConfiguration() {
        for stage in properties.indices {
            var attempts: [AudioUnitPropertyID] = []
            XCTAssertThrowsError(try MeetingVoiceProcessing.configureOutput { property, _, _, _, _ in
                attempts.append(property)
                if attempts.count == stage + 1 { throw WriteFailure(stage: stage) }
            }) { error in
                XCTAssertEqual(error as? WriteFailure, WriteFailure(stage: stage),
                               "The original property-write failure must propagate")
            }
            XCTAssertEqual(attempts, Array(properties.prefix(stage + 1)),
                           "A failed configuration stage must stop further writes")
        }
    }

    func testDuckingFailureCannotFallBackToDefaultDuckingOrInstallPlayback() {
        var attempts: [AudioUnitPropertyID] = []
        XCTAssertThrowsError(try MeetingVoiceProcessing.configureOutput { property, _, _, _, _ in
            attempts.append(property)
            if property == kAUVoiceIOProperty_OtherAudioDuckingConfiguration { throw WriteFailure(stage: 3) }
        }) { error in
            XCTAssertEqual(error as? WriteFailure, WriteFailure(stage: 3))
        }
        XCTAssertEqual(attempts, Array(properties.prefix(4)),
                       "Unsupported minimum ducking must fail instead of falling back to default ducking")
        XCTAssertFalse(attempts.contains(kAudioUnitProperty_SetRenderCallback))
    }

    func testSilenceCallbackAcceptsZeroOneAndMaximumFrameCountsWithoutWritingOutsideTheBuffer() {
        for frames in [UInt32(0), 1, MeetingMicrophoneCapture.maximumBufferedFrames] {
            let byteCount = Int(frames) * MemoryLayout<Float>.size
            let storage = UnsafeMutableRawPointer.allocate(byteCount: byteCount + 32, alignment: 16)
            defer { storage.deallocate() }
            storage.initializeMemory(as: UInt8.self, repeating: 0xA5, count: byteCount + 32)
            var buffers = AudioBufferList(mNumberBuffers: 1,
                mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(byteCount),
                                      mData: storage.advanced(by: 16)))
            var flags: AudioUnitRenderActionFlags = []
            XCTAssertEqual(MeetingVoiceProcessing.renderSilence(flags: &flags, frames: frames, buffers: &buffers), noErr)
            XCTAssertTrue(flags.contains(.unitRenderAction_OutputIsSilence))
            let bytes = Array(UnsafeBufferPointer(start: storage.assumingMemoryBound(to: UInt8.self), count: byteCount + 32))
            XCTAssertEqual(Array(bytes.prefix(16)), [UInt8](repeating: 0xA5, count: 16))
            XCTAssertEqual(Array(bytes[16..<(16 + byteCount)]), [UInt8](repeating: 0, count: byteCount))
            XCTAssertEqual(Array(bytes.suffix(16)), [UInt8](repeating: 0xA5, count: 16))
        }
    }

    func testMalformedRenderRequestsAreRejectedWithoutTouchingAudio() {
        let cases: [(String, UInt32, UInt32, UInt32, UInt32, Bool)] = [
            ("above frame capacity", MeetingMicrophoneCapture.maximumBufferedFrames + 1, 1, 1, 16, false),
            ("overflow frame count", .max, 1, 1, 16, false),
            ("no buffers", 4, 0, 1, 16, false),
            ("multiple buffers", 4, 2, 1, 16, false),
            ("unbounded buffer count", 4, .max, 1, 16, false),
            ("no channels", 4, 1, 0, 16, false),
            ("stereo channels", 4, 1, 2, 16, false),
            ("unbounded channel count", 4, 1, .max, 16, false),
            ("empty byte count", 4, 1, 1, 0, false),
            ("short byte count", 4, 1, 1, 15, false),
            ("long byte count", 4, 1, 1, 17, false),
            ("unbounded byte count", 4, 1, 1, .max, false),
            ("missing sample memory", 4, 1, 1, 16, true),
            ("zero frames with nonempty bytes", 0, 1, 1, 16, false),
        ]
        for (name, frames, count, channels, byteCount, missingData) in cases {
            let storage = UnsafeMutableRawPointer.allocate(byteCount: 48, alignment: 16)
            defer { storage.deallocate() }
            storage.initializeMemory(as: UInt8.self, repeating: 0xA5, count: 48)
            var buffers = AudioBufferList(mNumberBuffers: count,
                mBuffers: AudioBuffer(mNumberChannels: channels, mDataByteSize: byteCount,
                                      mData: missingData ? nil : storage.advanced(by: 16)))
            var flags: AudioUnitRenderActionFlags = .unitRenderAction_PreRender
            XCTAssertEqual(MeetingVoiceProcessing.renderSilence(flags: &flags, frames: frames, buffers: &buffers),
                           kAudio_ParamError, name)
            XCTAssertTrue(flags.contains(.unitRenderAction_OutputIsSilence), name)
            XCTAssertTrue(flags.contains(.unitRenderAction_PreRender), name)
            XCTAssertEqual(Array(UnsafeBufferPointer(start: storage.assumingMemoryBound(to: UInt8.self), count: 48)),
                           [UInt8](repeating: 0xA5, count: 48), name)
            XCTAssertEqual(buffers.mNumberBuffers, count, name)
            XCTAssertEqual(buffers.mBuffers.mNumberChannels, channels, name)
            XCTAssertEqual(buffers.mBuffers.mDataByteSize, byteCount, name)
        }
    }

    func testMissingBufferListIsRejected() {
        var flags: AudioUnitRenderActionFlags = []
        XCTAssertEqual(MeetingVoiceProcessing.renderSilence(flags: &flags, frames: 4, buffers: nil), kAudio_ParamError)
        XCTAssertTrue(flags.contains(.unitRenderAction_OutputIsSilence))
    }
}
