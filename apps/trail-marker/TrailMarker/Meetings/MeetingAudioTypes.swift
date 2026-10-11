import Foundation

/// Native-only contracts. A caller still needs a scoped per-meeting device grant before upload.
enum MeetingAudioFailure: Error, Equatable {
    case invalidSelection
    case invalidFormat
    case invalidTimestamp
    /// Verified supported format change or numerically valid clock discontinuity only.
    case sourceReconfigured
    case bufferFull
    case leaseExpired
    case deviceFailure(operation: String, status: Int32)
    case invalidTransition
    case cleanupFailed
}

/// Calls are synchronous and must not wait on a contended lock. Implementations must copy
/// samples before returning, never retain pointers; failure reporting must also be nonblocking.
protocol MeetingAudioReceiving: AnyObject {
    func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float)
    func receive(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double,
                 frameCount: Int, sampleAt: (Int) -> Float)
    func drop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int)
    func fail(_ failure: MeetingAudioFailure)
    func fail(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic)
    func setScopeVerificationPending(_ pending: Bool)
}

extension MeetingAudioReceiving {
    func fail(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic) { fail(failure) }
    func setScopeVerificationPending(_ pending: Bool) {}
    // Compatibility for synthetic receivers. Native adapters always provide the hardware sample clock.
    func receive(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double,
                 frameCount: Int, sampleAt: (Int) -> Float) {
        receive(hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate,
                frameCount: frameCount, sampleAt: sampleAt)
    }
    func drop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int) {
        fail(.invalidTimestamp)
    }
}

/// Constructors never open devices. The orchestrator serializes start/stop; callbacks use the receiver.
protocol MeetingAudioCapturing: AnyObject {
    var startupDiagnostic: String? { get }
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

extension MeetingAudioCapturing {
    var startupDiagnostic: String? { nil }
}

struct MeetingNativeSelection: Equatable {
    let microphoneDeviceID: UInt32?
    /// Nil means microphone-only. Output route failure never changes this selection.
    let output: MeetingOutputScope?
    /// Physical routes captured with the approved inventory. Nil remains valid for
    /// synthetic/startup callers, but cannot authorize automatic output recovery.
    var defaultOutputDeviceID: UInt32? = nil
    var defaultSystemOutputDeviceID: UInt32? = nil

    var hasPinnedOutputRoutes: Bool {
        output == nil || (defaultOutputDeviceID != nil && defaultOutputDeviceID != 0 &&
            defaultSystemOutputDeviceID != nil && defaultSystemOutputDeviceID != 0)
    }

    var sources: Set<MeetingAudioSource> {
        var result = Set<MeetingAudioSource>()
        if microphoneDeviceID != nil { result.insert(.microphone) }
        if output != nil { result.insert(.output) }
        return result
    }

    func validate() throws {
        guard microphoneDeviceID != 0, microphoneDeviceID != nil || output != nil else {
            throw MeetingAudioFailure.invalidSelection
        }
        if microphoneDeviceID == nil, case .selectedProcesses? = output { throw MeetingAudioFailure.invalidSelection }
        guard defaultOutputDeviceID != 0, defaultSystemOutputDeviceID != 0 else {
            throw MeetingAudioFailure.invalidSelection
        }
        try output?.validate()
    }
}

/// Cumulative integer boundaries avoid a fresh fractional rounding error per callback/chunk.
enum MeetingAudioSampleClock {
    static func nanoseconds(frames: UInt64, sampleRate: Double) -> UInt64? {
        guard sampleRate.isFinite, (8000...192000).contains(sampleRate), sampleRate.rounded() == sampleRate else { return nil }
        let rate = UInt64(sampleRate)
        let seconds = frames / rate
        guard seconds <= UInt64.max / 1_000_000_000 else { return nil }
        let fraction = ((frames % rate) * 1_000_000_000 + rate - 1) / rate
        let (result, overflow) = (seconds * 1_000_000_000).addingReportingOverflow(fraction)
        return overflow ? nil : result
    }
}

struct MeetingAudioPacket: Equatable {
    let source: MeetingAudioSource
    let epoch: UInt64
    let sequence: UInt64
    let startNanoseconds: UInt64
    let sampleRate: Double
    let samples: [Float]
    let timelineOriginNanoseconds: UInt64
    let sampleOffset: UInt64

    init(source: MeetingAudioSource, epoch: UInt64, sequence: UInt64, startNanoseconds: UInt64,
         sampleRate: Double, samples: [Float], timelineOriginNanoseconds: UInt64? = nil, sampleOffset: UInt64 = 0) {
        self.source = source
        self.epoch = epoch
        self.sequence = sequence
        self.startNanoseconds = startNanoseconds
        self.sampleRate = sampleRate
        self.samples = samples
        self.timelineOriginNanoseconds = timelineOriginNanoseconds ?? startNanoseconds
        self.sampleOffset = sampleOffset
    }

    var endNanoseconds: UInt64 {
        let (frames, overflow) = sampleOffset.addingReportingOverflow(UInt64(samples.count))
        guard !overflow, let duration = MeetingAudioSampleClock.nanoseconds(frames: frames, sampleRate: sampleRate) else { return UInt64.max }
        let (end, endOverflow) = timelineOriginNanoseconds.addingReportingOverflow(duration)
        return endOverflow ? UInt64.max : end
    }
}

enum MeetingAudioGapReason: Equatable {
    case callbackContention
    case startupTimestamp
    case sourceVerification
    case paused
    case expired
    case bufferFull
    case retentionDeclined
    case cutoffChanged
    case captureFailure(MeetingAudioFailure)
}

struct MeetingAudioGap: Equatable {
    let source: MeetingAudioSource
    let epoch: UInt64
    let startNanoseconds: UInt64
    let endNanoseconds: UInt64
    let reason: MeetingAudioGapReason
}

/// Allocated on the control plane. Every subsequent operation is lock-free C11 atomic access.
/// The C shim asserts lock freedom at build time, including on the macOS 14 deployment floor.
final class MeetingAudioAtomicState {
    private let word: OpaquePointer

    init(_ value: UInt32 = 0) {
        guard let word = MeetingAudioAtomicCreate(value) else { preconditionFailure("Audio atomic allocation failed") }
        self.word = word
    }

    var value: UInt32 { MeetingAudioAtomicLoad(word) }
    @discardableResult func insert(_ bits: UInt32) -> UInt32 { MeetingAudioAtomicOr(word, bits) }
    @discardableResult func exchange(_ value: UInt32) -> UInt32 { MeetingAudioAtomicExchange(word, value) }
    func replace(_ expected: UInt32, with desired: UInt32) -> Bool {
        MeetingAudioAtomicCompareExchange(word, expected, desired)
    }
    deinit { MeetingAudioAtomicDestroy(word) }
}

/// Shared by a runtime's rings. Updating a lease never opens a closed ring or resumes capture.
final class MeetingAudioLease {
    private let value: OpaquePointer
    init(deadline: UInt64 = UInt64.max) {
        guard let value = MeetingAudioDeadlineCreate(deadline) else { preconditionFailure("Audio lease allocation failed") }
        self.value = value
    }
    var deadline: UInt64 { MeetingAudioDeadlineLoad(value) }
    func update(deadline: UInt64) { MeetingAudioDeadlineStore(value, deadline) }
    deinit { MeetingAudioDeadlineDestroy(value) }
}
