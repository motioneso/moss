import AudioToolbox
import CoreAudio
import Foundation
import os

/// Diagnostic-only tags. They never replace MeetingAudioFailure or participate in admission.
struct MeetingAudioFailureDiagnostic: Equatable {
    enum Code: UInt32 {
        case outputStart = 1, outputTimestamp, outputBufferLayout, outputFrameCapacity
        case outputDeviceAlive, outputDeviceList, outputDefaultRoute, outputSystemRoute, outputProcessRoute
        case outputFormatVerification, outputProcessScope
        case microphoneFormatVerification, microphoneCapacityVerification, microphoneFormatRead
        case microphoneDeviceGone, microphoneContendedTimestamp, microphoneFrameCapacity
        case microphoneTimestamp, microphoneRender, microphoneBufferLayout
        case bufferCapacity, bufferSample, bufferDropFrames, bufferDropMailbox
        case bufferFormat, bufferTimestamp, bufferSampleContinuity, bufferClockRange, bufferLease, bufferGapCapacity
        case captureStart
        case voiceReferenceRoute, voiceReferenceFormatVerification, voiceReferenceFormatRead
        case voiceComponent, voiceInputEnable, voiceOutputEnable, voiceBypass, voiceAGC
        case voiceDucking, voiceRenderCallback, voiceReferenceSelection, voiceDeviceSelection
        case voiceEndpointReadback, voiceChannelMap, voiceClientFormat, voiceInitialize, voiceStart
        case voiceDefaultOutputChanged
        case voiceBufferOwnership, voiceInputCallback, voiceMaximumFrames

        var label: String {
            switch self {
            case .outputStart: return "outputStart"
            case .outputTimestamp: return "outputTimestamp"
            case .outputBufferLayout: return "outputBufferLayout"
            case .outputFrameCapacity: return "outputFrameCapacity"
            case .outputDeviceAlive: return "outputDeviceAlive"
            case .outputDeviceList: return "outputDeviceList"
            case .outputDefaultRoute: return "outputDefaultRoute"
            case .outputSystemRoute: return "outputSystemRoute"
            case .outputProcessRoute: return "outputProcessRoute"
            case .outputFormatVerification: return "outputFormatVerification"
            case .outputProcessScope: return "outputProcessScope"
            case .microphoneFormatVerification: return "microphoneFormatVerification"
            case .microphoneCapacityVerification: return "microphoneCapacityVerification"
            case .microphoneFormatRead: return "microphoneFormatRead"
            case .microphoneDeviceGone: return "microphoneDeviceGone"
            case .microphoneContendedTimestamp: return "microphoneContendedTimestamp"
            case .microphoneFrameCapacity: return "microphoneFrameCapacity"
            case .microphoneTimestamp: return "microphoneTimestamp"
            case .microphoneRender: return "microphoneRender"
            case .microphoneBufferLayout: return "microphoneBufferLayout"
            case .bufferCapacity: return "bufferCapacity"
            case .bufferSample: return "bufferSample"
            case .bufferDropFrames: return "bufferDropFrames"
            case .bufferDropMailbox: return "bufferDropMailbox"
            case .bufferFormat: return "bufferFormat"
            case .bufferTimestamp: return "bufferTimestamp"
            case .bufferSampleContinuity: return "bufferSampleContinuity"
            case .bufferClockRange: return "bufferClockRange"
            case .bufferLease: return "bufferLease"
            case .bufferGapCapacity: return "bufferGapCapacity"
            case .captureStart: return "captureStart"
            case .voiceReferenceRoute: return "voiceReferenceRoute"
            case .voiceReferenceFormatVerification: return "voiceReferenceFormatVerification"
            case .voiceReferenceFormatRead: return "voiceReferenceFormatRead"
            case .voiceComponent: return "voiceComponent"
            case .voiceInputEnable: return "voiceInputEnable"
            case .voiceOutputEnable: return "voiceOutputEnable"
            case .voiceBypass: return "voiceBypass"
            case .voiceAGC: return "voiceAGC"
            case .voiceDucking: return "voiceDucking"
            case .voiceRenderCallback: return "voiceRenderCallback"
            case .voiceReferenceSelection: return "voiceReferenceSelection"
            case .voiceDeviceSelection: return "voiceDeviceSelection"
            case .voiceEndpointReadback: return "voiceEndpointReadback"
            case .voiceChannelMap: return "voiceChannelMap"
            case .voiceClientFormat: return "voiceClientFormat"
            case .voiceInitialize: return "voiceInitialize"
            case .voiceStart: return "voiceStart"
            case .voiceDefaultOutputChanged: return "voiceDefaultOutputChanged"
            case .voiceBufferOwnership: return "voiceBufferOwnership"
            case .voiceInputCallback: return "voiceInputCallback"
            case .voiceMaximumFrames: return "voiceMaximumFrames"
            }
        }
    }
    let code: Code
    let status: Int32?
    init(_ code: Code, status: Int32? = nil) { self.code = code; self.status = status }

    var packed: UInt64 {
        let tag = code.rawValue | (status == nil ? 0 : 0x8000_0000)
        return UInt64(tag) << 32 | UInt64(UInt32(bitPattern: status ?? 0))
    }
    init?(packed: UInt64) {
        let tag = UInt32(truncatingIfNeeded: packed >> 32)
        guard let code = Code(rawValue: tag & 0x7fff_ffff) else { return nil }
        self.code = code
        status = tag & 0x8000_0000 == 0 ? nil : Int32(bitPattern: UInt32(truncatingIfNeeded: packed))
    }

    static func status(_ error: Error) -> Int32? {
        if let unavailable = error as? MeetingVoiceProcessingUnavailable { return unavailable.status }
        if let failure = error as? MeetingAudioFailure {
            if case .deviceFailure(_, let status) = failure { return status }
            return nil
        }
        return Int32(exactly: (error as NSError).code)
    }

    /// Called only on the runtime control queue. Never render operation strings, NSError text, domains or userInfo.
    static func message(source: MeetingAudioSource, failure: Error, diagnostic: Self?) -> String {
        let reason: String
        switch failure as? MeetingAudioFailure {
        case .invalidSelection: reason = "invalidSelection"
        case .invalidFormat: reason = "invalidFormat"
        case .invalidTimestamp: reason = "invalidTimestamp"
        case .sourceReconfigured: reason = "sourceReconfigured"
        case .bufferFull: reason = "bufferFull"
        case .leaseExpired: reason = "leaseExpired"
        case .deviceFailure: reason = "deviceFailure"
        case .invalidTransition: reason = "invalidTransition"
        case .cleanupFailed: reason = "cleanupFailed"
        case nil: reason = "unknownFailure"
        }
        let callback = diagnostic.map { $0.code.label } ?? "unspecifiedCaptureFailure"
        let status = diagnostic?.status ?? Self.status(failure)
        return "capture-failure source=\(source.rawValue) callback=\(callback) reason=\(reason) status=\(status.map { String($0) } ?? "unavailable")"
    }

    private static let logger = Logger(subsystem: "com.moss.trailmarker", category: "meeting-capture")
    static func logLevel(for message: String) -> OSLogType {
        switch message {
        case "microphone-echo-cancellation=on": return .info
        case "microphone-echo-cancellation=off reason=microphoneOnly": return .default
        default: return .error
        }
    }
    static func log(_ message: String) {
        logger.log(level: logLevel(for: message), "\(message, privacy: .public)")
    }
    static func logStartup(_ diagnostic: MeetingMicrophoneStartupDiagnostic) {
        // Keep the one numeric troubleshooting snapshot in normal persisted logs.
        logger.notice("\(diagnostic.message, privacy: .public)")
    }
}

/// Preallocated lock-free packed publication; callbacks never log, format, allocate or dispatch.
/// Latest accepted callback detail is metadata only; existing semantic failure priority is unchanged.
final class MeetingAudioFailureDiagnosticSlot {
    private let value: OpaquePointer
    init() {
        guard let value = MeetingAudioDeadlineCreate(0) else { preconditionFailure("Audio diagnostic allocation failed") }
        self.value = value
    }
    func store(_ diagnostic: MeetingAudioFailureDiagnostic) { MeetingAudioDeadlineStore(value, diagnostic.packed) }
    var latest: MeetingAudioFailureDiagnostic? { MeetingAudioFailureDiagnostic(packed: MeetingAudioDeadlineLoad(value)) }
    deinit { MeetingAudioDeadlineDestroy(value) }
}

/// Optional numeric observations only. Neither device identities nor property-read errors
/// enter diagnostics, and a failed observation must never change capture admission.
struct MeetingMicrophoneDeviceMeasurements: Equatable {
    var bufferFrameSize: UInt32?
    var nominalSampleRate: Double?
}

struct MeetingMicrophoneStartupMeasurements: Equatable {
    var maximumFramesPerSlice: UInt32?
    var inputSampleRate: Double?
    var clientSampleRate: Double?
    var referenceSampleRate: Double?
    var microphone = MeetingMicrophoneDeviceMeasurements()
    var reference = MeetingMicrophoneDeviceMeasurements()
}

struct MeetingMicrophoneStartupDiagnostic: Equatable {
    let voiceProcessing: Bool
    let before: MeetingMicrophoneStartupMeasurements
    let after: MeetingMicrophoneStartupMeasurements
    let allocationFrames: UInt32?
    let firstCallbackFrameCount: UInt32?

    /// Control-plane formatting only. -1 means unavailable; an observed zero stays zero.
    var message: String {
        func frames(_ value: UInt32?) -> String { value.map { String($0) } ?? "-1" }
        func rate(_ value: Double?) -> String {
            guard let value, value.isFinite, value >= 0 else { return "-1" }
            return String(value)
        }
        return "microphone-startup-sizing voiceProcessing=\(voiceProcessing ? 1 : 0)" +
            " maxFramesBeforeInitialize=\(frames(before.maximumFramesPerSlice))" +
            " maxFramesAfterInitialize=\(frames(after.maximumFramesPerSlice))" +
            " allocationFrames=\(frames(allocationFrames))" +
            " firstCallbackFrameCount=\(frames(firstCallbackFrameCount))" +
            " microphoneBufferFramesBeforeInitialize=\(frames(before.microphone.bufferFrameSize))" +
            " microphoneBufferFramesAfterInitialize=\(frames(after.microphone.bufferFrameSize))" +
            " referenceBufferFramesBeforeInitialize=\(frames(before.reference.bufferFrameSize))" +
            " referenceBufferFramesAfterInitialize=\(frames(after.reference.bufferFrameSize))" +
            " microphoneNominalRateBeforeInitialize=\(rate(before.microphone.nominalSampleRate))" +
            " microphoneNominalRateAfterInitialize=\(rate(after.microphone.nominalSampleRate))" +
            " referenceNominalRateBeforeInitialize=\(rate(before.reference.nominalSampleRate))" +
            " referenceNominalRateAfterInitialize=\(rate(after.reference.nominalSampleRate))" +
            " inputRateBeforeInitialize=\(rate(before.inputSampleRate))" +
            " inputRateAfterInitialize=\(rate(after.inputSampleRate))" +
            " clientRateBeforeInitialize=\(rate(before.clientSampleRate))" +
            " clientRateAfterInitialize=\(rate(after.clientSampleRate))" +
            " referenceRateBeforeInitialize=\(rate(before.referenceSampleRate))" +
            " referenceRateAfterInitialize=\(rate(after.referenceSampleRate))"
    }
}

/// Allocated before callback registration. The existing sequentially consistent atomics
/// provide release/acquire publication: claim once, store the payload, then publish ready.
/// No callback formats a message, invokes a sink, allocates, waits, or takes this lock.
final class MeetingMicrophoneStartupDiagnostics {
    private let callbackState = MeetingAudioAtomicState()
    private let callbackFrames = MeetingAudioAtomicState()
    private let controlLock = NSLock()
    private let voiceProcessing: Bool
    private let sink: (MeetingMicrophoneStartupDiagnostic) -> Void
    private var before = MeetingMicrophoneStartupMeasurements()
    private var after = MeetingMicrophoneStartupMeasurements()
    private var allocationFrames: UInt32?
    private var startupComplete = false
    private var published = false

    init(voiceProcessing: Bool, sink: @escaping (MeetingMicrophoneStartupDiagnostic) -> Void) {
        self.voiceProcessing = voiceProcessing
        self.sink = sink
    }

    func recordFirstCallback(frameCount: UInt32) {
        guard callbackState.replace(0, with: 1) else { return }
        callbackFrames.exchange(frameCount)
        callbackState.exchange(2)
    }

    func recordBeforeInitialize(_ measurements: MeetingMicrophoneStartupMeasurements, allocationFrames: UInt32? = nil) {
        controlLock.lock()
        before = measurements
        self.allocationFrames = allocationFrames
        controlLock.unlock()
    }

    func recordAfterInitialize(_ measurements: MeetingMicrophoneStartupMeasurements) {
        controlLock.lock()
        after = measurements
        controlLock.unlock()
    }

    func completeStartup() {
        controlLock.lock()
        startupComplete = true
        controlLock.unlock()
        poll()
    }

    /// Poll on the control plane, including when there are no format notices. Only
    /// successful disposal proves that an unavailable first callback can be finalized.
    func poll(callbacksFinished: Bool = false) {
        controlLock.lock()
        let state = callbackState.value
        guard startupComplete, !published, state == 2 || (callbacksFinished && state == 0) else {
            controlLock.unlock()
            return
        }
        published = true
        let diagnostic = MeetingMicrophoneStartupDiagnostic(voiceProcessing: voiceProcessing,
            before: before, after: after, allocationFrames: allocationFrames,
            firstCallbackFrameCount: state == 2 ? callbackFrames.value : nil)
        controlLock.unlock()
        sink(diagnostic)
    }
}

/// VPIO setup incompatibility, including explicitly allowed format/route surprises before admission.
/// Permission, device-loss, cleanup, and post-admission failures never use this marker.
struct MeetingVoiceProcessingUnavailable: Error {
    let diagnostic: MeetingAudioFailureDiagnostic.Code
    let status: Int32?

    static func setupFailure(status: OSStatus, operation: String, diagnostic: MeetingAudioFailureDiagnostic.Code) -> Error {
        if status == kAudioUnitErr_Unauthorized || status == kAudioDevicePermissionsError ||
            status == kAudioHardwareBadDeviceError || status == kAudioHardwareBadObjectError {
            return MeetingAudioFailure.deviceFailure(operation: operation, status: status)
        }
        return MeetingVoiceProcessingUnavailable(diagnostic: diagnostic, status: status)
    }
}
