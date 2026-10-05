#if DEBUG
import Foundation

/// Phase 1's sink: the last 200 segments, in memory only, never written to disk or sent
/// anywhere, cleared when Trail Marker quits. Shown in Settings → Backtrack → Show text….
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

/// Debug builds: every segment goes to the ring, so Show text… works whether or not this Moss
/// stores Backtrack, and to the uploader while it is ready. The uploader's consent applies to
/// both, so the Debug preview never records under a weaker consent than Release.
@MainActor
final class BacktrackDebugTee: BacktrackSink {
    let ring: BacktrackDebugRing
    let uploader: BacktrackUploader

    init(ring: BacktrackDebugRing, uploader: BacktrackUploader) {
        self.ring = ring
        self.uploader = uploader
    }

    var requiredConsentVersion: Int { max(ring.requiredConsentVersion, uploader.requiredConsentVersion) }
    var availability: BacktrackSinkAvailability { .ready }

    func accept(_ segment: BacktrackSegment) {
        ring.accept(segment)
        if uploader.availability == .ready { uploader.accept(segment) }
    }

    func discardAll() {
        ring.discardAll()
        uploader.discardAll()
    }
}
#endif
