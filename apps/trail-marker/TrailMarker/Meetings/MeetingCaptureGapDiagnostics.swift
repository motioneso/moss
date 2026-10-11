import Foundation

/// Public log fields are fixed labels and numbers, never source IDs or captured content.
enum MeetingCaptureGapDiagnostics {
    static func line(_ gap: MeetingCaptureGap, source: MeetingAudioSource?, cause: MeetingAudioGapReason? = nil) -> String {
        let reason: String
        switch gap.reason {
        case "paused": reason = "paused"
        case "interrupted": reason = "interrupted"
        case "expired": reason = "expired"
        case "buffer-full": reason = "buffer-full"
        case "source-unavailable": reason = "source-unavailable"
        case "discarded": reason = "discarded"
        case "processing-failed": reason = "processing-failed"
        default: reason = "unknown"
        }
        let origin: String
        switch cause {
        case .callbackContention?: origin = "callback-contention"
        case .startupTimestamp?: origin = "microphone-startup-timestamp"
        case .sourceVerification?: origin = "startup-source-verification"
        case .paused?: origin = "pause"
        case .expired?: origin = "expiry"
        case .bufferFull?: origin = "capacity"
        case .captureFailure?: origin = "capture-failure"
        case .retentionDeclined?: origin = "retention"
        case .cutoffChanged?: origin = "cutoff"
        case nil: origin = "control-or-server"
        }
        return "capture-gap source=\(source?.rawValue ?? "unknown") epoch=\(gap.epoch) startMs=\(gap.startMs) endMs=\(gap.endMs) reason=\(reason) cause=\(origin)"
    }
}
