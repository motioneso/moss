import CoreAudio
import AudioToolbox
import Foundation

/// Resource seams expose acquisition order without invoking Core Audio from synthetic tests.
protocol MeetingOutputIO: AnyObject {
    func start() throws
    func stop() throws
    func destroy() throws
}

protocol MeetingOutputHardware {
    func createTap(scope: MeetingOutputScope) throws -> AudioObjectID
    func tapFormat(_ tap: AudioObjectID) throws -> AudioStreamBasicDescription
    func createAggregate(tap: AudioObjectID) throws -> AudioObjectID
    func createIO(device: AudioObjectID, tap: AudioObjectID, format: AudioStreamBasicDescription,
                  receiver: MeetingAudioReceiving) throws -> MeetingOutputIO
    func destroyAggregate(_ device: AudioObjectID) throws
    func destroyTap(_ tap: AudioObjectID) throws
}

/// Inert until explicit start. Resolved process membership is a precondition, not inferred here.
@available(macOS 14.2, *)
final class CoreAudioMeetingOutput: MeetingAudioCapturing {
    private let scope: MeetingOutputScope
    private let hardware: MeetingOutputHardware
    private var tap: AudioObjectID?
    private var aggregate: AudioObjectID?
    private var io: MeetingOutputIO?
    private var receiver: MeetingAudioReceiving?

    init(scope: MeetingOutputScope, hardware: MeetingOutputHardware = SystemMeetingOutputHardware()) {
        self.scope = scope
        self.hardware = hardware
    }

    func start(into receiver: MeetingAudioReceiving) throws {
        guard tap == nil, aggregate == nil, io == nil else { throw MeetingAudioFailure.invalidTransition }
        try scope.validate()
        self.receiver = receiver
        do {
            let newTap = try hardware.createTap(scope: scope)
            tap = newTap
            let format = try hardware.tapFormat(newTap)
            guard format.mFormatID == kAudioFormatLinearPCM,
                  format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
                  format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
                  format.mBitsPerChannel == 32, format.mChannelsPerFrame == 1,
                  format.mBytesPerFrame == 4, format.mSampleRate.isFinite,
                  (8000...192000).contains(format.mSampleRate) else { throw MeetingAudioFailure.invalidFormat }
            let device = try hardware.createAggregate(tap: newTap)
            aggregate = device
            let installed = try hardware.createIO(device: device, tap: newTap, format: format, receiver: receiver)
            io = installed
            try installed.start()
        } catch {
            receiver.fail(.deviceFailure(operation: "output-start", status: -1))
            do { try stop() } catch { throw MeetingAudioFailure.cleanupFailed }
            throw error
        }
    }

    /// A failed release retains its handles; a subsequent stop retries instead of losing ownership.
    func stop() throws {
        if let io {
            try io.stop()
            try io.destroy()
            self.io = nil
        }
        if let aggregate {
            try hardware.destroyAggregate(aggregate)
            self.aggregate = nil
        }
        if let tap {
            try hardware.destroyTap(tap)
            self.tap = nil
        }
        receiver = nil
    }

    deinit { try? stop() }
}

@available(macOS 14.2, *)
struct SystemMeetingOutputHardware: MeetingOutputHardware {
    func createTap(scope: MeetingOutputScope) throws -> AudioObjectID {
        try scope.validate()
        let description: CATapDescription
        switch scope {
        case .selectedProcesses(let ids): description = CATapDescription(monoMixdownOfProcesses: ids)
        case .excludingProcesses(let ids): description = CATapDescription(monoGlobalTapButExcludeProcesses: ids)
        }
        description.name = "Moss meeting output"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        var id = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &id), "create-output-tap")
        return id
    }

    func tapFormat(_ tap: AudioObjectID) throws -> AudioStreamBasicDescription {
        var value = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = property(kAudioTapPropertyFormat)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &value), "read-tap-format")
        return value
    }

    func createAggregate(tap: AudioObjectID) throws -> AudioObjectID {
        var uid: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        var address = property(kAudioTapPropertyUID)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &uid), "read-tap-uid")
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Moss meeting capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: uid, kAudioSubTapDriftCompensationKey: true]]
        ]
        var id = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(description as CFDictionary, &id), "create-output-aggregate")
        return id
    }

    func createIO(device: AudioObjectID, tap: AudioObjectID, format: AudioStreamBasicDescription,
                  receiver: MeetingAudioReceiving) throws -> MeetingOutputIO {
        SystemMeetingOutputIO(device: device, tap: tap, format: format, receiver: receiver)
    }

    func destroyAggregate(_ device: AudioObjectID) throws {
        try check(AudioHardwareDestroyAggregateDevice(device), "destroy-output-aggregate")
    }

    func destroyTap(_ tap: AudioObjectID) throws {
        try check(AudioHardwareDestroyProcessTap(tap), "destroy-output-tap")
    }

    private func property(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                   mElement: kAudioObjectPropertyElementMain)
    }

    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw MeetingAudioFailure.deviceFailure(operation: operation, status: status) }
    }
}

@available(macOS 14.2, *)
private final class SystemMeetingOutputIO: MeetingOutputIO {
    private let device: AudioObjectID
    private let queue = DispatchQueue(label: "com.moss.meeting.output-io")
    private var token: AudioDeviceIOProcID?
    private var started = false
    private let tap: AudioObjectID
    private let format: AudioStreamBasicDescription
    private let receiver: MeetingOutputReceiverGate
    private var listeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    init(device: AudioObjectID, tap: AudioObjectID, format: AudioStreamBasicDescription,
         receiver: MeetingAudioReceiving) {
        self.device = device
        self.tap = tap
        self.format = format
        self.receiver = MeetingOutputReceiverGate(receiver)
    }

    func start() throws {
        guard token == nil else { throw MeetingAudioFailure.invalidTransition }
        let receiver = self.receiver
        let format = self.format
        let status = AudioDeviceCreateIOProcIDWithBlock(&token, device, queue) { _, input, timestamp, _, _ in
            guard timestamp.pointee.mFlags.contains(.hostTimeValid) else {
                receiver.fail(.invalidTimestamp); return
            }
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard list.count == 1, let buffer = list.first, buffer.mNumberChannels == 1,
                  buffer.mDataByteSize > 0, buffer.mDataByteSize % 4 == 0,
                  let data = buffer.mData else { receiver.fail(.invalidFormat); return }
            let frames = Int(buffer.mDataByteSize / 4)
            guard frames <= MeetingAudioBuffer.maximumCallbackFrames else { receiver.fail(.bufferFull); return }
            let samples = data.assumingMemoryBound(to: Float.self)
            receiver.receive(hostTimeNanoseconds: AudioConvertHostTimeToNanos(timestamp.pointee.mHostTime),
                             sampleRate: format.mSampleRate, frameCount: frames, sampleAt: { samples[$0] })
        }
        try check(status, "install-output-io")
        // The adapter owns this object before acquisition. Failed setup retains every handle
        // so its normal stop path can release them or report a cleanup failure for retry.
        try observe(tap, selector: kAudioTapPropertyFormat, receiver: receiver)
        try observe(device, selector: kAudioDevicePropertyDeviceIsAlive, receiver: receiver)
        try observe(AudioObjectID(kAudioObjectSystemObject), selector: kAudioHardwarePropertyProcessObjectList,
                    receiver: receiver)
        guard let token else { throw MeetingAudioFailure.invalidTransition }
        // Permission may be requested by macOS here. No caller invokes this in preflight/tests.
        try receiver.open()
        started = true
        try check(AudioDeviceStart(device, token), "start-output-io")
    }

    private func observe(_ object: AudioObjectID, selector: AudioObjectPropertySelector,
                         receiver: MeetingAudioReceiving) throws {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                mElement: kAudioObjectPropertyElementMain)
        let listener: AudioObjectPropertyListenerBlock = { _, _ in receiver.fail(.invalidSelection) }
        try check(AudioObjectAddPropertyListenerBlock(object, &address, queue, listener), "observe-output-source")
        listeners.append((object, address, listener))
    }

    func stop() throws {
        receiver.close()
        guard started, let token else { return }
        try check(AudioDeviceStop(device, token), "stop-output-io")
        started = false
    }

    func destroy() throws {
        try stop()
        while let (object, storedAddress, listener) = listeners.last {
            var address = storedAddress
            try check(AudioObjectRemovePropertyListenerBlock(object, &address, queue, listener), "remove-output-listener")
            listeners.removeLast()
        }
        if let token {
            try check(AudioDeviceDestroyIOProcID(device, token), "destroy-output-io")
            self.token = nil
        }
    }

    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw MeetingAudioFailure.deviceFailure(operation: operation, status: status) }
    }

    deinit { receiver.close(); try? destroy() }
}

/// Gates even callbacks already queued by Core Audio before Stop returned.
final class MeetingOutputReceiverGate: MeetingAudioReceiving {
    private let downstream: MeetingAudioReceiving
    private let lock = NSLock()
    private var accepting = false
    private var invalidated = false
    init(_ downstream: MeetingAudioReceiving) { self.downstream = downstream }
    func open() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !invalidated else { throw MeetingAudioFailure.invalidSelection }
        accepting = true
    }
    func close() { lock.lock(); accepting = false; lock.unlock() }
    func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float) {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else { return }
        downstream.receive(hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate,
                           frameCount: frameCount, sampleAt: sampleAt)
    }
    func fail(_ failure: MeetingAudioFailure) {
        lock.lock()
        let report = accepting
        accepting = false
        invalidated = true
        lock.unlock()
        if report { downstream.fail(failure) }
    }
}
