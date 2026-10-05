import Foundation

/// The earliest possible local origin is conservative for Stop: uncertainty can omit a short
/// tail, but must not authorize samples captured after the server's cutoff. Long RTT is rejected.
struct MeetingCaptureClock {
    let originNanoseconds: UInt64
    init(requestSent: UInt64, responseReceived: UInt64, elapsedMilliseconds: UInt64) throws {
        guard responseReceived >= requestSent, responseReceived - requestSent <= 1_000_000_000,
              elapsedMilliseconds <= requestSent / 1_000_000 else { throw MeetingHostError.network }
        originNanoseconds = requestSent - elapsedMilliseconds * 1_000_000
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
