import AppKit
import Foundation
import Network

/// Executes the effects a `ConnectionMachine` returns: real heartbeat requests, real timers,
/// the Keychain, and the two system signals (wake, network path change) that feed back in as
/// `.wake` / `.networkChanged` events. The machine itself stays pure and network-free; this is
/// the only place that touches `URLSession`, `Timer`, or `NWPathMonitor`.
@MainActor
final class ConnectionRuntime: ObservableObject {
    @Published private(set) var state: ConnectionState = .notLinked
    @Published private(set) var identity: LinkedIdentity?
    @Published private(set) var lastDiagnostic: String?
    @Published private(set) var recordingProofRevision = 0
    /// Bumped every time a link ends (log out, revoked). Focus resets itself on each change, so a
    /// relink in the same run, possibly as another account, starts from nothing (#2643).
    @Published private(set) var linkEndCount = 0
    /// What Moss last said about Backtrack storage, from the heartbeat or an upload's answer.
    /// Nil until a Moss that stores Backtrack has answered (and after the link ends).
    @Published private(set) var backtrackState: BacktrackState?

    /// Synchronous admission/teardown barrier installed by the app host, before identity effects.
    var beforeLifecycleChange: ((ConnectionEvent) -> Bool)?

    private var machine = ConnectionMachine()
    private let keychain: KeychainStore
    private let preferences: PreferencesStore
    private let transportFactory: (InstanceURL) -> CompanionTransport
    private let appVersion: String
    private let osVersion: String

    private var client: CompanionClient?
    private var tasks: [Int: Task<Void, Never>] = [:]
    /// Tracked so Pause, Log Out and every other cancel stops a rename still in flight.
    private var renameTask: Task<Void, Never>?
    private var pathMonitor: NWPathMonitor?
    private var wakeObserver: NSObjectProtocol?
    private var lastPathSatisfied: Bool?

    init(
        keychain: KeychainStore = KeychainStore(),
        preferences: PreferencesStore = PreferencesStore(),
        appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
        osVersion: String = ProcessInfo.processInfo.operatingSystemVersionString,
        transportFactory: @escaping (InstanceURL) -> CompanionTransport = { _ in URLSessionTransport() }
    ) {
        self.keychain = keychain
        self.preferences = preferences
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.transportFactory = transportFactory
        backtrackState = preferences.backtrackServerState
    }

    deinit {
        pathMonitor?.cancel()
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
    }

    func start() {
        let identity = preferences.linkedIdentity
        self.identity = identity
        if let identity {
            client = CompanionClient(instance: identity.instance, transport: transportFactory(identity.instance))
        }
        let hasCredential = identity.map { keychain.read(for: $0) != nil } ?? false
        apply(machine.handle(.launched(hasCredential: hasCredential, enabled: preferences.connectionEnabled), now: Date()))
        observeSystemEvents()
    }

    func send(_ event: ConnectionEvent) {
        guard beforeLifecycleChange?(event) ?? true else { return }
        apply(machine.handle(event, now: Date()))
    }

    var currentGeneration: Int { machine.generation }

    // MARK: - Effects

    private func apply(_ effects: [ConnectionEffect]) {
        state = machine.state
        for effect in effects {
            switch effect {
            case .persistEnabled(let enabled):
                preferences.connectionEnabled = enabled
            case .sendHeartbeat(let generation):
                startHeartbeatTask(generation: generation, after: 0)
            case .scheduleHeartbeat(let after, let generation):
                startHeartbeatTask(generation: generation, after: after)
            case .cancelAll:
                cancelAllTasks()
            case .storeCredential(let credential, let newIdentity):
                if let previous = identity, previous != newIdentity {
                    keychain.delete(for: previous)
                    keychain.deleteRecordingProof(for: previous)
                }
                identity = newIdentity
                preferences.linkedIdentity = newIdentity
                client = CompanionClient(
                    instance: newIdentity.instance, transport: transportFactory(newIdentity.instance)
                )
                try? keychain.store(credential: credential, for: newIdentity)
            case .clearCredential:
                if let identity {
                    keychain.delete(for: identity)
                    keychain.deleteRecordingProof(for: identity)
                }
                preferences.linkedIdentity = nil
                identity = nil
                client = nil
            case .revokeRemotely(let generation):
                startRevokeTask(generation: generation)
            case .clearLocalData(let keepInstance):
                if keepInstance {
                    if let identity { keychain.delete(for: identity); keychain.deleteRecordingProof(for: identity) }
                    preferences.clearAccountData()
                } else {
                    preferences.clearAll()
                }
                backtrackState = nil
                linkEndCount += 1
            case .showLogoutUnconfirmed:
                lastDiagnostic = "Server-side revocation couldn't be confirmed while offline. "
                    + "This Mac may still be listed in Moss under Active sessions; you can sign it out there."
            }
        }
    }

    // MARK: - Async work, one Task per generation

    private func startHeartbeatTask(generation: Int, after delay: TimeInterval) {
        tasks[generation]?.cancel()
        guard let identity, let client, let credential = keychain.read(for: identity) else {
            // No usable credential (Keychain locked, denied or emptied): without this the app
            // would sit on Reconnecting forever with nothing left to retry.
            Task { await self.handle(.heartbeatFailed(.credentialInvalid, generation: generation)) }
            return
        }
        let appVersion = appVersion
        let osVersion = osVersion

        tasks[generation] = Task { [weak self] in
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                if Task.isCancelled { return }
            }
            do {
                let response = try await client.heartbeat(credential: credential, app: appVersion, os: osVersion)
                self?.recordDisplayName(response.device.displayName)
                self?.noteBacktrackState(response.backtrack)
                let contactTime = ServerTime.parse(response.serverTime) ?? Date()
                await self?.handle(.heartbeatSucceeded(at: contactTime, generation: generation))
            } catch let error as CompanionError {
                if Task.isCancelled { return }
                await self?.handle(.heartbeatFailed(error, generation: generation))
            } catch {
                // A cancelled attempt was superseded by a newer one — it says nothing about the
                // network, so it must not count as a failure or advance the backoff.
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                await self?.handle(.heartbeatFailed(.unreachable, generation: generation))
            }
        }
    }

    private func startRevokeTask(generation: Int) {
        guard let identity, let client, let credential = keychain.read(for: identity) else { return }
        tasks[generation]?.cancel()
        tasks[generation] = Task { [weak self] in
            do {
                try await client.logout(credential: credential)
            } catch let error as CompanionError {
                if Task.isCancelled { return }
                // Already revoked on the server, so there is nothing left to confirm.
                if error == .credentialInvalid { return }
                await self?.handle(.heartbeatFailed(error, generation: generation))
            } catch {
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                await self?.handle(.heartbeatFailed(.unreachable, generation: generation))
            }
        }
    }

    private func cancelAllTasks() {
        for task in tasks.values {
            task.cancel()
        }
        tasks.removeAll()
        renameTask?.cancel()
        renameTask = nil
    }

    private func handle(_ event: ConnectionEvent) async {
        guard beforeLifecycleChange?(event) ?? true else { return }
        apply(machine.handle(event, now: Date()))
    }

    private func recordDisplayName(_ displayName: String) {
        preferences.displayName = displayName
    }

    /// Moss's answer about Backtrack storage. A heartbeat from a Moss without Backtrack has none,
    /// which means it isn't stored there.
    func noteBacktrackState(_ state: BacktrackState?) {
        guard identity != nil, state != backtrackState else { return }
        backtrackState = state
        preferences.backtrackServerState = state
    }

    /// A client and the credential for a request made outside the heartbeat (Backtrack uploads).
    /// Nil while not linked, paused, or when the Keychain can't give the credential.
    func requestClient() -> (CompanionClient, String)? {
        switch state {
        case .connected, .reconnecting: break
        case .disconnected, .notLinked, .signInRequired: return nil
        }
        guard let identity, let credential = keychain.read(for: identity) else { return nil }
        return (CompanionClient(instance: identity.instance, transport: transportFactory(identity.instance)), credential)
    }

    func recordingCredentials() -> (identity: LinkedIdentity, companion: String, proof: String)? {
        guard let identity, let (_, companion) = requestClient(),
              let proof = keychain.readRecordingProof(for: identity) else { return nil }
        return (identity, companion, proof)
    }

    func storeRecordingProof(_ proof: String, for approvedIdentity: LinkedIdentity) throws {
        guard identity == approvedIdentity, proof.count == 43 else { throw MeetingHostError.authorizationExpired }
        try keychain.storeRecordingProof(proof, for: approvedIdentity)
        keychain.deletePendingRecordingProof(for: approvedIdentity)
        recordingProofRevision += 1
    }

    /// Called only after bootstrap itself rejects the saved proof. Do not publish a revision
    /// that would initiate another approval automatically; the user's next Connect retries it.
    func discardRejectedRecordingProof() {
        if let identity { keychain.deleteRecordingProof(for: identity) }
    }

    /// Existing devices ask for the same one-time connection approval in the user's current
    /// Moss tab. Persist the independent candidate before requesting, so lost replies/relaunch
    /// retry the same proof and request key rather than replacing an approved capability.
    func refreshRecordingCapability() async throws -> String {
        guard let expectedIdentity = identity, let (client, credential) = requestClient() else {
            throw MeetingHostError.authorizationExpired
        }
        if keychain.readRecordingProof(for: expectedIdentity) != nil { return "approved" }
        let existing = keychain.readPendingRecordingProof(for: expectedIdentity)
        var pending = existing ??
            PendingRecordingProof(requestKey: UUID().uuidString.lowercased(), proof: LinkAttempt.makeVerifier())
        // The attempt's deadline bounds consent, not an approval already made while this
        // Mac was offline. Reconcile the same proof/key before discarding any candidate.
        if existing == nil { try keychain.storePendingRecordingProof(pending, for: expectedIdentity) }
        if pending.attemptId == nil {
            let reply = try await client.requestRecordingCapability(credential: credential,
                requestKey: pending.requestKey, proofHash: MeetingCaptureClient.verifierHash(pending.proof))
            guard identity == expectedIdentity, !Task.isCancelled, requestClient() != nil else { return "cancelled" }
            pending.attemptId = reply.attemptId
            pending.expiresAt = reply.expiresAt
            try keychain.storePendingRecordingProof(pending, for: expectedIdentity)
        }
        guard let attemptId = pending.attemptId else { throw MeetingHostError.invalidResponse }
        let reply = try await client.recordingCapabilityStatus(credential: credential, attemptId: attemptId)
        guard identity == expectedIdentity, !Task.isCancelled, requestClient() != nil else { return "cancelled" }
        if reply.status == "approved" {
            guard reply.policyVersion == 1, (reply.revision ?? 0) > 0 else { throw MeetingHostError.invalidResponse }
            try storeRecordingProof(pending.proof, for: expectedIdentity)
        } else if reply.status == "expired" || reply.status == "denied" {
            keychain.deletePendingRecordingProof(for: expectedIdentity)
        }
        return reply.status
    }

    // MARK: - Settings-pane actions

    var displayName: String? { preferences.displayName }

    func openInstanceInBrowser() {
        guard let identity else { return }
        NSWorkspace.shared.open(identity.instance.origin)
    }

    /// A connection operation: sent only while linked and not paused (#2643), never gated on
    /// Focus. The task is tracked, so Pause cancels a rename still in flight.
    func rename(displayName: String) {
        switch state {
        case .connected, .reconnecting: break
        case .disconnected, .notLinked, .signInRequired: return
        }
        guard let identity, let client, let credential = keychain.read(for: identity) else { return }
        renameTask?.cancel()
        renameTask = Task {
            do {
                try await client.rename(credential: credential, displayName: displayName)
                if Task.isCancelled { return }
                self.preferences.displayName = displayName
            } catch {
                // Best effort: the next successful heartbeat will re-read the server's name,
                // but there is no queued retry for a rename made while offline.
            }
        }
    }

    // MARK: - System signals

    private func observeSystemEvents() {
        // ConnectionRuntime is a single, app-lifetime object owned by AppDelegate, so retaining
        // `self` in these two long-lived system callbacks is not a meaningful leak.
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in self.send(.wake) }
        }

        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                // The first callback only reports the current path; it is a baseline, not a change.
                defer { self.lastPathSatisfied = satisfied }
                if satisfied, self.lastPathSatisfied == false {
                    self.send(.networkChanged)
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.moss.trailmarker.path-monitor"))
        pathMonitor = monitor
    }
}

extension ConnectionRuntime: BacktrackUploadEnvironment {}

// MARK: - Diagnostics

/// Text for the "View Details" affordance the design guide asks every failure state to offer.
/// Never includes a credential, verifier, or `Authorization` header value — only what is safe to
/// read aloud or copy into a support message.
enum Diagnostics {
    static func describe(_ error: CompanionError) -> String {
        switch error {
        case .unreachable:
            return "Can't reach this Moss instance. Check the URL and network connection."
        case .tls:
            return "This Moss instance's certificate could not be verified."
        case .incompatible(let version):
            let suffix = version.map { " (server reports protocol \($0))" } ?? ""
            return "This Moss version isn't compatible with Trail Marker\(suffix)."
        case .credentialInvalid:
            return "This Mac is no longer linked."
        case .accountBlocked(let code):
            return "This account is not available (\(code))."
        case .rateLimited:
            return "Too many requests. Trail Marker will try again shortly."
        case .server(let status):
            return "The server returned an error (status \(status))."
        case .redirectedOffOrigin:
            return "The instance redirected to a different address."
        case .decoding:
            return "Received an unexpected response from the server."
        case .focusNotReady:
            return "Focus judgment isn't set up on your Moss."
        case .noBlock:
            return "There is no Moss calendar block right now."
        case .backtrackUnavailable:
            return "This Moss isn't storing Backtrack history."
        case .backtrackPaused:
            return "Backtrack is paused from Moss."
        case .backtrackClock:
            return "This Mac's clock looks wrong."
        }
    }

    static func describeHeartbeatFailure(
        _ error: CompanionError,
        request: URLRequest?,
        at date: Date
    ) -> String {
        var lines = [describe(error)]
        if let url = request?.url {
            lines.append("Endpoint: \(url.scheme ?? "")://\(url.host ?? "")\(url.path)")
        }
        lines.append("Time: \(ISO8601DateFormatter().string(from: date))")
        return lines.joined(separator: "\n")
    }
}

/// The server sends fractional seconds (`2026-09-20T21:26:40.572Z`), which a default
/// `ISO8601DateFormatter` rejects.
enum ServerTime {
    static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func parse(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}
