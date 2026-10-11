import AppKit
import CoreAudio
import Foundation

struct MeetingProcessIdentity: Equatable {
    let pid: Int32
    let parentPID: Int32
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
    let executable: String
    var key: String { "\(pid):\(startedSeconds):\(startedMicroseconds)" }
}
struct MeetingProcessRoot: Equatable {
    let process: MeetingProcessIdentity
    let bundlePath: String
    let label: String
    var applicationId: String? = nil
}

/// Selected-app membership must satisfy both ancestry and the selected app's bundle boundary.
/// A similarly named process or recycled PID cannot silently join a selected app instance.
enum MeetingProcessScope {
    static func members(of root: MeetingProcessRoot, processes: [MeetingProcessIdentity]) -> [MeetingProcessIdentity] {
        guard processes.contains(root.process) else { return [] }
        let byPID = Dictionary(uniqueKeysWithValues: processes.map { ($0.pid, $0) })
        return processes.filter { process in
            guard process.executable.hasPrefix(root.bundlePath + "/") else { return false }
            var cursor = process
            var seen = Set<Int32>()
            while seen.insert(cursor.pid).inserted {
                if cursor == root.process { return true }
                guard let parent = byPID[cursor.parentPID] else { return false }
                cursor = parent
            }
            return false
        }.sorted { $0.pid < $1.pid }
    }

    static func exclusions(bundlePaths: Set<String>, processes: [MeetingProcessIdentity]) -> [MeetingProcessIdentity] {
        processes.filter { process in
            bundlePaths.contains { process.executable.hasPrefix($0 + "/") }
        }.sorted { $0.pid < $1.pid }
    }
}

struct MeetingInventorySnapshot {
    let wire: MeetingCaptureInventory
    let microphones: [String: AudioObjectID]
    let applications: [String: MeetingProcessRoot]
    let processes: [MeetingProcessIdentity]
    let audioObjects: [Int32: AudioObjectID]
    let excluded: [MeetingProcessIdentity]
    var audioRoutes: [Int32: [AudioObjectID]] = [:]
    var defaultOutputDeviceID: AudioObjectID? = nil
    var defaultSystemOutputDeviceID: AudioObjectID? = nil

    struct Resolved: Equatable {
        let selection: MeetingNativeSelection
        let members: [MeetingProcessIdentity]
        let exclusions: [MeetingProcessIdentity]
        var outputRoutes: [Int32: [AudioObjectID]] = [:]
    }

    /// Only omissions can be a startup inventory race. A positively observed new/replaced
    /// process or object is never retried, even if a later snapshot would hide it again.
    func onlyOmitsStartupSources(from original: Self, choice: MeetingCaptureChoice) -> Bool {
        guard choice.mode != "selected-app" else { return false }
        if choice.outputSourceId != nil {
            guard defaultOutputDeviceID == original.defaultOutputDeviceID,
                  defaultSystemOutputDeviceID == original.defaultSystemOutputDeviceID else { return false }
        }
        if let microphone = choice.microphone,
           let current = microphones[microphone.deviceId], current != original.microphones[microphone.deviceId] { return false }
        guard choice.mode == "computer-audio" else { return true }
        guard excluded.allSatisfy({ original.excluded.contains($0) }) else { return false }
        for before in original.excluded {
            if let current = processes.first(where: { $0.pid == before.pid }), current != before { return false }
            if let object = audioObjects[before.pid], object != original.audioObjects[before.pid] { return false }
        }
        return true
    }

    func resolve(_ choice: MeetingCaptureChoice) throws -> Resolved {
        let microphone: AudioObjectID?
        if let requested = choice.microphone {
            let matches = wire.microphones.filter { $0.deviceId == requested.deviceId && $0.sourceId == requested.sourceId }
            guard matches.count == 1,
                  wire.microphones.filter({ $0.deviceId == requested.deviceId }).count == 1,
                  wire.microphones.filter({ $0.sourceId == requested.sourceId }).count == 1,
                  let device = microphones[requested.deviceId], device != 0 else {
                throw MeetingHostError.unavailable
            }
            microphone = device
        } else {
            guard choice.mode == "computer-audio" else { throw MeetingHostError.unavailable }
            microphone = nil
        }
        if let output = choice.outputSourceId {
            guard wire.systemAudioPermission != .denied, !output.isEmpty, !wire.microphones.contains(where: { $0.sourceId == output }) else {
                throw MeetingHostError.unavailable
            }
        }
        switch choice.mode {
        case "microphone-only":
            guard choice.outputSourceId == nil, choice.appProcessTreeId == nil, choice.scope == nil, choice.applicationId == nil else {
                throw MeetingHostError.unavailable
            }
            return Resolved(selection: MeetingNativeSelection(microphoneDeviceID: microphone, output: nil), members: [], exclusions: [])
        case "selected-app":
            guard let id = choice.appProcessTreeId, let root = applications[id],
                  choice.outputSourceId != nil, choice.scope == nil,
                  choice.applicationId == nil || choice.applicationId == root.applicationId else { throw MeetingHostError.unavailable }
            let members = MeetingProcessScope.members(of: root, processes: processes)
            let ids = members.compactMap { audioObjects[$0.pid] }.sorted()
            guard !ids.isEmpty, !members.contains(where: { excluded.contains($0) }) else { throw MeetingHostError.unavailable }
            let selection = MeetingNativeSelection(microphoneDeviceID: microphone, output: .selectedProcesses(ids),
                defaultOutputDeviceID: defaultOutputDeviceID, defaultSystemOutputDeviceID: defaultSystemOutputDeviceID)
            try selection.validate()
            return Resolved(selection: selection, members: members, exclusions: [],
                outputRoutes: audioRoutes.filter { pair in members.contains { $0.pid == pair.key } })
        case "computer-audio":
            guard wire.computerAudio.available, choice.scope?.kind == "process-exclusion",
                  choice.scope?.endpointId == nil, let declared = choice.scope?.excludedProcessTreeIds,
                  !declared.isEmpty, Set(declared).count == declared.count,
                  Set(declared) == Set(wire.computerAudio.excludedProcessTreeIds),
                  choice.outputSourceId != nil, choice.appProcessTreeId == nil, choice.applicationId == nil else { throw MeetingHostError.unavailable }
            let ids = excluded.compactMap { audioObjects[$0.pid] }.sorted()
            guard !ids.isEmpty else { throw MeetingHostError.unavailable }
            let selection = MeetingNativeSelection(microphoneDeviceID: microphone, output: .excludingProcesses(ids),
                defaultOutputDeviceID: defaultOutputDeviceID, defaultSystemOutputDeviceID: defaultSystemOutputDeviceID)
            try selection.validate()
            // Computer capture deliberately includes unrelated apps. Their process/route
            // churn does not change the approved Moss exclusion or the tap's own route.
            return Resolved(selection: selection, members: [], exclusions: excluded)
        default: throw MeetingHostError.unavailable
        }
    }
}

/// Enumerates devices and processes only. No AudioUnit, tap, aggregate, IOProc or capture call.
@MainActor
final class MeetingCaptureInventoryReader {
    func read() throws -> MeetingInventorySnapshot {
        let devices = try objectList(AudioObjectID(kAudioObjectSystemObject), selector: kAudioHardwarePropertyDevices)
        let defaultInput = MeetingMicrophoneInventory.defaultInputDevice { try self.integer($0, selector: $1) }
        var microphones: [String: AudioObjectID] = [:]
        var wireMicrophones: [MeetingCaptureInventory.Microphone] = []
        for device in devices {
            let streams = try objectList(device, selector: kAudioDevicePropertyStreams, scope: kAudioDevicePropertyScopeInput)
            guard !streams.isEmpty, (try? integer(device, selector: kAudioDevicePropertyDeviceIsAlive)) == 1,
                  let uid = try? string(device, selector: kAudioDevicePropertyDeviceUID), !uid.isEmpty else { continue }
            let label = (try? string(device, selector: kAudioObjectPropertyName)) ?? "Microphone"
            guard label != "Moss meeting capture" else { continue }
            microphones[uid] = device
            wireMicrophones.append(.init(deviceId: uid, sourceId: "microphone-\(MeetingCaptureClient.verifierHash(uid).prefix(24))", label: String(label.prefix(120))))
        }
        let processes = try processSnapshot()
        let byPID = Dictionary(uniqueKeysWithValues: processes.map { ($0.pid, $0) })
        var mossBundles: Set<String> = [Bundle.main.bundleURL.resolvingSymlinksInPath().path]
        var applications: [String: MeetingProcessRoot] = [:]
        for app in NSWorkspace.shared.runningApplications {
            guard let bundle = app.bundleURL?.resolvingSymlinksInPath().path,
                  let process = byPID[app.processIdentifier] else { continue }
            if app.bundleIdentifier?.hasPrefix("com.moss.") == true {
                mossBundles.insert(bundle)
                continue
            }
            guard app.activationPolicy == .regular, !app.isTerminated else { continue }
            applications[process.key] = MeetingProcessRoot(process: process, bundlePath: bundle,
                label: String((app.localizedName ?? "Application").prefix(120)), applicationId: app.bundleIdentifier)
        }
        let excluded = MeetingProcessScope.exclusions(bundlePaths: mossBundles, processes: processes)
        var audioObjects: [Int32: AudioObjectID] = [:]
        var audioRoutes: [Int32: [AudioObjectID]] = [:]
        if #available(macOS 14.2, *) {
            for object in try objectList(AudioObjectID(kAudioObjectSystemObject), selector: kAudioHardwarePropertyProcessObjectList) {
                let pid = Int32(bitPattern: try integer(object, selector: kAudioProcessPropertyPID))
                guard pid > 0 else { continue }
                // Ambiguous mappings are rejected rather than selecting an arbitrary process object.
                guard audioObjects[pid] == nil else { throw MeetingHostError.unavailable }
                audioObjects[pid] = object
                audioRoutes[pid] = try objectList(object, selector: kAudioProcessPropertyDevices).sorted()
            }
            // Some Core Audio clients are translatable before appearing in the list. This is a
            // read-only property lookup, never a permission test or an audio-device activation.
            for process in excluded where audioObjects[process.pid] == nil {
                if let object = try? translateProcess(process.pid), object != kAudioObjectUnknown {
                    audioObjects[process.pid] = object
                }
            }
        }
        let hasOwnExclusion = excluded.contains { $0.pid == ProcessInfo.processInfo.processIdentifier && audioObjects[$0.pid] != nil }
        let wireApps = applications.values.filter {
            MeetingProcessScope.members(of: $0, processes: processes).contains { audioObjects[$0.pid] != nil }
        }.map { MeetingCaptureInventory.Application(appProcessTreeId: $0.process.key, label: $0.label, applicationId: $0.applicationId) }
        let wire = MeetingCaptureInventory(microphones: MeetingMicrophoneInventory.ordered(wireMicrophones),
            applications: wireApps.sorted { $0.label < $1.label },
            computerAudio: .init(available: hasOwnExclusion, excludedProcessTreeIds: excluded.map(\.key)),
            microphonePermission: MeetingCapturePermissions.microphone, systemAudioPermission: .unknown,
            defaultMicrophoneId: MeetingMicrophoneInventory.defaultMicrophoneId(device: defaultInput,
                devices: microphones, microphones: wireMicrophones))
        return MeetingInventorySnapshot(wire: wire, microphones: microphones, applications: applications,
            processes: processes, audioObjects: audioObjects, excluded: excluded, audioRoutes: audioRoutes,
            defaultOutputDeviceID: try? physicalOutput(kAudioHardwarePropertyDefaultOutputDevice),
            defaultSystemOutputDeviceID: try? physicalOutput(kAudioHardwarePropertyDefaultSystemOutputDevice))
    }

    private func physicalOutput(_ selector: AudioObjectPropertySelector) throws -> AudioObjectID {
        let device = try integer(AudioObjectID(kAudioObjectSystemObject), selector: selector)
        guard device != kAudioObjectUnknown, try integer(device, selector: kAudioDevicePropertyDeviceIsAlive) == 1 else {
            throw MeetingHostError.unavailable
        }
        return device
    }

    @available(macOS 14.2, *)
    private func translateProcess(_ pid: Int32) throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var pid = pid
        var object: AudioObjectID = kAudioObjectUnknown
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<Int32>.size),
            &pid, &size, &object) == noErr else { throw MeetingHostError.unavailable }
        return object
    }

    private func processSnapshot() throws -> [MeetingProcessIdentity] {
        var pids = [Int32](repeating: 0, count: 8192)
        let capacity = pids.count
        let count = MMListProcesses(&pids, capacity)
        guard count > 0 else { throw MeetingHostError.unavailable }
        return pids.prefix(Int(count)).compactMap { pid in
            var identity = MMProcessIdentity()
            guard MMReadProcess(pid, &identity) == 1 else { return nil }
            let executable = withUnsafePointer(to: &identity.executable) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: 4096) { String(cString: $0) }
            }
            return MeetingProcessIdentity(pid: identity.pid, parentPID: identity.parent_pid,
                startedSeconds: identity.start_seconds, startedMicroseconds: identity.start_microseconds,
                executable: URL(fileURLWithPath: executable).resolvingSymlinksInPath().path)
        }
    }

    private func objectList(_ object: AudioObjectID, selector: AudioObjectPropertySelector,
                            scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) throws -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr,
              size <= 131072, size % UInt32(MemoryLayout<AudioObjectID>.stride) == 0 else { throw MeetingHostError.unavailable }
        guard size > 0 else { return [] }
        var values = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.stride)
        let capacity = size
        let status = values.withUnsafeMutableBytes { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!) }
        guard status == noErr, size <= capacity else { throw MeetingHostError.unavailable }
        return Array(values.prefix(Int(size) / MemoryLayout<AudioObjectID>.stride))
    }

    private func integer(_ object: AudioObjectID, selector: AudioObjectPropertySelector) throws -> UInt32 {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr,
              size == UInt32(MemoryLayout<UInt32>.size) else { throw MeetingHostError.unavailable }
        return value
    }

    private func string(_ object: AudioObjectID, selector: AudioObjectPropertySelector) throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else {
            throw MeetingHostError.unavailable
        }
        return value.takeRetainedValue() as String
    }
}
