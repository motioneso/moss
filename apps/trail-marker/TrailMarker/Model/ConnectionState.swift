import Foundation

/// Connection states plus a durable server-confirmed unlink operation. `disconnected` and
/// `reconnecting` are kept apart
/// on purpose — they represent different user intent, not the same "not talking to Moss" fact.
enum ConnectionState: Equatable {
    case unlinking
    case notLinked
    case connected(lastContact: Date)
    case disconnected
    case reconnecting(attempt: Int, lastContact: Date?)
    case signInRequired(reason: SignInReason)
}

enum SignInReason: Equatable {
    case expired
    case revoked
    case accountBlocked(String)
}
