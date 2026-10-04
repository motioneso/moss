import AudioToolbox
import CoreAudio
import Foundation

/// The control-plane seam. Tests supply a unit that never opens an audio device.
/// A successful dispose must end all callbacks before releasing their context.
protocol MeetingMicrophoneUnit: AnyObject {
    func enableInput() throws
    func disableOutput() throws
    func selectDevice(_ deviceID: AudioDeviceID) throws
    func inputFormat() throws -> AudioStreamBasicDescription
    func configureMonoOutput(sampleRate: Double) throws
    func maximumFramesPerSlice() throws -> UInt32
    func installInputCallback(_ context: MeetingMicrophoneRenderContext) throws
    func initialize() throws
    func installFormatListener(_ context: MeetingMicrophoneRenderContext) throws
    func start() throws
    func stop() throws
    func uninitialize() throws
    func dispose() throws
    func render(
        flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        timestamp: UnsafePointer<AudioTimeStamp>,
        frameCount: UInt32,
        buffers: UnsafeMutablePointer<AudioBufferList>
    ) -> OSStatus
}

/// Inert until start. Its owner serializes lifecycle calls and never calls them from a receiver.
/// The selected ID belongs to this AUHAL only; no system-default device property is changed.
final class MeetingMicrophoneCapture: MeetingAudioCapturing {
    static let maximumBufferedFrames: UInt32 = 16_384

    private let selectedDeviceID: AudioDeviceID
    private let makeUnit: () throws -> MeetingMicrophoneUnit
    private let hostTimeToNanoseconds: (UInt64) -> UInt64
    private var unit: MeetingMicrophoneUnit?
    private var context: MeetingMicrophoneRenderContext?
    private var initialized = false
    private var startAttempted = false

    init(
        selectedDeviceID: AudioDeviceID,
        makeUnit: @escaping () throws -> MeetingMicrophoneUnit = { try MeetingAUHALUnit() },
        hostTimeToNanoseconds: @escaping (UInt64) -> UInt64 = AudioConvertHostTimeToNanos
    ) {
        self.selectedDeviceID = selectedDeviceID
        self.makeUnit = makeUnit
        self.hostTimeToNanoseconds = hostTimeToNanoseconds
    }

    func start(into receiver: MeetingAudioReceiving) throws {
        guard unit == nil else { throw MeetingAudioFailure.invalidTransition }
        guard selectedDeviceID != kAudioObjectUnknown else { throw MeetingAudioFailure.invalidSelection }
        do {
            let acquired = try makeUnit()
            unit = acquired
            try acquired.enableInput()
            try acquired.disableOutput()
            try acquired.selectDevice(selectedDeviceID)
            let format = try acquired.inputFormat()
            guard Self.isUsable(format) else { throw MeetingAudioFailure.invalidFormat }
            try acquired.configureMonoOutput(sampleRate: format.mSampleRate)
            let capacity = try acquired.maximumFramesPerSlice()
            guard capacity > 0, capacity <= Self.maximumBufferedFrames else {
                throw MeetingAudioFailure.bufferFull
            }
            let renderContext = MeetingMicrophoneRenderContext(
                unit: acquired, receiver: receiver, sampleRate: format.mSampleRate,
                capacity: capacity, hostTimeToNanoseconds: hostTimeToNanoseconds
            )
            context = renderContext
            try acquired.installInputCallback(renderContext)
            try acquired.initialize()
            initialized = true
            // Install after initialization's own format notifications, then re-read to close
            // the gap between the original format query and listener installation.
            try acquired.installFormatListener(renderContext)
            let verifiedFormat = try acquired.inputFormat()
            guard Self.matches(verifiedFormat, format) else {
                throw MeetingAudioFailure.invalidFormat
            }
            let verifiedCapacity = try acquired.maximumFramesPerSlice()
            guard verifiedCapacity > 0, verifiedCapacity <= capacity else {
                throw MeetingAudioFailure.bufferFull
            }
            try renderContext.open()
            // A failed start may already have handed work to the driver: always try Stop.
            startAttempted = true
            try acquired.start()
        } catch {
            let startupError = error
            do { try stop() } catch { throw MeetingAudioFailure.cleanupFailed }
            throw startupError
        }
    }

    func stop() throws {
        context?.close()
        guard let unit else { return }
        // Do not proceed to freeing memory if a release fails. The next Stop retries the
        // remaining stage; start is refused until disposal has actually succeeded.
        if startAttempted {
            try unit.stop()
            startAttempted = false
        }
        context?.waitForRenderToFinish()
        if initialized {
            try unit.uninitialize()
            initialized = false
        }
        try unit.dispose()
        context = nil
        self.unit = nil
    }

    private static func isUsable(_ format: AudioStreamBasicDescription) -> Bool {
        format.mFormatID == kAudioFormatLinearPCM && format.mSampleRate.isFinite &&
            format.mSampleRate > 0 && format.mChannelsPerFrame > 0
    }

    private static func matches(_ lhs: AudioStreamBasicDescription, _ rhs: AudioStreamBasicDescription) -> Bool {
        isUsable(lhs) && lhs.mSampleRate == rhs.mSampleRate && lhs.mFormatID == rhs.mFormatID &&
            lhs.mFormatFlags == rhs.mFormatFlags && lhs.mBytesPerPacket == rhs.mBytesPerPacket &&
            lhs.mFramesPerPacket == rhs.mFramesPerPacket && lhs.mBytesPerFrame == rhs.mBytesPerFrame &&
            lhs.mChannelsPerFrame == rhs.mChannelsPerFrame && lhs.mBitsPerChannel == rhs.mBitsPerChannel
    }

    deinit {
        // The caller must observe Stop errors. On a driver release failure, the native
        // callback retain deliberately survives this object rather than dangling in Core Audio.
        try? stop()
    }
}

/// One preallocated buffer per unit. Samples are copied synchronously by the receiver.
/// No callback dispatches sample work, allocates a sample array, or retains borrowed data.
final class MeetingMicrophoneRenderContext {
    private let unit: MeetingMicrophoneUnit
    private let receiver: MeetingAudioReceiving
    private let sampleRate: Double
    private let capacity: UInt32
    private let hostTimeToNanoseconds: (UInt64) -> UInt64
    private let samples: UnsafeMutablePointer<Float>
    private let buffers: UnsafeMutablePointer<AudioBufferList>
    private let renderLock = NSLock()
    private let admissionLock = NSLock()
    private var accepting = false
    private var invalidated = false
    private var lastHostTime: UInt64?

    init(
        unit: MeetingMicrophoneUnit, receiver: MeetingAudioReceiving, sampleRate: Double,
        capacity: UInt32, hostTimeToNanoseconds: @escaping (UInt64) -> UInt64
    ) {
        self.unit = unit
        self.receiver = receiver
        self.sampleRate = sampleRate
        self.capacity = capacity
        self.hostTimeToNanoseconds = hostTimeToNanoseconds
        samples = .allocate(capacity: Int(capacity))
        samples.initialize(repeating: 0, count: Int(capacity))
        buffers = .allocate(capacity: 1)
        buffers.initialize(to: AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: capacity * 4, mData: UnsafeMutableRawPointer(samples))
        ))
    }

    func open() throws {
        admissionLock.lock()
        defer { admissionLock.unlock() }
        guard !invalidated else { throw MeetingAudioFailure.invalidFormat }
        accepting = true
    }

    func close() {
        admissionLock.lock()
        accepting = false
        admissionLock.unlock()
    }

    func waitForRenderToFinish() {
        renderLock.lock()
        renderLock.unlock()
    }

    /// Property callbacks run separately from the render callback. The receiver's failure
    /// entrypoint must also be bounded/thread-safe. A new format always needs a new epoch.
    func formatDidChange() {
        admissionLock.lock()
        let shouldReport = accepting
        accepting = false
        invalidated = true
        admissionLock.unlock()
        if shouldReport { receiver.fail(.invalidFormat) }
    }

    func render(
        flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        timestamp: UnsafePointer<AudioTimeStamp>,
        frameCount: UInt32
    ) -> OSStatus {
        // AUHAL normally serializes renders. Fail closed rather than wait or race our buffer.
        guard renderLock.try() else {
            failFromRender(.bufferFull)
            return kAudioUnitErr_TooManyFramesToProcess
        }
        defer { renderLock.unlock() }
        guard admissionLock.try() else {
            receiver.fail(.bufferFull)
            return kAudioUnitErr_TooManyFramesToProcess
        }
        let admitted = accepting
        admissionLock.unlock()
        guard admitted else { return noErr }
        guard frameCount > 0, frameCount <= capacity else {
            failFromRender(.bufferFull)
            return kAudioUnitErr_TooManyFramesToProcess
        }
        guard timestamp.pointee.mFlags.contains(.hostTimeValid) else {
            failFromRender(.invalidTimestamp)
            return kAudio_ParamError
        }
        let hostTime = hostTimeToNanoseconds(timestamp.pointee.mHostTime)
        guard lastHostTime.map({ hostTime > $0 }) ?? true else {
            failFromRender(.invalidTimestamp)
            return kAudio_ParamError
        }
        let byteCount = frameCount * UInt32(MemoryLayout<Float>.size)
        buffers.pointee.mNumberBuffers = 1
        buffers.pointee.mBuffers = AudioBuffer(
            mNumberChannels: 1, mDataByteSize: byteCount, mData: UnsafeMutableRawPointer(samples)
        )
        let status = unit.render(flags: flags, timestamp: timestamp, frameCount: frameCount, buffers: buffers)
        guard status == noErr else {
            failFromRender(.deviceFailure(operation: "AudioUnitRender", status: status))
            return status
        }
        guard buffers.pointee.mNumberBuffers == 1,
              buffers.pointee.mBuffers.mNumberChannels == 1,
              buffers.pointee.mBuffers.mDataByteSize == byteCount,
              buffers.pointee.mBuffers.mData == UnsafeMutableRawPointer(samples) else {
            failFromRender(.invalidFormat)
            return kAudio_ParamError
        }
        // Stop/format changes may arrive during AudioUnitRender. Recheck at the copy boundary.
        guard admissionLock.try() else {
            receiver.fail(.bufferFull)
            return kAudioUnitErr_TooManyFramesToProcess
        }
        defer { admissionLock.unlock() }
        guard accepting else { return noErr }
        lastHostTime = hostTime
        receiver.receive(
            hostTimeNanoseconds: hostTime, sampleRate: sampleRate, frameCount: Int(frameCount),
            sampleAt: { self.samples[$0] }
        )
        return noErr
    }

    private func failFromRender(_ failure: MeetingAudioFailure) {
        // Contention means a control/property operation is already closing admission.
        if admissionLock.try() {
            accepting = false
            invalidated = true
            admissionLock.unlock()
        }
        receiver.fail(failure)
    }

    deinit {
        buffers.deinitialize(count: 1)
        buffers.deallocate()
        samples.deinitialize(count: Int(capacity))
        samples.deallocate()
    }
}

/// AUHAL configuration follows Apple TN2091. Hardware-rate change monitoring is required
/// for AUHAL input (QA1777); it cannot silently convert a new device sample rate.
/// https://developer.apple.com/library/archive/technotes/tn2091/_index.html
/// https://developer.apple.com/library/archive/qa/qa1777/_index.html
final class MeetingAUHALUnit: MeetingMicrophoneUnit {
    private var unit: AudioUnit?
    private var callbackContext: Unmanaged<MeetingMicrophoneRenderContext>?

    init() throws {
        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0
        )
        guard let component = AudioComponentFindNext(nil, &description) else {
            throw MeetingAudioFailure.deviceFailure(operation: "find AUHAL", status: kAudio_ParamError)
        }
        var created: AudioUnit?
        try check(AudioComponentInstanceNew(component, &created), "AudioComponentInstanceNew")
        guard let created else { throw MeetingAudioFailure.invalidTransition }
        unit = created
    }

    func enableInput() throws {
        var value: UInt32 = 1
        try check(AudioUnitSetProperty(try liveUnit(), kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input, 1, &value, UInt32(MemoryLayout<UInt32>.size)), "enable AUHAL input")
    }

    func disableOutput() throws {
        var value: UInt32 = 0
        try check(AudioUnitSetProperty(try liveUnit(), kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Output, 0, &value, UInt32(MemoryLayout<UInt32>.size)), "disable AUHAL output")
    }

    func selectDevice(_ deviceID: AudioDeviceID) throws {
        var value = deviceID
        try check(AudioUnitSetProperty(try liveUnit(), kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0, &value, UInt32(MemoryLayout<AudioDeviceID>.size)), "select AUHAL device")
    }

    func inputFormat() throws -> AudioStreamBasicDescription {
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitGetProperty(
            try liveUnit(), kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &format, &size
        ), "read AUHAL input format")
        guard size == UInt32(MemoryLayout<AudioStreamBasicDescription>.size) else { throw MeetingAudioFailure.invalidFormat }
        return format
    }

    func configureMonoOutput(sampleRate: Double) throws {
        var format = AudioStreamBasicDescription(
            mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked, mBytesPerPacket: 4, mFramesPerPacket: 1,
            mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0
        )
        try check(AudioUnitSetProperty(try liveUnit(), kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output, 1, &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)),
            "configure AUHAL mono format")
        // Mono means the first input channel, not an unapproved device/route fallback.
        var channel: Int32 = 0
        try check(AudioUnitSetProperty(try liveUnit(), kAudioOutputUnitProperty_ChannelMap,
            kAudioUnitScope_Output, 1, &channel, UInt32(MemoryLayout<Int32>.size)), "configure AUHAL channel map")
        var allocate: UInt32 = 0
        try check(AudioUnitSetProperty(try liveUnit(), kAudioUnitProperty_ShouldAllocateBuffer,
            kAudioUnitScope_Output, 1, &allocate, UInt32(MemoryLayout<UInt32>.size)), "configure AUHAL buffer ownership")
    }

    func maximumFramesPerSlice() throws -> UInt32 {
        var frames: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        try check(AudioUnitGetProperty(
            try liveUnit(), kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &frames, &size
        ), "read AUHAL maximum frames")
        guard size == UInt32(MemoryLayout<UInt32>.size) else { throw MeetingAudioFailure.invalidFormat }
        return frames
    }

    func installInputCallback(_ context: MeetingMicrophoneRenderContext) throws {
        guard callbackContext == nil else { throw MeetingAudioFailure.invalidTransition }
        let retained = Unmanaged.passRetained(context)
        callbackContext = retained
        var callback = AURenderCallbackStruct(
            inputProc: { refCon, flags, timestamp, _, frames, _ in
                Unmanaged<MeetingMicrophoneRenderContext>.fromOpaque(refCon).takeUnretainedValue()
                    .render(flags: flags, timestamp: timestamp, frameCount: frames)
            },
            inputProcRefCon: retained.toOpaque()
        )
        try check(AudioUnitSetProperty(try liveUnit(), kAudioOutputUnitProperty_SetInputCallback,
            kAudioUnitScope_Global, 0, &callback, UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
            "install AUHAL input callback")
    }

    func initialize() throws { try check(AudioUnitInitialize(try liveUnit()), "AudioUnitInitialize") }

    func installFormatListener(_ context: MeetingMicrophoneRenderContext) throws {
        guard let callbackContext,
              callbackContext.takeUnretainedValue() === context else { throw MeetingAudioFailure.invalidTransition }
        try check(AudioUnitAddPropertyListener(
            try liveUnit(), kAudioUnitProperty_StreamFormat,
            { refCon, _, _, scope, element in
                let contextPointer: UnsafeMutableRawPointer? = refCon
                guard element == 1, scope == kAudioUnitScope_Input || scope == kAudioUnitScope_Output,
                      let contextPointer else { return }
                Unmanaged<MeetingMicrophoneRenderContext>.fromOpaque(contextPointer).takeUnretainedValue().formatDidChange()
            }, callbackContext.toOpaque()
        ), "AudioUnitAddPropertyListener")
    }

    func start() throws { try check(AudioOutputUnitStart(try liveUnit()), "AudioOutputUnitStart") }
    func stop() throws { try check(AudioOutputUnitStop(try liveUnit()), "AudioOutputUnitStop") }
    func uninitialize() throws { try check(AudioUnitUninitialize(try liveUnit()), "AudioUnitUninitialize") }

    func dispose() throws {
        guard let unit else { return }
        try check(AudioComponentInstanceDispose(unit), "AudioComponentInstanceDispose")
        self.unit = nil
        // The render and property callbacks share this retain. Keep it on EVERY failed
        // release path. Context owns this unit as well, preserving render storage on failure.
        callbackContext?.release()
        callbackContext = nil
    }

    func render(
        flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, timestamp: UnsafePointer<AudioTimeStamp>,
        frameCount: UInt32, buffers: UnsafeMutablePointer<AudioBufferList>
    ) -> OSStatus {
        guard let unit else { return kAudioUnitErr_Uninitialized }
        return AudioUnitRender(unit, flags, timestamp, 1, frameCount, buffers)
    }

    private func liveUnit() throws -> AudioUnit {
        guard let unit else { throw MeetingAudioFailure.invalidTransition }
        return unit
    }

    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw MeetingAudioFailure.deviceFailure(operation: operation, status: status) }
    }
}
