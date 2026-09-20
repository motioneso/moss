import Foundation

enum ConnectionEvent: Equatable {
    case launched(hasCredential: Bool, enabled: Bool)
    case userConnect
    case userDisconnect
    case userRetry
    case userLogout
    case userQuit
    case heartbeatSucceeded(at: Date, generation: Int)
    case heartbeatFailed(CompanionError, generation: Int)
    case timerFired(generation: Int)
    case wake
    case networkChanged
    case linkCompleted(LinkedIdentity, credential: String, generation: Int)
    case linkCancelled(generation: Int)
}

enum ConnectionEffect: Equatable {
    case persistEnabled(Bool)
    case sendHeartbeat(generation: Int)
    case scheduleHeartbeat(after: TimeInterval, generation: Int)
    case cancelAll
    case storeCredential(String, LinkedIdentity)
    case clearCredential
    case revokeRemotely(generation: Int)
    case showLogoutUnconfirmed
}

/// Pure `(state, event) -> (state, [effect])` reducer. A small runtime (`ConnectionRuntime`)
/// executes the effects; the machine itself never touches the network, a timer, or the Keychain,
/// which is what makes "Disconnect really means no requests" testable without either.
///
/// `generation` is bumped on every user action. An async effect (a heartbeat send, a scheduled
/// timer) is stamped with the generation active when it was dispatched; its eventual event is
/// honored only if that generation still matches, so a reply to a superseded attempt is inert.
struct ConnectionMachine {
    private(set) var state: ConnectionState
    private(set) var generation: Int

    static let steadyHeartbeatInterval: TimeInterval = 60
    static let maxBackoff: TimeInterval = 300
    static let baseBackoff: TimeInterval = 5

    init(state: ConnectionState = .notLinked, generation: Int = 0) {
        self.state = state
        self.generation = generation
    }

    mutating func handle(_ event: ConnectionEvent, now: Date) -> [ConnectionEffect] {
        switch event {
        case .launched(let hasCredential, let enabled):
            return handleLaunched(hasCredential: hasCredential, enabled: enabled)

        case .userConnect:
            return handleUserConnect()

        case .userDisconnect:
            return handleUserDisconnect()

        case .userRetry:
            return handleUserRetry()

        case .userLogout:
            return handleUserLogout()

        case .userQuit:
            return [.cancelAll]

        case .heartbeatSucceeded(let at, let eventGeneration):
            return handleHeartbeatSucceeded(at: at, generation: eventGeneration)

        case .heartbeatFailed(let error, let eventGeneration):
            return handleHeartbeatFailed(error, generation: eventGeneration)

        case .timerFired(let eventGeneration):
            return handleTimerFired(generation: eventGeneration)

        case .wake, .networkChanged:
            return handleConnectivityHint()

        case .linkCompleted(let identity, let credential, let eventGeneration):
            return handleLinkCompleted(identity, credential: credential, generation: eventGeneration, now: now)

        case .linkCancelled(let eventGeneration):
            return handleLinkCancelled(generation: eventGeneration)
        }
    }

    // MARK: - Launch

    private mutating func handleLaunched(hasCredential: Bool, enabled: Bool) -> [ConnectionEffect] {
        guard hasCredential else {
            state = .notLinked
            return []
        }
        guard enabled else {
            state = .disconnected
            return []
        }
        state = .reconnecting(attempt: 0, lastContact: nil)
        return [.sendHeartbeat(generation: generation)]
    }

    // MARK: - User actions

    private mutating func handleUserConnect() -> [ConnectionEffect] {
        guard case .disconnected = state else { return [] }
        generation += 1
        state = .reconnecting(attempt: 0, lastContact: lastContact(of: state))
        return [.persistEnabled(true), .sendHeartbeat(generation: generation)]
    }

    private mutating func handleUserDisconnect() -> [ConnectionEffect] {
        switch state {
        case .connected, .reconnecting, .signInRequired:
            generation += 1
            state = .disconnected
            return [.persistEnabled(false), .cancelAll]
        case .notLinked, .disconnected:
            return []
        }
    }

    private mutating func handleUserRetry() -> [ConnectionEffect] {
        switch state {
        case .reconnecting(_, let lastContact):
            generation += 1
            state = .reconnecting(attempt: 0, lastContact: lastContact)
            return [.cancelAll, .sendHeartbeat(generation: generation)]
        case .signInRequired:
            generation += 1
            state = .reconnecting(attempt: 0, lastContact: nil)
            return [.cancelAll, .sendHeartbeat(generation: generation)]
        case .connected, .disconnected, .notLinked:
            return []
        }
    }

    private mutating func handleUserLogout() -> [ConnectionEffect] {
        switch state {
        case .connected, .reconnecting, .signInRequired:
            let attemptGeneration = generation
            generation += 1
            state = .notLinked
            return [.cancelAll, .revokeRemotely(generation: attemptGeneration), .clearCredential]
        case .notLinked, .disconnected:
            return []
        }
    }

    // MARK: - Network callbacks

    private mutating func handleHeartbeatSucceeded(at: Date, generation eventGeneration: Int) -> [ConnectionEffect] {
        guard eventGeneration == generation else { return [] }
        switch state {
        case .connected, .reconnecting:
            state = .connected(lastContact: at)
            return [.scheduleHeartbeat(after: Self.steadyHeartbeatInterval, generation: generation)]
        case .notLinked, .disconnected, .signInRequired:
            return []
        }
    }

    private mutating func handleHeartbeatFailed(
        _ error: CompanionError,
        generation eventGeneration: Int
    ) -> [ConnectionEffect] {
        // The one exception to generation-matching: a straggling reply to a logout's best-effort
        // revocation always surfaces, however stale, because nothing else produces a failure
        // while Not linked.
        if case .notLinked = state {
            return [.showLogoutUnconfirmed]
        }

        guard eventGeneration == generation else { return [] }

        let attempt: Int
        let lastContact: Date?
        switch state {
        case .reconnecting(let current, let contact):
            attempt = current
            lastContact = contact
        case .connected(let contact):
            // A failed check while Connected is the moment it stops being Connected.
            attempt = 0
            lastContact = contact
        case .disconnected, .signInRequired, .notLinked:
            return []
        }

        if let reason = signInReason(for: error) {
            state = .signInRequired(reason: reason)
            return [.cancelAll]
        }
        let backoff = min(Self.maxBackoff, Self.baseBackoff * pow(2, Double(attempt)) * Double.random(in: 0.8...1.2))
        state = .reconnecting(attempt: attempt + 1, lastContact: lastContact)
        return [.scheduleHeartbeat(after: backoff, generation: generation)]
    }

    private func signInReason(for error: CompanionError) -> SignInReason? {
        switch error {
        case .credentialInvalid:
            return .revoked
        case .accountBlocked(let code):
            return .accountBlocked(code)
        default:
            return nil
        }
    }

    private mutating func handleTimerFired(generation eventGeneration: Int) -> [ConnectionEffect] {
        guard eventGeneration == generation else { return [] }
        switch state {
        case .connected, .reconnecting:
            return [.sendHeartbeat(generation: generation)]
        case .notLinked, .disconnected, .signInRequired:
            return []
        }
    }

    private mutating func handleConnectivityHint() -> [ConnectionEffect] {
        switch state {
        case .reconnecting(_, let lastContact):
            state = .reconnecting(attempt: 0, lastContact: lastContact)
            return [.cancelAll, .sendHeartbeat(generation: generation)]
        case .connected, .disconnected, .notLinked, .signInRequired:
            return []
        }
    }

    // MARK: - Linking

    private mutating func handleLinkCompleted(
        _ identity: LinkedIdentity,
        credential: String,
        generation eventGeneration: Int,
        now: Date
    ) -> [ConnectionEffect] {
        guard eventGeneration == generation else { return [] }
        generation += 1
        state = .connected(lastContact: now)
        return [
            .storeCredential(credential, identity),
            .persistEnabled(true),
            .scheduleHeartbeat(after: Self.steadyHeartbeatInterval, generation: generation)
        ]
    }

    private mutating func handleLinkCancelled(generation eventGeneration: Int) -> [ConnectionEffect] {
        guard eventGeneration == generation else { return [] }
        generation += 1
        return [.cancelAll]
    }

    private func lastContact(of state: ConnectionState) -> Date? {
        switch state {
        case .connected(let lastContact):
            return lastContact
        case .reconnecting(_, let lastContact):
            return lastContact
        case .notLinked, .disconnected, .signInRequired:
            return nil
        }
    }
}
