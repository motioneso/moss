import AudioToolbox
import Foundation

/// The earliest possible local origin is conservative for Stop: uncertainty can omit a short
/// tail, but must not authorize samples captured after the server's cutoff. The request deadline
/// bounds initial mapping uncertainty; normal six-second responses do not falsely stop capture.
struct MeetingCaptureClock {
    let originNanoseconds: UInt64
    static func now() -> UInt64 { AudioConvertHostTimeToNanos(AudioGetCurrentHostTime()) }
    init(requestSent: UInt64, responseReceived: UInt64, elapsedMilliseconds: UInt64) throws {
        guard responseReceived >= requestSent, responseReceived - requestSent <= 12_000_000_000,
              elapsedMilliseconds <= requestSent / 1_000_000 else { throw MeetingHostError.network }
        // Server milliseconds are quantized. Reserve the entire quantization unit so
        // a later Stop with a different fractional phase cannot map after actual Stop.
        let estimate = requestSent - elapsedMilliseconds * 1_000_000
        originNanoseconds = estimate >= 1_000_000 ? estimate - 1_000_000 : 0
    }
    func nativeTime(_ milliseconds: UInt64) throws -> UInt64 {
        guard milliseconds <= (UInt64.max - originNanoseconds) / 1_000_000 else { throw MeetingHostError.invalidResponse }
        return originNanoseconds + milliseconds * 1_000_000
    }
}

enum MeetingSendAdmission {
    static func permits(phase: MeetingCaptureHost.Phase, desired: String,
                        submitted: MeetingCaptureObserved, current: MeetingCaptureObserved) -> Bool {
        guard submitted == current else { return false }
        return phase == .recording && desired == "recording" && submitted.phase == "recording"
            || phase == .stopping && desired == "stopped" && submitted.phase == "stopped"
    }
}

/// Cover both cumulative sample-clock boundaries with the same integer millisecond rule.
/// This avoids truncating the cumulative end, without overlaps or accumulating rounding drift.
/// An individual wire duration can still differ from the PCM duration by less than 1 ms;
/// rounding each clip's duration up independently would invent overlaps between adjacent clips.
struct MeetingWireAudioBoundary: Equatable {
    let startMs: UInt64
    let endMs: UInt64
    static func milliseconds(coveringNanoseconds nanoseconds: UInt64) -> UInt64 {
        nanoseconds / 1_000_000 + (nanoseconds % 1_000_000 == 0 ? 0 : 1)
    }
    init(packet: MeetingAudioPacket, originNanoseconds: UInt64) throws {
        guard packet.startNanoseconds >= originNanoseconds,
              packet.endNanoseconds >= packet.startNanoseconds else { throw MeetingHostError.invalidResponse }
        startMs = Self.milliseconds(coveringNanoseconds: packet.startNanoseconds - originNanoseconds)
        endMs = Self.milliseconds(coveringNanoseconds: packet.endNanoseconds - originNanoseconds)
        guard endMs > startMs, endMs - startMs <= 10000 else { throw MeetingHostError.invalidResponse }
    }
}

/// Acknowledged capture time excludes preparation, permission dialogs and paused intervals.
struct MeetingRecordingDuration {
    private var accumulated: UInt64 = 0
    private var activeSince: UInt64?
    mutating func start(at now: UInt64) { if activeSince == nil { activeSince = now } }
    mutating func pause(at now: UInt64) {
        if let start = activeSince, now >= start { accumulated += now - start }
        activeSince = nil
    }
    mutating func observeCaptureState(_ state: MeetingCaptureMachine.State, at now: UInt64) {
        if state != .recording { pause(at: now) }
    }
    func milliseconds(at now: UInt64) -> UInt64 {
        let active = activeSince.map { now >= $0 ? now - $0 : 0 } ?? 0
        return (accumulated + active) / 1_000_000
    }
}
