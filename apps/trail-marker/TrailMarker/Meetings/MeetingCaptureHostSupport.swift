import Foundation

/// Stateless device construction and source labels need no access to recorder state.
extension MeetingCaptureHost {
    nonisolated static func devices(_ selection: MeetingNativeSelection) throws -> [MeetingAudioSource: MeetingAudioCapturing] {
        try devices(selection, makeMicrophoneUnit: MeetingMicrophoneIOUnit.init(voiceProcessing:))
    }

    nonisolated static func devices(_ selection: MeetingNativeSelection,
        makeMicrophoneUnit: @escaping (Bool) throws -> MeetingMicrophoneUnit
    ) throws -> [MeetingAudioSource: MeetingAudioCapturing] {
        try selection.validate()
        var devices: [MeetingAudioSource: MeetingAudioCapturing] = [:]
        if let microphone = selection.microphoneDeviceID {
            devices[.microphone] = MeetingMicrophoneCapture(selectedDeviceID: microphone, voiceProcessing: selection.output != nil,
                expectedReferenceDeviceID: selection.defaultOutputDeviceID, makeUnit: makeMicrophoneUnit)
        }
        if let output = selection.output {
            guard #available(macOS 14.2, *) else { throw MeetingHostError.unavailable }
            devices[.output] = CoreAudioMeetingOutput(scope: output,
                expectedDefaultOutputDeviceID: selection.defaultOutputDeviceID,
                expectedSystemOutputDeviceID: selection.defaultSystemOutputDeviceID)
        }
        return devices
    }

    static func describe(_ selection: MeetingCaptureChoice, inventory: MeetingCaptureInventory) -> String {
        let microphone = selection.microphone.map { requested in
            inventory.microphones.first { $0.deviceId == requested.deviceId && $0.sourceId == requested.sourceId }?.label ?? "Selected microphone"
        }
        guard let microphone else { return "Computer audio" }
        switch selection.mode {
        case "microphone-only": return microphone
        case "selected-app":
            let application = inventory.applications.first { $0.appProcessTreeId == selection.appProcessTreeId }?.label ?? "Selected app"
            return "\(microphone) and \(application)"
        default: return "\(microphone) and computer audio"
        }
    }
}

/// Read-only numeric metadata from the exact inventory used to select the capture scope.
/// It never participates in Resolved equality or changes which processes are excluded.
struct MeetingCaptureSourceDiagnostics {
    enum Reason: String {
        case microphonePermissionNotGranted = "microphone-permission-not-granted"
        case resolveThrew = "resolve-threw"
        case resolvedNotEqual = "resolved-not-equal"
    }
    private let count: Int
    private let exclusions: [(pid: Int32, audioObject: UInt32)]

    init(snapshot: MeetingInventorySnapshot) {
        count = snapshot.excluded.count
        exclusions = snapshot.excluded.sorted { $0.pid < $1.pid }.prefix(128).map {
            (pid: $0.pid, audioObject: snapshot.audioObjects[$0.pid] ?? 0)
        }
    }

    private var summary: String {
        let pairs = exclusions.map { "pid=\($0.pid)/audio-object=\($0.audioObject)" }.joined(separator: ",")
        // Object 0 means no mapping; count makes bounded/truncated output explicit.
        return "count=\(count),excluded=[\(pairs)]"
    }

    static func failure(_ reason: Reason, before: Self?, after: Self) -> String {
        guard reason == .resolvedNotEqual else { return reason.rawValue }
        return "\(reason.rawValue) before(\(before?.summary ?? "unavailable")) after(\(after.summary))"
    }
}

/// Bounded metadata only: no credentials, PCM, URLs or transcript text.
struct MeetingCaptureDiagnostics {
    private var lines: [String] = []
    private var audio: [MeetingAudioSource: String] = [:]

    mutating func resetAudio() { audio.removeAll() }

    /// Native failures contain fixed operation labels/statuses. Never render arbitrary NSError
    /// descriptions or userInfo: networking errors may carry private URLs or response content.
    static func interruptionReason(_ error: Error) -> String {
        if let failure = error as? MeetingAudioFailure { return String(describing: failure) }
        if let failure = error as? MeetingHostError { return String(describing: failure) }
        return "unexpectedError(code: \((error as NSError).code))"
    }

    mutating func sourceValidationFailed(_ detail: String) -> [String] {
        append("source-validation-failed: \(detail)")
        return lines
    }

    mutating func interrupted(reason: String) -> [String] {
        append("capture-paused: \(reason)")
        return lines
    }

    mutating func recordAudio(_ snapshots: [MeetingAudioSource: MeetingAudioBuffer.Diagnostics]) -> [String]? {
        var changed = false
        for (source, value) in snapshots {
            let line = "\(source.rawValue): dropped=\(value.droppedCallbacks), overflow=\(value.dropMailboxOverflows), discontinuities=\(value.sampleDiscontinuities), clockDifferenceNs=\(value.maximumHostClockDifferenceNanoseconds), capacityMs=\((value.effectiveCapacityNanoseconds ?? 0) / 1_000_000)"
            guard line != audio[source] else { continue }
            audio[source] = line
            append(line)
            changed = true
        }
        return changed ? lines : nil
    }

    mutating func gap(_ detail: String) -> [String] {
        append(detail)
        return lines
    }

    mutating func note(_ stage: String, duration: UInt64) -> [String] {
        append("\(stage): \(duration / 1_000_000) ms")
        return lines
    }

    private mutating func append(_ line: String) {
        lines.append(line)
        if lines.count > 32 { lines.removeFirst(lines.count - 32) }
    }
}

/// Per-source retry delays are value state, separate from request and credential ownership.
struct MeetingCaptureUploadRetry {
    private var deadlines: [MeetingAudioSource: UInt64] = [:]
    private var failures: [MeetingAudioSource: Int] = [:]

    func permits(_ source: MeetingAudioSource, at now: UInt64) -> Bool { now >= (deadlines[source] ?? 0) }

    mutating func acknowledge(_ source: MeetingAudioSource) {
        failures[source] = 0
        deadlines[source] = nil
    }

    mutating func schedule(_ source: MeetingAudioSource, after requested: UInt64?, now: UInt64) {
        let count = min(5, (failures[source] ?? 0) + 1)
        failures[source] = count
        let delay = min(86400000, max(1000, requested ?? UInt64(1 << count) * 500))
        deadlines[source] = now + delay * 1_000_000
    }
}

/// A retained task observation can wait for completion and inspect cancellation, but cannot cancel.
struct MeetingCaptureTaskProgress {
    private let task: Task<Void, Never>
    init(_ task: Task<Void, Never>) { self.task = task }
    var isCancelled: Bool { task.isCancelled }
    func callAsFunction() async { await task.value }
}
