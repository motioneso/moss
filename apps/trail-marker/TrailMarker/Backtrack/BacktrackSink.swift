import Foundation

/// Whether a sink can take segments now. Recording runs only while it is `ready`; a Release build
/// shows Backtrack only while it isn't `unavailable`.
enum BacktrackSinkAvailability: Equatable {
    /// Nowhere to put text: this Moss doesn't store Backtrack, or hasn't said yet.
    case unavailable
    /// The person paused Backtrack from Moss.
    case paused
    case ready
}

/// The one way Backtrack data leaves `BacktrackRuntime` (plan §4.5, Ben 2026-09-23): only a
/// segment the machine built, which means sanitised and policy-allowed, and never while
/// recording is stopped. Release builds have one sink, the uploader to Moss
/// (`BacktrackUploader`); Debug builds also keep the in-memory ring (`BacktrackDebugRing`).
@MainActor
protocol BacktrackSink: AnyObject {
    /// The consent the person must have given before this sink receives anything. A sink that
    /// sends to Moss requires a newer consent than one that keeps text in memory, so an opt-in
    /// for the Debug preview never authorises sending.
    var requiredConsentVersion: Int { get }
    var availability: BacktrackSinkAvailability { get }
    func accept(_ segment: BacktrackSegment)
    /// Log out, revoke, consent withdrawn or Backtrack turned off: forget everything held.
    func discardAll()
}

extension BacktrackSink {
    var availability: BacktrackSinkAvailability { .ready }
}
