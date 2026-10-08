import AudioToolbox
import CoreAudio
import Foundation

/// The control-plane seam. Tests supply a unit that never opens an audio device.
/// A successful dispose must end all callbacks before releasing their context.
protocol MeetingMicrophoneUnit: AnyObject {
    func enableInput() throws
    func configureOutput() throws
    func selectDevice(_ deviceID: AudioDeviceID) throws
    func inputFormat() throws -> AudioStreamBasicDescription
    func outputFormat() throws -> AudioStreamBasicDescription
    func referenceFormat() throws -> AudioStreamBasicDescription?
    func configureMonoOutput(sampleRate: Double) throws
    func maximumFramesPerSlice() throws -> UInt32
    func installInputCallback(_ context: MeetingMicrophoneRenderContext) throws
    func initialize() throws
    func installFormatListener(_ context: MeetingMicrophoneRenderContext) throws
    func installDeviceListener(_ context: MeetingMicrophoneRenderContext) throws
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
/// The selected ID belongs to this unit only; no system-default device property is changed.
final class MeetingMicrophoneCapture: MeetingAudioCapturing {
    static let maximumBufferedFrames = UInt32(MeetingAudioBuffer.maximumCallbackFrames)

    let voiceProcessing: Bool
    private let selectedDeviceID: AudioDeviceID
    private let makeUnit: (Bool) throws -> MeetingMicrophoneUnit
    private let hostTimeToNanoseconds: (UInt64) -> UInt64
    private var unit: MeetingMicrophoneUnit?
    private var context: MeetingMicrophoneRenderContext?
    private var initialized = false
    private var startAttempted = false
    private(set) var startupDiagnostic: String?

    init(
        selectedDeviceID: AudioDeviceID,
        voiceProcessing: Bool = false,
        makeUnit: @escaping (Bool) throws -> MeetingMicrophoneUnit = MeetingMicrophoneIOUnit.init(voiceProcessing:),
        hostTimeToNanoseconds: @escaping (UInt64) -> UInt64 = AudioConvertHostTimeToNanos
    ) {
        self.voiceProcessing = voiceProcessing
        self.selectedDeviceID = selectedDeviceID
        self.makeUnit = makeUnit
        self.hostTimeToNanoseconds = hostTimeToNanoseconds
    }

    func start(into receiver: MeetingAudioReceiving) throws {
        guard unit == nil else { throw MeetingAudioFailure.invalidTransition }
        guard selectedDeviceID != kAudioObjectUnknown else { throw MeetingAudioFailure.invalidSelection }
        startupDiagnostic = nil
        do {
            try startUnit(processing: voiceProcessing, into: receiver)
            startupDiagnostic = voiceProcessing ? "microphone-echo-cancellation=on" : "microphone-echo-cancellation=off reason=microphoneOnly"
        } catch {
            var startupError = error
            let failedContext = context
            if voiceProcessing { failedContext?.verifyFormatIfNeeded() }
            // Disposal is a hard boundary: never open another unit while callbacks or
            // native resources from the failed attempt might still exist.
            do { try stop() } catch { throw MeetingAudioFailure.cleanupFailed }
            if voiceProcessing, failedContext?.startupIsUnsafeForFallback == true { throw MeetingAudioFailure.invalidFormat }
            if (startupError as? MeetingAudioFailure) == .invalidFormat,
               let compatibility = failedContext?.startupCompatibilityFailure {
                startupError = compatibility
            }
            guard voiceProcessing, let unavailable = startupError as? MeetingVoiceProcessingUnavailable else { throw startupError }
            do {
                try startUnit(processing: false, into: receiver)
                startupDiagnostic = "microphone-echo-cancellation=off reason=\(unavailable.diagnostic) status=\(unavailable.status.map { String($0) } ?? "unavailable")"
            } catch {
                let fallbackError = error
                do { try stop() } catch { throw MeetingAudioFailure.cleanupFailed }
                throw fallbackError
            }
        }
    }

    private func startUnit(processing: Bool, into receiver: MeetingAudioReceiving) throws {
        let acquired = try makeUnit(processing)
        unit = acquired
        try acquired.enableInput()
        try acquired.configureOutput()
        try acquired.selectDevice(selectedDeviceID)
        let format = try acquired.inputFormat()
        guard Self.isUsable(format) else {
            if processing { throw MeetingVoiceProcessingUnavailable(diagnostic: .voiceClientFormat, status: nil) }
            throw MeetingAudioFailure.invalidFormat
        }
        try acquired.configureMonoOutput(sampleRate: format.mSampleRate)
        let capacity = try acquired.maximumFramesPerSlice()
        guard capacity > 0, capacity <= Self.maximumBufferedFrames else {
            throw MeetingAudioFailure.bufferFull
        }
        let renderContext = MeetingMicrophoneRenderContext(
            unit: acquired, receiver: receiver, format: format,
            capacity: capacity, hostTimeToNanoseconds: hostTimeToNanoseconds, hasVoiceReference: processing
        )
        context = renderContext
        try acquired.installInputCallback(renderContext)
        try acquired.initialize()
        initialized = true
        // Install after initialization's own format notifications, then re-read to close
        // the gap between the original format query and listener installation.
        try acquired.installFormatListener(renderContext)
        try acquired.installDeviceListener(renderContext)
        let verifiedFormat = try acquired.inputFormat()
        guard Self.matches(verifiedFormat, format) else {
            if processing { throw MeetingVoiceProcessingUnavailable(diagnostic: .voiceClientFormat, status: nil) }
            throw MeetingAudioFailure.invalidFormat
        }
        let verifiedCapacity = try acquired.maximumFramesPerSlice()
        guard verifiedCapacity > 0, verifiedCapacity <= capacity else {
            throw MeetingAudioFailure.bufferFull
        }
        if processing { renderContext.audioUnitFormatDidChange(scope: kAudioUnitScope_Input, element: 0) }
        renderContext.verifyFormatIfNeeded()
        // VPIO cannot publish samples before Start succeeds. A failing attempt must
        // not poison the same receiver that the exact-mic HAL fallback will use.
        if processing { try renderContext.validateBeforeStart() }
        else { try renderContext.open() }
        startAttempted = true
        try acquired.start()
        if processing {
            renderContext.verifyFormatIfNeeded()
            try renderContext.open()
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
            (8000...192000).contains(format.mSampleRate) && format.mSampleRate.rounded() == format.mSampleRate &&
            format.mChannelsPerFrame > 0
    }

    static func matches(_ lhs: AudioStreamBasicDescription, _ rhs: AudioStreamBasicDescription) -> Bool {
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
    private let hasVoiceReference: Bool
    private let sampleRate: Double
    private let format: AudioStreamBasicDescription
    private let formatNotice = MeetingAudioAtomicState()
    private let referenceNotice = MeetingAudioAtomicState()
    private let capacity: UInt32
    private let hostTimeToNanoseconds: (UInt64) -> UInt64
    private let samples: UnsafeMutablePointer<Float>
    private let buffers: UnsafeMutablePointer<AudioBufferList>
    private let renderLock = NSLock()
    // Bits: 1 = opened, 2 = invalidated, 4 = closed permanently. Only value 1 admits audio.
    private let admission = MeetingAudioAtomicState()
    // Startup-only failure kinds: 1 = format, 2 = default speaker changed, 4 = other.
    // Published by callbacks and read only after complete teardown before fallback.
    private let startupFailureKinds = MeetingAudioAtomicState()

    init(
        unit: MeetingMicrophoneUnit, receiver: MeetingAudioReceiving, format: AudioStreamBasicDescription,
        capacity: UInt32, hostTimeToNanoseconds: @escaping (UInt64) -> UInt64, hasVoiceReference: Bool = false
    ) {
        self.unit = unit
        self.receiver = receiver
        self.hasVoiceReference = hasVoiceReference
        self.sampleRate = format.mSampleRate
        self.format = format
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

    var startupIsUnsafeForFallback: Bool {
        let state = admission.value
        let kinds = startupFailureKinds.value
        return state & 1 != 0 || kinds & 4 != 0 ||
            (state & 2 != 0 && kinds & 3 == 0) ||
            formatNotice.value != 0 || referenceNotice.value != 0
    }

    var startupCompatibilityFailure: MeetingVoiceProcessingUnavailable? {
        guard hasVoiceReference, !startupIsUnsafeForFallback else { return nil }
        let kinds = startupFailureKinds.value
        if kinds & 1 != 0 { return .init(diagnostic: .voiceClientFormat, status: nil) }
        if kinds & 2 != 0 { return .init(diagnostic: .voiceDefaultOutputChanged, status: nil) }
        return nil
    }

    func validateBeforeStart() throws {
        guard admission.value == 0 else { throw MeetingAudioFailure.invalidFormat }
    }

    func open() throws {
        guard admission.replace(0, with: 1) else { throw MeetingAudioFailure.invalidFormat }
    }

    func close() { admission.insert(4) }

    func waitForRenderToFinish() {
        renderLock.lock()
        renderLock.unlock()
    }

    /// The property callback may run on an audio thread: only publish a notice here.
    func formatDidChange() {
        guard admission.value & 4 == 0 else { return }
        formatNotice.insert(1)
    }

    /// Called on the property-monitor queue (or serialized startup), never by render.
    func verifyFormatIfNeeded() {
        verifyReferenceFormatIfNeeded()
        let notice = formatNotice.value
        guard admission.value & 4 == 0, notice == 1,
              formatNotice.replace(1, with: 2) else { return }
        // Keep callbacks quarantined while reading. A new notice changes 2 to 3 and
        // survives this verification, requiring another read before audio can resume.
        defer {
            if !formatNotice.replace(2, with: 0) { _ = formatNotice.replace(3, with: 1) }
        }
        do {
            let current = try unit.inputFormat()
            let output = try unit.outputFormat()
            guard MeetingMicrophoneCapture.matches(current, format),
                  output.mSampleRate == sampleRate, output.mFormatID == kAudioFormatLinearPCM,
                  output.mFormatFlags == kAudioFormatFlagsNativeFloatPacked,
                  output.mChannelsPerFrame == 1, output.mBitsPerChannel == 32,
                  output.mBytesPerFrame == 4, output.mBytesPerPacket == 4,
                  output.mFramesPerPacket == 1 else { failFromRender(.invalidFormat, diagnostic: .init(.microphoneFormatVerification), startupCompatibility: 1); return }
            let currentCapacity = try unit.maximumFramesPerSlice()
            guard currentCapacity > 0, currentCapacity <= capacity else { failFromRender(.bufferFull, diagnostic: .init(.microphoneCapacityVerification)); return }
        } catch { failFromRender(.invalidFormat, diagnostic: .init(.microphoneFormatRead, status: MeetingAudioFailureDiagnostic.status(error))) }
    }

    private func verifyReferenceFormatIfNeeded() {
        guard hasVoiceReference, admission.value & 4 == 0,
              referenceNotice.replace(1, with: 2) else { return }
        defer {
            if !referenceNotice.replace(2, with: 0) { _ = referenceNotice.replace(3, with: 1) }
        }
        do {
            guard let current = try unit.referenceFormat(),
                  current.mSampleRate == sampleRate, current.mFormatID == kAudioFormatLinearPCM,
                  current.mFormatFlags == kAudioFormatFlagsNativeFloatPacked,
                  current.mChannelsPerFrame == 1, current.mBitsPerChannel == 32,
                  current.mBytesPerFrame == 4, current.mBytesPerPacket == 4,
                  current.mFramesPerPacket == 1 else {
                failFromRender(.invalidFormat, diagnostic: .init(.voiceReferenceFormatVerification), startupCompatibility: 1); return
            }
        } catch {
            failFromRender(.invalidFormat, diagnostic: .init(.voiceReferenceFormatRead, status: MeetingAudioFailureDiagnostic.status(error)))
        }
    }

    func audioUnitFormatDidChange(scope: AudioUnitScope, element: AudioUnitElement) {
        guard admission.value & 4 == 0 else { return }
        if element == 0, hasVoiceReference, scope == kAudioUnitScope_Input {
            // Recheck the client format on the control queue. Hardware-side rate
            // changes are handled by VPIO's resampler and do not alone invalidate it.
            referenceNotice.insert(1)
        } else if element == 1, scope == kAudioUnitScope_Input || scope == kAudioUnitScope_Output {
            formatDidChange()
        }
    }

    func defaultOutputDidChange() {
        guard admission.value & 4 == 0 else { return }
        failFromRender(.invalidSelection, diagnostic: .init(.voiceDefaultOutputChanged), startupCompatibility: 2)
    }

    func referenceDidDisappear() { failFromRender(.invalidSelection, diagnostic: .init(.voiceReferenceRoute)) }

    func deviceDidDisappear() { failFromRender(.invalidSelection, diagnostic: .init(.microphoneDeviceGone)) }

    func render(
        flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        timestamp: UnsafePointer<AudioTimeStamp>,
        frameCount: UInt32
    ) -> OSStatus {
        // AUHAL normally serializes renders. A collision is a bounded missing interval,
        // never a reason to wait on the audio thread or invent a full sample ring.
        guard renderLock.try() else {
            if admission.value == 1, timestamp.pointee.mFlags.contains([.hostTimeValid, .sampleTimeValid]) {
                receiver.drop(sampleTime: timestamp.pointee.mSampleTime,
                    hostTimeNanoseconds: hostTimeToNanoseconds(timestamp.pointee.mHostTime),
                    sampleRate: sampleRate, frameCount: Int(frameCount))
            } else if admission.value == 1 { failFromRender(.invalidTimestamp, diagnostic: .init(.microphoneContendedTimestamp)) }
            return noErr
        }
        defer { renderLock.unlock() }
        guard admission.value == 1 else { return noErr }
        guard frameCount > 0, frameCount <= capacity else {
            failFromRender(.bufferFull, diagnostic: .init(.microphoneFrameCapacity))
            return kAudioUnitErr_TooManyFramesToProcess
        }
        guard timestamp.pointee.mFlags.contains([.hostTimeValid, .sampleTimeValid]),
              timestamp.pointee.mSampleTime.isFinite,
              timestamp.pointee.mSampleTime.rounded() == timestamp.pointee.mSampleTime else {
            failFromRender(.invalidTimestamp, diagnostic: .init(.microphoneTimestamp))
            return kAudio_ParamError
        }
        let hostTime = hostTimeToNanoseconds(timestamp.pointee.mHostTime)
        if formatNotice.value != 0 || referenceNotice.value != 0 {
            receiver.drop(sampleTime: timestamp.pointee.mSampleTime, hostTimeNanoseconds: hostTime,
                          sampleRate: sampleRate, frameCount: Int(frameCount))
            return noErr
        }
        let byteCount = frameCount * UInt32(MemoryLayout<Float>.size)
        buffers.pointee.mNumberBuffers = 1
        buffers.pointee.mBuffers = AudioBuffer(
            mNumberChannels: 1, mDataByteSize: byteCount, mData: UnsafeMutableRawPointer(samples)
        )
        let status = unit.render(flags: flags, timestamp: timestamp, frameCount: frameCount, buffers: buffers)
        guard status == noErr else {
            failFromRender(.deviceFailure(operation: "AudioUnitRender", status: status), diagnostic: .init(.microphoneRender, status: status))
            return status
        }
        guard buffers.pointee.mNumberBuffers == 1,
              buffers.pointee.mBuffers.mNumberChannels == 1,
              buffers.pointee.mBuffers.mDataByteSize == byteCount,
              buffers.pointee.mBuffers.mData == UnsafeMutableRawPointer(samples) else {
            failFromRender(.invalidFormat, diagnostic: .init(.microphoneBufferLayout))
            return kAudio_ParamError
        }
        // Stop/format changes may arrive during AudioUnitRender. Recheck at the copy boundary.
        guard admission.value == 1 else { return noErr }
        if formatNotice.value != 0 || referenceNotice.value != 0 {
            receiver.drop(sampleTime: timestamp.pointee.mSampleTime, hostTimeNanoseconds: hostTime,
                          sampleRate: sampleRate, frameCount: Int(frameCount))
            return noErr
        }
        receiver.receive(
            sampleTime: timestamp.pointee.mSampleTime, hostTimeNanoseconds: hostTime, sampleRate: sampleRate, frameCount: Int(frameCount),
            sampleAt: { self.samples[$0] }
        )
        return noErr
    }

    private func failFromRender(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic,
                                startupCompatibility: UInt32 = 0) {
        let previous = admission.insert(2)
        if previous == 1 { receiver.fail(failure, diagnostic: diagnostic) }
        else if previous == 0 || previous == 2 {
            startupFailureKinds.insert(hasVoiceReference && startupCompatibility != 0 ? startupCompatibility : 4)
        }
    }

    deinit {
        buffers.deinitialize(count: 1)
        buffers.deallocate()
        samples.deinitialize(count: Int(capacity))
        samples.deallocate()
    }
}

/// HAL input follows Apple TN2091; duplex VPIO uses separate per-bus device selection.
/// Hardware-rate change monitoring is required
/// for AUHAL input (QA1777); it cannot silently convert a new device sample rate.
/// https://developer.apple.com/library/archive/technotes/tn2091/_index.html
/// https://developer.apple.com/library/archive/qa/qa1777/_index.html
final class MeetingMicrophoneIOUnit: MeetingMicrophoneUnit {
    private var unit: AudioUnit?
    private let voiceProcessing: Bool
    private var referenceDevice: AudioDeviceID?
    private var referenceListener: AudioObjectPropertyListenerBlock?
    private var callbackContext: Unmanaged<MeetingMicrophoneRenderContext>?
    private var selectedDevice: AudioDeviceID?
    private let deviceQueue = DispatchQueue(label: "com.moss.meeting.microphone-device")
    private var deviceListener: AudioObjectPropertyListenerBlock?
    private var formatMonitor: DispatchSourceTimer?

    init(voiceProcessing: Bool = false) throws {
        self.voiceProcessing = voiceProcessing
        var description = MeetingVoiceProcessing.componentDescription(voiceProcessing: voiceProcessing)
        guard let component = AudioComponentFindNext(nil, &description) else {
            if voiceProcessing { throw MeetingVoiceProcessingUnavailable(diagnostic: .voiceComponent, status: nil) }
            throw MeetingAudioFailure.deviceFailure(operation: "find AUHAL", status: kAudio_ParamError)
        }
        var created: AudioUnit?
        try check(AudioComponentInstanceNew(component, &created), "AudioComponentInstanceNew", fallback: .voiceComponent)
        guard let created else { throw MeetingAudioFailure.invalidTransition }
        unit = created
    }

    func enableInput() throws {
        var value: UInt32 = 1
        try check(AudioUnitSetProperty(try liveUnit(), kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input, 1, &value, UInt32(MemoryLayout<UInt32>.size)), "enable AUHAL input", fallback: .voiceInputEnable)
    }

    func configureOutput() throws {
        if voiceProcessing {
            try MeetingVoiceProcessing.configureOutput { property, scope, bus, value, size in
                try self.check(AudioUnitSetProperty(try self.liveUnit(), property, scope, bus, value, size),
                               MeetingVoiceProcessing.propertyOperation(property),
                               fallback: Self.voicePropertyDiagnostic(property))
            }
            return
        }
        var value: UInt32 = 0
        try check(AudioUnitSetProperty(try liveUnit(), kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Output, 0, &value, UInt32(MemoryLayout<UInt32>.size)), "disable AUHAL output")
    }

    func selectDevice(_ deviceID: AudioDeviceID) throws {
        let output: AudioDeviceID?
        if voiceProcessing {
            do { output = try Self.defaultOutputDevice() }
            catch { throw MeetingVoiceProcessingUnavailable(diagnostic: .voiceReferenceSelection, status: nil) }
        } else { output = nil }
        try MeetingVoiceProcessing.configureDevices(microphone: deviceID, output: output) { property, scope, bus, value, size in
            try self.check(AudioUnitSetProperty(try self.liveUnit(), property, scope, bus, value, size),
                           "select microphone unit device", fallback: .voiceDeviceSelection)
        }
        referenceDevice = output
        selectedDevice = deviceID
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

    func outputFormat() throws -> AudioStreamBasicDescription {
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitGetProperty(try liveUnit(), kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output, 1, &format, &size), "read AUHAL output format")
        guard size == UInt32(MemoryLayout<AudioStreamBasicDescription>.size) else { throw MeetingAudioFailure.invalidFormat }
        return format
    }

    func referenceFormat() throws -> AudioStreamBasicDescription? {
        guard voiceProcessing else { return nil }
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitGetProperty(try liveUnit(), kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input, 0, &format, &size), "read voice reference client format")
        guard size == UInt32(MemoryLayout<AudioStreamBasicDescription>.size) else { throw MeetingAudioFailure.invalidFormat }
        return format
    }

    func configureMonoOutput(sampleRate: Double) throws {
        var format = AudioStreamBasicDescription(
            mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked, mBytesPerPacket: 4, mFramesPerPacket: 1,
            mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0
        )
        try MeetingVoiceProcessing.configureFormats(format: format, voiceProcessing: voiceProcessing) { property, scope, bus, value, size in
            try self.check(AudioUnitSetProperty(try self.liveUnit(), property, scope, bus, value, size),
                           "configure microphone client format", fallback: property == kAudioOutputUnitProperty_ChannelMap ? .voiceChannelMap : .voiceClientFormat)
        }
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

    func initialize() throws { try check(AudioUnitInitialize(try liveUnit()), "AudioUnitInitialize", fallback: .voiceInitialize) }

    func installFormatListener(_ context: MeetingMicrophoneRenderContext) throws {
        guard let callbackContext,
              callbackContext.takeUnretainedValue() === context else { throw MeetingAudioFailure.invalidTransition }
        try check(AudioUnitAddPropertyListener(
            try liveUnit(), kAudioUnitProperty_StreamFormat,
            { refCon, _, _, scope, element in
                let contextPointer: UnsafeMutableRawPointer? = refCon
                guard let contextPointer else { return }
                let context = Unmanaged<MeetingMicrophoneRenderContext>.fromOpaque(contextPointer).takeUnretainedValue()
                context.audioUnitFormatDidChange(scope: scope, element: element)
            }, callbackContext.toOpaque()
        ), "AudioUnitAddPropertyListener")
        // Preallocate a control-plane poller; the AU property callback never dispatches/allocates.
        let monitor = DispatchSource.makeTimerSource(queue: deviceQueue)
        monitor.schedule(deadline: .now(), repeating: .milliseconds(20))
        monitor.setEventHandler { [weak context] in context?.verifyFormatIfNeeded() }
        formatMonitor = monitor
        monitor.resume()
    }

    func installDeviceListener(_ context: MeetingMicrophoneRenderContext) throws {
        guard let selectedDevice, deviceListener == nil else { throw MeetingAudioFailure.invalidTransition }
        guard Self.deviceIsAlive(selectedDevice) else { throw MeetingAudioFailure.invalidSelection }
        if voiceProcessing {
            guard let referenceDevice, Self.deviceIsAlive(referenceDevice) else { throw MeetingAudioFailure.invalidSelection }
            if try Self.defaultOutputDevice() != referenceDevice {
                throw MeetingVoiceProcessingUnavailable(diagnostic: .voiceDefaultOutputChanged, status: nil)
            }
            // VPIO may construct its own private aggregate. Verify the selected physical
            // endpoints through its documented per-bus CurrentDevice properties.
            guard try currentDevice(bus: 1) == selectedDevice,
                  try currentDevice(bus: 0) == referenceDevice else { throw MeetingVoiceProcessingUnavailable(diagnostic: .voiceEndpointReadback, status: nil) }
        }
        var address = Self.devicesAddress()
        let reference = referenceDevice
        let listener: AudioObjectPropertyListenerBlock = { _, _ in
            // Listen on the stable system object so unplug cannot leave an unremovable
            // listener registered on a now-destroyed device. Unrelated device changes are inert.
            if !Self.deviceIsAlive(selectedDevice) { context.deviceDidDisappear() }
            if reference.map({ !Self.deviceIsAlive($0) }) == true { context.referenceDidDisappear() }
        }
        try check(AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),
            &address, deviceQueue, listener), "observe microphone devices")
        deviceListener = listener
        guard Self.deviceIsAlive(selectedDevice) else { throw MeetingAudioFailure.invalidSelection }
        if let reference {
            var routeAddress = Self.outputAddress()
            let routeListener: AudioObjectPropertyListenerBlock = { _, _ in
                // Do not retarget a running unit. Existing host recovery rebuilds both
                // sources on explicit Resume after checking the exact capture grant.
                let current = try? Self.defaultOutputDevice()
                if Self.deviceIsAlive(reference), let current, current != reference {
                    context.defaultOutputDidChange()
                } else {
                    MeetingVoiceProcessing.verifyReference(expected: reference,
                        current: current, alive: Self.deviceIsAlive(reference), context: context)
                }
            }
            try check(AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),
                &routeAddress, deviceQueue, routeListener), "observe voice reference route")
            referenceListener = routeListener
            guard Self.deviceIsAlive(reference) else { throw MeetingAudioFailure.invalidSelection }
            if try Self.defaultOutputDevice() != reference {
                throw MeetingVoiceProcessingUnavailable(diagnostic: .voiceDefaultOutputChanged, status: nil)
            }
        }
    }

    private func currentDevice(bus: AudioUnitElement) throws -> AudioDeviceID {
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        try check(AudioUnitGetProperty(try liveUnit(), kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, bus, &device, &size), "verify microphone route")
        guard size == UInt32(MemoryLayout<AudioDeviceID>.size) else { throw MeetingAudioFailure.invalidSelection }
        return device
    }

    private static func outputAddress() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private static func defaultOutputDevice() throws -> AudioDeviceID {
        var address = outputAddress()
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr, size == UInt32(MemoryLayout<AudioDeviceID>.size), device != kAudioObjectUnknown else {
            throw MeetingAudioFailure.invalidSelection
        }
        return device
    }

    private static func devicesAddress() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private static func deviceIsAlive(_ device: AudioDeviceID) -> Bool {
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &alive) == noErr &&
            size == UInt32(MemoryLayout<UInt32>.size) && alive == 1
    }

    func start() throws { try check(AudioOutputUnitStart(try liveUnit()), "AudioOutputUnitStart", fallback: .voiceStart) }
    func stop() throws {
        stopFormatMonitor()
        try check(AudioOutputUnitStop(try liveUnit()), "AudioOutputUnitStop")
    }
    func uninitialize() throws {
        stopFormatMonitor()
        try check(AudioUnitUninitialize(try liveUnit()), "AudioUnitUninitialize")
    }

    func dispose() throws {
        guard let unit else { return }
        stopFormatMonitor()
        if let deviceListener {
            var address = Self.devicesAddress()
            try check(AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),
                &address, deviceQueue, deviceListener), "remove microphone device listener")
            self.deviceListener = nil
        }
        if let referenceListener {
            var address = Self.outputAddress()
            try check(AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),
                &address, deviceQueue, referenceListener), "remove voice reference listener")
            self.referenceListener = nil
        }
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

    private func stopFormatMonitor() {
        // Drain any in-flight property read before uninitialization or disposal.
        deviceQueue.sync {
            formatMonitor?.cancel()
            formatMonitor = nil
        }
    }

    private func liveUnit() throws -> AudioUnit {
        guard let unit else { throw MeetingAudioFailure.invalidTransition }
        return unit
    }

    private static func voicePropertyDiagnostic(_ property: AudioUnitPropertyID) -> MeetingAudioFailureDiagnostic.Code {
        switch property {
        case kAudioOutputUnitProperty_EnableIO: return .voiceOutputEnable
        case kAUVoiceIOProperty_BypassVoiceProcessing: return .voiceBypass
        case kAUVoiceIOProperty_VoiceProcessingEnableAGC: return .voiceAGC
        case kAUVoiceIOProperty_OtherAudioDuckingConfiguration: return .voiceDucking
        case kAudioUnitProperty_SetRenderCallback: return .voiceRenderCallback
        default: return .voiceClientFormat
        }
    }

    private func check(_ status: OSStatus, _ operation: String, fallback: MeetingAudioFailureDiagnostic.Code? = nil) throws {
        guard status != noErr else { return }
        // Only direct VPIO setup errors may select the same-mic HAL path.
        // Semantic admission guards and listener/cleanup errors retain their types.
        if voiceProcessing, let fallback {
            throw MeetingVoiceProcessingUnavailable.setupFailure(status: status, operation: operation, diagnostic: fallback)
        }
        throw MeetingAudioFailure.deviceFailure(operation: operation, status: status)
    }
}
