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
    func createIO(device: AudioObjectID, tap: AudioObjectID, scope: MeetingOutputScope, format: AudioStreamBasicDescription,
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
                  (8000...192000).contains(format.mSampleRate),
                  format.mSampleRate.rounded() == format.mSampleRate else { throw MeetingAudioFailure.invalidFormat }
            let device = try hardware.createAggregate(tap: newTap)
            aggregate = device
            let installed = try hardware.createIO(device: device, tap: newTap, scope: scope, format: format, receiver: receiver)
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
        var address = property(kAudioTapPropertyUID)
        let uid = try Self.readTapUID { size, value in
            AudioObjectGetPropertyData(tap, &address, 0, nil, size, value)
        }
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

    /// AudioHardware.h specifies that kAudioTapPropertyUID returns a caller-owned CFString.
    /// The C write must target unmanaged pointer storage, not overwrite an ARC-managed value.
    /// The injected read is synchronous and must not retain either output pointer.
    static func readTapUID(
        _ read: (UnsafeMutablePointer<UInt32>, UnsafeMutableRawPointer) -> OSStatus
    ) throws -> CFString {
        var value: Unmanaged<CFString>?
        let expectedSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var size = expectedSize
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            read(&size, UnsafeMutableRawPointer(pointer))
        }
        guard status == noErr else {
            throw MeetingAudioFailure.deviceFailure(operation: "read-tap-uid", status: status)
        }
        // Do not interpret a partial pointer or an unsuccessful read as an owned CF object.
        guard size == expectedSize, let value else { throw MeetingAudioFailure.invalidFormat }
        return value.takeRetainedValue()
    }

    func createIO(device: AudioObjectID, tap: AudioObjectID, scope: MeetingOutputScope, format: AudioStreamBasicDescription,
                  receiver: MeetingAudioReceiving) throws -> MeetingOutputIO {
        SystemMeetingOutputIO(device: device, tap: tap, scope: scope, format: format, receiver: receiver)
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
    private let queue = DispatchQueue(label: "com.moss.meeting.output-properties")
    private var token: AudioDeviceIOProcID?
    private var started = false
    private let tap: AudioObjectID
    private let scope: MeetingOutputScope
    private let format: AudioStreamBasicDescription
    private let receiver: MeetingOutputReceiverGate
    private var listeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    init(device: AudioObjectID, tap: AudioObjectID, scope: MeetingOutputScope, format: AudioStreamBasicDescription,
         receiver: MeetingAudioReceiving) {
        self.device = device
        self.tap = tap
        self.scope = scope
        self.format = format
        self.receiver = MeetingOutputReceiverGate(receiver)
    }

    func start() throws {
        guard token == nil else { throw MeetingAudioFailure.invalidTransition }
        let receiver = self.receiver
        let format = self.format
        let scope = self.scope
        let processIdentity = try Self.processIdentity(scope: scope)
        // Apple dispatches IO blocks synchronously. A nil queue avoids waiting behind
        // control-plane process/property reads on the listener queue.
        let status = AudioDeviceCreateIOProcIDWithBlock(&token, device, nil) { _, input, timestamp, _, _ in
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
        try observe(tap, selector: kAudioTapPropertyFormat) { receiver.fail(.invalidFormat) }
        try observe(device, selector: kAudioDevicePropertyDeviceIsAlive) { receiver.fail(.invalidSelection) }
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice,
                         kAudioHardwarePropertyDevices] {
            try observeRoute(AudioObjectID(kAudioObjectSystemObject), selector: selector, receiver: receiver)
        }
        if case .selectedProcesses(let objects) = scope {
            for object in objects {
                try observeRoute(object, selector: kAudioProcessPropertyDevices, receiver: receiver)
            }
        }
        try observe(AudioObjectID(kAudioObjectSystemObject), selector: kAudioHardwarePropertyProcessObjectList) {
            // A global exclusion tap cannot prove whether a newly appearing process is a
            // Moss helper before it renders. Pause conservatively; the host must resolve a
            // fresh exclusion set on explicit Resume. Selected-app taps remain narrow.
            if MeetingOutputProcessIdentity.invalidates(scope: scope, original: processIdentity,
                readCurrent: { try Self.processIdentity(scope: scope) }) { receiver.fail(.invalidSelection) }
        }
        guard try Self.processIdentity(scope: scope) == processIdentity else {
            throw MeetingAudioFailure.invalidSelection
        }
        guard let token else { throw MeetingAudioFailure.invalidTransition }
        // Permission may be requested by macOS here. No caller invokes this in preflight/tests.
        try receiver.open()
        started = true
        try check(AudioDeviceStart(device, token), "start-output-io")
    }

    private func observe(_ object: AudioObjectID, selector: AudioObjectPropertySelector,
                         changed: @escaping () -> Void) throws {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                mElement: kAudioObjectPropertyElementMain)
        let listener: AudioObjectPropertyListenerBlock = { _, _ in changed() }
        try check(AudioObjectAddPropertyListenerBlock(object, &address, queue, listener), "observe-output-source")
        listeners.append((object, address, listener))
    }

    private func observeRoute(_ object: AudioObjectID, selector: AudioObjectPropertySelector,
                              receiver: MeetingAudioReceiving) throws {
        let original = try Self.routeObjects(object, selector: selector)
        try observe(object, selector: selector) {
            guard let current = try? Self.routeObjects(object, selector: selector), current == original else {
                receiver.fail(.invalidSelection); return
            }
        }
        // Ignore a coalesced notification caused by our own already-created aggregate, but
        // reject a route that changed across listener installation even when its format did not.
        guard try Self.routeObjects(object, selector: selector) == original else {
            throw MeetingAudioFailure.invalidSelection
        }
    }

    private static func routeObjects(_ object: AudioObjectID,
                                     selector: AudioObjectPropertySelector) throws -> Set<AudioObjectID> {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr,
              size <= 65_536, size % UInt32(MemoryLayout<AudioObjectID>.size) == 0 else {
            throw MeetingAudioFailure.invalidSelection
        }
        guard size > 0 else { return [] }
        let capacity = size
        var values = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        let status = values.withUnsafeMutableBytes {
            AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!)
        }
        guard status == noErr, size <= capacity, size % UInt32(MemoryLayout<AudioObjectID>.size) == 0 else {
            throw MeetingAudioFailure.invalidSelection
        }
        return Set(values.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    private static func processIdentity(scope: MeetingOutputScope) throws -> [AudioObjectID: Int32] {
        try MeetingOutputProcessIdentity.snapshot(scope: scope) { object in
            var pid: Int32 = 0
            var size = UInt32(MemoryLayout<Int32>.size)
            var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyPID,
                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid)
            guard status == noErr, size == UInt32(MemoryLayout<Int32>.size), pid > 0 else {
                throw MeetingAudioFailure.invalidSelection
            }
            return pid
        }
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
            let status = AudioObjectRemovePropertyListenerBlock(object, &address, queue, listener)
            // A selected process can be destroyed before cleanup. There is no live object to
            // unregister from in that case; queued blocks retain their closed receiver gate.
            if status != kAudioHardwareBadObjectError { try check(status, "remove-output-listener") }
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

/// Read only identities in the original scope. App/helper membership is resolved by the host;
/// selected-app validation ignores unrelated processes and never edits the original object list.
enum MeetingOutputProcessIdentity {
    static func invalidates(scope: MeetingOutputScope, original: [UInt32: Int32],
                            readCurrent: () throws -> [UInt32: Int32]) -> Bool {
        if case .excludingProcesses = scope { return true }
        guard let current = try? readCurrent() else { return true }
        return current != original
    }

    static func snapshot(scope: MeetingOutputScope, readPID: (UInt32) throws -> Int32) throws -> [UInt32: Int32] {
        try scope.validate()
        let ids: [UInt32]
        switch scope {
        case .selectedProcesses(let values), .excludingProcesses(let values): ids = values
        }
        var identity: [UInt32: Int32] = [:]
        for id in ids {
            let pid = try readPID(id)
            guard pid > 0 else { throw MeetingAudioFailure.invalidSelection }
            identity[id] = pid
        }
        return identity
    }
}

/// Gates even callbacks already queued by Core Audio before Stop returned.
final class MeetingOutputReceiverGate: MeetingAudioReceiving {
    private let downstream: MeetingAudioReceiving
    private let copyLock = NSLock()
    // Bits: 1 = opened, 2 = invalidated, 4 = closed permanently. Only value 1 admits audio.
    private let admission = MeetingAudioAtomicState()
    init(_ downstream: MeetingAudioReceiving) { self.downstream = downstream }
    func open() throws {
        guard admission.replace(0, with: 1) else { throw MeetingAudioFailure.invalidSelection }
    }
    func close() {
        admission.insert(4)
        copyLock.lock()
        copyLock.unlock()
    }
    func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float) {
        guard copyLock.try() else { fail(.bufferFull); return }
        defer { copyLock.unlock() }
        guard admission.value == 1 else { return }
        downstream.receive(hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate,
                           frameCount: frameCount, sampleAt: sampleAt)
    }
    func fail(_ failure: MeetingAudioFailure) {
        let previous = admission.insert(2)
        if previous == 1 || (previous == 3 && failure == .invalidSelection) { downstream.fail(failure) }
    }
}
