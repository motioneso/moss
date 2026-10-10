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
    func verifyOutputRoutes(defaultOutput: AudioObjectID?, systemOutput: AudioObjectID?) throws
    func createTap(scope: MeetingOutputScope) throws -> AudioObjectID
    func tapFormat(_ tap: AudioObjectID) throws -> AudioStreamBasicDescription
    func createAggregate(tap: AudioObjectID) throws -> AudioObjectID
    func createIO(device: AudioObjectID, tap: AudioObjectID, scope: MeetingOutputScope, format: AudioStreamBasicDescription,
                  receiver: MeetingAudioReceiving) throws -> MeetingOutputIO
    func destroyAggregate(_ device: AudioObjectID) throws
    func destroyTap(_ tap: AudioObjectID) throws
}

extension MeetingOutputHardware {
    func verifyOutputRoutes(defaultOutput: AudioObjectID?, systemOutput: AudioObjectID?) throws {
        // Synthetic hardware must explicitly implement pinned-route verification.
        guard defaultOutput == nil, systemOutput == nil else { throw MeetingAudioFailure.invalidSelection }
    }
}

/// Inert until explicit start. Resolved process membership is a precondition, not inferred here.
@available(macOS 14.2, *)
final class CoreAudioMeetingOutput: MeetingAudioCapturing {
    private let scope: MeetingOutputScope
    private let hardware: MeetingOutputHardware
    private let expectedDefaultOutputDeviceID: AudioObjectID?
    private let expectedSystemOutputDeviceID: AudioObjectID?
    private var tap: AudioObjectID?
    private var aggregate: AudioObjectID?
    private var io: MeetingOutputIO?
    private var receiver: MeetingAudioReceiving?

    init(scope: MeetingOutputScope, expectedDefaultOutputDeviceID: AudioObjectID? = nil,
         expectedSystemOutputDeviceID: AudioObjectID? = nil,
         hardware: MeetingOutputHardware = SystemMeetingOutputHardware()) {
        self.scope = scope
        self.hardware = hardware
        self.expectedDefaultOutputDeviceID = expectedDefaultOutputDeviceID
        self.expectedSystemOutputDeviceID = expectedSystemOutputDeviceID
    }

    func start(into receiver: MeetingAudioReceiving) throws {
        guard tap == nil, aggregate == nil, io == nil else { throw MeetingAudioFailure.invalidTransition }
        try scope.validate()
        self.receiver = receiver
        do {
            try hardware.verifyOutputRoutes(defaultOutput: expectedDefaultOutputDeviceID, systemOutput: expectedSystemOutputDeviceID)
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
            try hardware.verifyOutputRoutes(defaultOutput: expectedDefaultOutputDeviceID, systemOutput: expectedSystemOutputDeviceID)
        } catch {
            receiver.fail(.deviceFailure(operation: "output-start", status: -1),
                diagnostic: .init(.outputStart, status: MeetingAudioFailureDiagnostic.status(error)))
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
    func verifyOutputRoutes(defaultOutput: AudioObjectID?, systemOutput: AudioObjectID?) throws {
        for (selector, expected) in [(kAudioHardwarePropertyDefaultOutputDevice, defaultOutput),
                                     (kAudioHardwarePropertyDefaultSystemOutputDevice, systemOutput)] {
            guard let expected else { continue }
            var current: AudioObjectID = kAudioObjectUnknown
            var size = UInt32(MemoryLayout<AudioObjectID>.size)
            var address = property(selector)
            try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &current), "verify-output-route")
            guard size == UInt32(MemoryLayout<AudioObjectID>.size), expected != kAudioObjectUnknown,
                  current == expected else { throw MeetingAudioFailure.invalidSelection }
            var alive: UInt32 = 0
            size = UInt32(MemoryLayout<UInt32>.size)
            address = property(kAudioDevicePropertyDeviceIsAlive)
            try check(AudioObjectGetPropertyData(expected, &address, 0, nil, &size, &alive), "verify-output-route-alive")
            guard size == UInt32(MemoryLayout<UInt32>.size), alive == 1 else { throw MeetingAudioFailure.invalidSelection }
        }
    }

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
        guard size == UInt32(MemoryLayout<AudioStreamBasicDescription>.size) else { throw MeetingAudioFailure.invalidFormat }
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
        let tap = self.tap
        let device = self.device
        let processIdentity = try Self.processIdentity(scope: scope)
        // Apple dispatches IO blocks synchronously. A nil queue avoids waiting behind
        // control-plane process/property reads on the listener queue.
        let status = AudioDeviceCreateIOProcIDWithBlock(&token, device, nil) { _, input, timestamp, _, _ in
            guard timestamp.pointee.mFlags.contains([.hostTimeValid, .sampleTimeValid]),
                  timestamp.pointee.mSampleTime.isFinite,
                  timestamp.pointee.mSampleTime.rounded() == timestamp.pointee.mSampleTime else {
                receiver.fail(.invalidTimestamp, diagnostic: .init(.outputTimestamp)); return
            }
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard list.count == 1, let buffer = list.first, buffer.mNumberChannels == 1,
                  buffer.mDataByteSize > 0, buffer.mDataByteSize % 4 == 0,
                  let data = buffer.mData else { receiver.fail(.invalidFormat, diagnostic: .init(.outputBufferLayout)); return }
            let frames = Int(buffer.mDataByteSize / 4)
            guard frames <= MeetingAudioBuffer.maximumCallbackFrames else { receiver.fail(.bufferFull, diagnostic: .init(.outputFrameCapacity)); return }
            let samples = data.assumingMemoryBound(to: Float.self)
            receiver.receive(sampleTime: timestamp.pointee.mSampleTime,
                             hostTimeNanoseconds: AudioConvertHostTimeToNanos(timestamp.pointee.mHostTime),
                             sampleRate: format.mSampleRate, frameCount: frames, sampleAt: { samples[$0] })
        }
        try check(status, "install-output-io")
        // The adapter owns this object before acquisition. Failed setup retains every handle
        // so its normal stop path can release them or report a cleanup failure for retry.
        let readFormat = { try SystemMeetingOutputHardware().tapFormat(tap) }
        try observe(tap, selector: kAudioTapPropertyFormat) {
            receiver.verifyFormat(expected: format, readCurrent: readFormat)
        }
        receiver.verifyFormat(expected: format, readCurrent: readFormat)
        try observe(device, selector: kAudioDevicePropertyDeviceIsAlive) {
            if !Self.deviceIsAlive(device) { receiver.fail(.invalidSelection, diagnostic: .init(.outputDeviceAlive)) }
        }
        guard Self.deviceIsAlive(device) else { throw MeetingAudioFailure.invalidSelection }
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice] {
            try observeRoute(AudioObjectID(kAudioObjectSystemObject), selector: selector, receiver: receiver)
        }
        try observe(AudioObjectID(kAudioObjectSystemObject), selector: kAudioHardwarePropertyDevices) {
            if !Self.deviceIsAlive(device) { receiver.fail(.invalidSelection, diagnostic: .init(.outputDeviceList)) }
        }
        if case .selectedProcesses(let objects) = scope {
            for object in objects {
                try observeRoute(object, selector: kAudioProcessPropertyDevices, receiver: receiver)
            }
        }
        try observe(AudioObjectID(kAudioObjectSystemObject), selector: kAudioHardwarePropertyProcessObjectList) {
            // Revalidate the complete Moss exclusion set before accepting this notice as
            // unrelated. New Moss helpers and unreadable identities still invalidate scope.
            receiver.verifyScope {
                !MeetingOutputProcessIdentity.invalidates(scope: scope, original: processIdentity,
                    readCurrent: { try Self.processIdentity(scope: scope) },
                    readExclusions: { try Self.mossAudioProcesses(original: processIdentity) })
            }
        }
        guard !MeetingOutputProcessIdentity.invalidates(scope: scope, original: processIdentity,
            readCurrent: { try Self.processIdentity(scope: scope) },
            readExclusions: { try Self.mossAudioProcesses(original: processIdentity) }) else {
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
                let code: MeetingAudioFailureDiagnostic.Code = selector == kAudioHardwarePropertyDefaultOutputDevice
                    ? .outputDefaultRoute : (selector == kAudioHardwarePropertyDefaultSystemOutputDevice ? .outputSystemRoute : .outputProcessRoute)
                receiver.fail(.invalidSelection, diagnostic: .init(code)); return
            }
        }
        // Ignore a coalesced notification caused by our own already-created aggregate, but
        // reject a route that changed across listener installation even when its format did not.
        guard try Self.routeObjects(object, selector: selector) == original else {
            throw MeetingAudioFailure.invalidSelection
        }
    }

    private static func deviceIsAlive(_ device: AudioObjectID) -> Bool {
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &alive) == noErr &&
            size == UInt32(MemoryLayout<UInt32>.size) && alive == 1
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

    private static func mossAudioProcesses(original: [AudioObjectID: Int32]) throws -> [AudioObjectID: Int32] {
        try MeetingOutputProcessIdentity.mossAudioProcesses(original: original,
            readList: { try routeObjects(AudioObjectID(kAudioObjectSystemObject), selector: kAudioHardwarePropertyProcessObjectList) },
            readPID: { object in
                let identity = try processIdentity(scope: .selectedProcesses([object]))
                guard let pid = identity[object] else { throw MeetingAudioFailure.invalidSelection }
                return pid
            })
    }

    func stop() throws {
        receiver.close(preservingFailures: true)
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
        // Property blocks queued before listener removal still carry hard evidence.
        // Drain them while the tap/aggregate exist and before sealing this old epoch.
        queue.sync {}
        if let token {
            try check(AudioDeviceDestroyIOProcID(device, token), "destroy-output-io")
            self.token = nil
        }
        receiver.finishFaultMonitoring()
    }

    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw MeetingAudioFailure.deviceFailure(operation: operation, status: status) }
    }

    deinit { receiver.close(); try? destroy() }
}

/// Read only identities in the original scope. App/helper membership is resolved by the host;
/// selected-app validation ignores unrelated processes and never edits the original object list.
enum MeetingOutputProcessIdentity {
    /// Shared by startup and process-list revalidation. Unreadable live paths remain uncertain.
    static func mossAudioProcesses(original: [UInt32: Int32],
                                   readList: () throws -> Set<UInt32>,
                                   readPID: (UInt32) throws -> Int32,
                                   readPath: (Int32) throws -> String = executablePath,
                                   readBundleIdentifier: (String) -> String? = { Bundle(path: $0)?.bundleIdentifier }) throws -> [UInt32: Int32] {
        var bundles = Set<String>()
        for pid in original.values {
            let executable = try readPath(pid)
            guard let bundle = MeetingOutputProcessIdentity.bundlePath(executable: executable) else {
                throw MeetingAudioFailure.invalidSelection
            }
            bundles.insert(bundle)
        }
        let listed = try readList()
        var current: [UInt32: Int32] = [:]
        // Core Audio can translate a process before listing it. Keep proving those original
        // exclusions too, while inspecting every newly visible process for a Moss bundle.
        for object in listed.union(original.keys) {
            do {
                let pid = try readPID(object)
                guard pid > 0 else { throw MeetingAudioFailure.invalidSelection }
                let executable = try readPath(pid)
                let ancestors = MeetingOutputProcessIdentity.bundlePaths(executable: executable)
                let identifiers = ancestors.compactMap { readBundleIdentifier($0) }
                if !ancestors.isEmpty, !ancestors.contains(where: bundles.contains), identifiers.isEmpty {
                    throw MeetingAudioFailure.invalidSelection
                }
                // A separately launched nested Moss app may live inside another app's bundle;
                // inspect every containing app identity, not only the outer package.
                let identifier = identifiers.first { $0.hasPrefix("com.moss.") } ?? identifiers.first
                if MeetingOutputProcessIdentity.isMossProcess(executable: executable, bundleIdentifier: identifier,
                                                             mossBundlePaths: bundles) { current[object] = pid }
            } catch {
                // A raced exit is harmless only after the stable system list proves it gone.
                if original[object] != nil { throw MeetingAudioFailure.invalidSelection }
                let remaining = try readList()
                if remaining.contains(object) { throw MeetingAudioFailure.invalidSelection }
            }
        }
        return current
    }

    static func executablePath(_ pid: Int32) throws -> String {
        var path = [CChar](repeating: 0, count: 4096)
        guard MMReadProcessPath(pid, &path, 4096) == 1 else { throw MeetingAudioFailure.invalidSelection }
        return URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
    }

    static func invalidates(scope: MeetingOutputScope, original: [UInt32: Int32],
                            readCurrent: () throws -> [UInt32: Int32],
                            readExclusions: (() throws -> [UInt32: Int32])? = nil) -> Bool {
        guard let current = try? readCurrent(), current == original else { return true }
        if case .excludingProcesses = scope {
            guard let readExclusions, let exclusions = try? readExclusions() else { return true }
            return exclusions != original
        }
        return false
    }

    static func bundlePaths(executable: String) -> [String] {
        var result: [String] = []
        var remaining = executable.startIndex..<executable.endIndex
        while let boundary = executable.range(of: ".app/", range: remaining) {
            result.append(String(executable[..<boundary.upperBound].dropLast()))
            remaining = boundary.upperBound..<executable.endIndex
        }
        return result
    }
    static func bundlePath(executable: String) -> String? { bundlePaths(executable: executable).first }

    static func isMossProcess(executable: String, bundleIdentifier: String?, mossBundlePaths: Set<String>) -> Bool {
        mossBundlePaths.contains { executable.hasPrefix($0 + "/") } || bundleIdentifier?.hasPrefix("com.moss.") == true
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
    private let formatReadLock = NSLock()
    private let formatVerification = MeetingAudioAtomicState()
    // Bits: 1 = opened, 2 = invalidated, 4 = closed, 8 = drain faults, 16 = disposed.
    // Only value 1 admits audio; teardown retains hard evidence until listeners drain.
    private let admission = MeetingAudioAtomicState()
    init(_ downstream: MeetingAudioReceiving) { self.downstream = downstream }
    func open() throws {
        guard admission.replace(0, with: 1) else { throw MeetingAudioFailure.invalidSelection }
    }
    func close(preservingFailures: Bool = false) {
        admission.insert(preservingFailures ? 12 : 4)
        copyLock.lock()
        copyLock.unlock()
    }
    func finishFaultMonitoring() { admission.insert(16) }
    func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float) {
        receive(sampleTime: (Double(hostTimeNanoseconds) * sampleRate / 1_000_000_000).rounded(),
                hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate, frameCount: frameCount, sampleAt: sampleAt)
    }
    func receive(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double,
                 frameCount: Int, sampleAt: (Int) -> Float) {
        guard copyLock.try() else {
            drop(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate, frameCount: frameCount)
            return
        }
        defer { copyLock.unlock() }
        guard admission.value == 1 else { return }
        guard formatVerification.value == 0 else {
            drop(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate, frameCount: frameCount)
            return
        }
        downstream.receive(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate,
                           frameCount: frameCount, sampleAt: sampleAt)
    }
    func drop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int) {
        guard admission.value == 1 else { return }
        downstream.drop(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds,
                        sampleRate: sampleRate, frameCount: frameCount)
    }
    /// Only property-monitor/control queues call this; no format queries run on the IO callback.
    func verifyFormat(expected: AudioStreamBasicDescription,
                      readCurrent: () throws -> AudioStreamBasicDescription) {
        formatReadLock.lock()
        defer { formatReadLock.unlock() }
        guard acceptsFaults else { return }
        formatVerification.exchange(1)
        defer { formatVerification.exchange(0) }
        guard let current = try? readCurrent() else {
            fail(.invalidFormat, diagnostic: .init(.outputFormatVerification)); return
        }
        guard !MeetingMicrophoneCapture.matches(current, expected) else { return }
        guard MeetingMicrophoneCapture.isSupportedPCM(current), current.mChannelsPerFrame == 1,
              current.mFormatFlags & kAudioFormatFlagIsFloat != 0, current.mBitsPerChannel == 32,
              current.mBytesPerFrame == 4 else {
            fail(.invalidFormat, diagnostic: .init(.outputFormatVerification)); return
        }
        fail(.sourceReconfigured, diagnostic: .init(.outputFormatVerification))
    }
    /// Source verification holds both callback and queued-send admission while checking.
    /// A successful unrelated notice creates only an explicit short callback gap. Uncertainty
    /// invalidates the epoch, so the host discards retained audio before any later flush.
    func verifyScope(_ unchanged: () -> Bool) {
        formatReadLock.lock()
        defer { formatReadLock.unlock() }
        guard acceptsFaults else { return }
        formatVerification.exchange(1)
        downstream.setScopeVerificationPending(true)
        defer {
            downstream.setScopeVerificationPending(false)
            formatVerification.exchange(0)
        }
        if !unchanged() { fail(.invalidSelection, diagnostic: .init(.outputProcessScope)) }
    }

    func setScopeVerificationPending(_ pending: Bool) { downstream.setScopeVerificationPending(pending) }

    private var acceptsFaults: Bool {
        let state = admission.value
        return state & 16 == 0 && (state & 4 == 0 || state & 8 != 0)
    }

    func fail(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic) {
        let previous = admission.insert(2)
        if acceptsFaults, previous & 1 != 0, previous & 2 == 0 || failure != .sourceReconfigured {
            downstream.fail(failure, diagnostic: diagnostic)
        }
    }

    func fail(_ failure: MeetingAudioFailure) {
        let previous = admission.insert(2)
        if acceptsFaults, previous & 1 != 0, previous & 2 == 0 || failure != .sourceReconfigured { downstream.fail(failure) }
    }
}
