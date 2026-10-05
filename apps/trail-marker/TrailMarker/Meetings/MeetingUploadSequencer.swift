import Foundation

/// Callback sequence numbers are ring identities, not wire chunk numbers. Keep each request's
/// UUID and contiguous per-source sequence stable until its receipt is accepted.
struct MeetingUploadSequencer {
    struct Stream: Hashable { let epoch: UInt64; let source: String }
    struct Packet: Hashable { let stream: Stream; let callbackSequence: UInt64 }
    struct Identity: Equatable { let requestKey: String; let sequence: UInt64 }
    private var next: [Stream: UInt64] = [:]
    private var pending: [Packet: Identity] = [:]

    mutating func identity(epoch: UInt64, source: String, callbackSequence: UInt64) -> Identity {
        let packet = Packet(stream: Stream(epoch: epoch, source: source), callbackSequence: callbackSequence)
        if let existing = pending[packet] { return existing }
        let identity = Identity(requestKey: UUID().uuidString.lowercased(), sequence: next[packet.stream] ?? 0)
        pending[packet] = identity
        return identity
    }

    mutating func acknowledge(epoch: UInt64, source: String, callbackSequence: UInt64) {
        let packet = Packet(stream: Stream(epoch: epoch, source: source), callbackSequence: callbackSequence)
        guard let identity = pending.removeValue(forKey: packet) else { return }
        next[packet.stream] = identity.sequence + 1
    }
}
