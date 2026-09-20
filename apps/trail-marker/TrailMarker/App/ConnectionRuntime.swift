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

    private var machine = ConnectionMachine()
    private let keychain: KeychainStore
    private let preferences: PreferencesStore
    private let transportFactory: (InstanceURL) -> CompanionTransport
    private let appVersion: String
    private let osVersion: String

    private var client: CompanionClient?
    private var tasks: [Int: Task<Void, Never>] = [:]
    private var pathMonitor: NWPathMonitor?
    private var wakeObserver: NSObjectProtocol?
    private var lastPathSatisfied = false

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
                identity = newIdentity
                preferences.linkedIdentity = newIdentity
                client = CompanionClient(
                    instance: newIdentity.instance, transport: transportFactory(newIdentity.instance)
                )
                try? keychain.store(credential: credential, for: newIdentity)
            case .clearCredential:
                if let identity {
                    keychain.delete(for: identity)
                }
                preferences.linkedIdentity = nil
                identity = nil
                client = nil
            case .revokeRemotely(let generation):
                startRevokeTask(generation: generation)
            case .showLogoutUnconfirmed:
                lastDiagnostic =
                    "Logged out on this Mac. Server-side revocation couldn't be confirmed while offline."
            }
        }
    }

    // MARK: - Async work, one Task per generation

    private func startHeartbeatTask(generation: Int, after delay: TimeInterval) {
        tasks[generation]?.cancel()
        guard let identity, let client, let credential = keychain.read(for: identity) else { return }
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
                guard let serverTime = ISO8601DateFormatter().date(from: response.serverTime) else { return }
                await self?.handle(.heartbeatSucceeded(at: serverTime, generation: generation))
            } catch let error as CompanionError {
                await self?.handle(.heartbeatFailed(error, generation: generation))
            } catch {
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
                await self?.handle(.heartbeatFailed(error, generation: generation))
            } catch {
                await self?.handle(.heartbeatFailed(.unreachable, generation: generation))
            }
        }
    }

    private func cancelAllTasks() {
        for task in tasks.values {
            task.cancel()
        }
        tasks.removeAll()
    }

    private func handle(_ event: ConnectionEvent) async {
        apply(machine.handle(event, now: Date()))
    }

    private func recordDisplayName(_ displayName: String) {
        preferences.displayName = displayName
    }

    // MARK: - Settings-pane actions

    var displayName: String? { preferences.displayName }

    func openInstanceInBrowser() {
        guard let identity else { return }
        NSWorkspace.shared.open(identity.instance.origin)
    }

    func rename(displayName: String) {
        guard let identity, let client, let credential = keychain.read(for: identity) else { return }
        Task {
            do {
                try await client.rename(credential: credential, displayName: displayName)
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
                defer { self.lastPathSatisfied = satisfied }
                if satisfied, !self.lastPathSatisfied {
                    self.send(.networkChanged)
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.moss.trailmarker.path-monitor"))
        pathMonitor = monitor
    }
}

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
