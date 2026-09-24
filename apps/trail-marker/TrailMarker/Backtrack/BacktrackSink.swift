#if DEBUG
import Foundation

/// The one way Backtrack data leaves `BacktrackRuntime` (plan §4.5, Ben 2026-09-23): only a
/// segment the machine built, which means sanitised and policy-allowed, and never while
/// recording is stopped. In Phase 1 the sink is the in-memory Debug ring below; in Phase 2b it
/// becomes the uploader to Moss. The structural check and the boundary tests stay the same;
/// only the implementation behind this protocol changes.
@MainActor
protocol BacktrackSink: AnyObject {
    /// The consent the person must have given before this sink receives anything. A sink that
    /// sends to Moss requires a newer consent than one that keeps text in memory, so an opt-in
    /// for the Debug preview never authorises sending.
    var requiredConsentVersion: Int { get }
    func accept(_ segment: BacktrackSegment)
    /// Log out, revoke, consent withdrawn or Backtrack turned off: forget everything held.
    func discardAll()
}

/// Phase 1's sink: the last 200 segments, in memory only, never written to disk or sent
/// anywhere, cleared when Trail Marker quits. Shown in the Debug focus log.
@MainActor
final class BacktrackDebugRing: BacktrackSink, ObservableObject {
    static let capacity = 200
    /// Consent version 1: "kept in memory on this Mac" (plan §4.4).
    let requiredConsentVersion = 1

    @Published private(set) var segments: [BacktrackSegment] = []

    func accept(_ segment: BacktrackSegment) {
        segments.append(segment)
        if segments.count > Self.capacity { segments.removeFirst(segments.count - Self.capacity) }
        let host = segment.address.flatMap { URLComponents(string: $0)?.host } ?? "no address"
        focusDebug("Backtrack: \(segment.appName) · \(segment.lines.count) new lines · \(host)")
    }

    func discardAll() {
        segments = []
    }
}
#endif
