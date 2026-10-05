import Foundation

/// Native-only contracts. A caller still needs separate meeting/device approval before upload.
enum MeetingAudioFailure: Error, Equatable {
    case invalidSelection
    case invalidFormat
    case invalidTimestamp
    case bufferFull
    case deviceFailure(operation: String, status: Int32)
    case invalidTransition
    case cleanupFailed
}

/// Calls are synchronous. Implementations must copy samples before returning, never retain pointers.
protocol MeetingAudioReceiving: AnyObject {
    func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float)
    func fail(_ failure: MeetingAudioFailure)
}

/// Constructors never open devices. The orchestrator serializes start/stop; callbacks use the receiver.
protocol MeetingAudioCapturing: AnyObject {
    func start(into receiver: MeetingAudioReceiving) throws
    func stop() throws
}

enum MeetingAudioSource: String, Equatable, CaseIterable {
    case microphone
    case output
}

/// AudioObjectIDs, not process IDs. Membership resolution/validation belongs to host preflight.
enum MeetingOutputScope: Equatable {
    case selectedProcesses([UInt32])
    case excludingProcesses([UInt32])

    func validate() throws {
        let ids: [UInt32]
        switch self {
        case .selectedProcesses(let values), .excludingProcesses(let values): ids = values
        }
        guard !ids.isEmpty, ids.count <= 128, !ids.contains(0), Set(ids).count == ids.count else {
            throw MeetingAudioFailure.invalidSelection
        }
    }
}

struct MeetingNativeSelection: Equatable {
    let microphoneDeviceID: UInt32
    /// Nil means microphone-only. Output route failure never changes this selection.
    let output: MeetingOutputScope?

    func validate() throws {
        guard microphoneDeviceID != 0 else { throw MeetingAudioFailure.invalidSelection }
        try output?.validate()
    }
}

struct MeetingAudioPacket: Equatable {
    let source: MeetingAudioSource
    let epoch: UInt64
    let sequence: UInt64
    let startNanoseconds: UInt64
    let sampleRate: Double
    let samples: [Float]

    var endNanoseconds: UInt64 {
        startNanoseconds + UInt64((Double(samples.count) * 1_000_000_000 / sampleRate).rounded(.up))
    }
}

enum MeetingAudioGapReason: Equatable {
    case paused
    case expired
    case bufferFull
    case captureFailure(MeetingAudioFailure)
}

struct MeetingAudioGap: Equatable {
    let source: MeetingAudioSource
    let epoch: UInt64
    let startNanoseconds: UInt64
    let endNanoseconds: UInt64
    let reason: MeetingAudioGapReason
}
