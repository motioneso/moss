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
    static func log(_ message: String) { logger.error("\(message, privacy: .public)") }
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
