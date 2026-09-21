import AppKit
import Combine
import Foundation

/// How a nudge reaches the person. A protocol so the runtime does not depend on the real
/// notification centre (the real one is `NudgeService`).
@MainActor
protocol NudgeDelivering {
    func requestAuthorization()
    func showNudge(blockTitle: String)
    func showTestNudge()
}

/// The last judgment, kept in memory only so the person can see and correct it. It is never
/// written to disk and never logged: it holds the (already shortened) app name and window title
/// that were sent.
struct RememberedJudgment: Equatable {
    let judgment: FocusJudgment
    let at: Date
    let blockTitle: String
    let appName: String
    let windowTitle: String
}

/// Executes what a `FocusMachine` returns: the requests, the timers, the saved settings and the
/// notifications. The machine decides; this only does. It never logs a window title.
@MainActor
final class FocusRuntime: ObservableObject {
    @Published private(set) var state: FocusWatchState = .off
    @Published private(set) var lastJudgment: RememberedJudgment?
    @Published private(set) var consent: Bool
    @Published private(set) var paused: Bool
    @Published private(set) var allowedBundleIds: Set<String>

    private var machine: FocusMachine
    private let connection: ConnectionRuntime
    private let permissions: PermissionsService
    private let preferences: PreferencesStore
    private let keychain: KeychainStore
    private let observer: FrontmostObserver
    private let nudges: NudgeDelivering
    private let transportFactory: (InstanceURL) -> CompanionTransport

    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var lastSent: (appName: String, windowTitle: String, blockTitle: String)?
    private var cancellables = Set<AnyCancellable>()
    private var wakeObserver: NSObjectProtocol?
    private var observing = false

    init(
        connection: ConnectionRuntime,
        permissions: PermissionsService,
        nudges: NudgeDelivering,
        preferences: PreferencesStore = PreferencesStore(),
        keychain: KeychainStore = KeychainStore(),
        observer: FrontmostObserver? = nil,
        transportFactory: @escaping (InstanceURL) -> CompanionTransport = { _ in URLSessionTransport() }
    ) {
        self.connection = connection
        self.permissions = permissions
        self.nudges = nudges
        self.preferences = preferences
        self.keychain = keychain
        self.observer = observer ?? FrontmostObserver()
        self.transportFactory = transportFactory
        self.consent = preferences.focusConsent
        self.paused = preferences.focusPaused
        self.allowedBundleIds = preferences.focusAllowedBundleIds
        self.machine = FocusMachine(policy: ObservationPolicy(allowedBundleIds: preferences.focusAllowedBundleIds))
    }

    func start() {
        apply(machine.handle(.launched(consent: consent, paused: paused), now: Date()))
        send(.accessibilityChanged(granted: permissions.accessibility == .granted))

        connection.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                var isConnected = false
                if case .connected = state { isConnected = true }
                self?.send(.connectionChanged(isConnected: isConnected))
            }
            .store(in: &cancellables)

        permissions.$accessibility
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in self?.send(.accessibilityChanged(granted: state == .granted)) }
            .store(in: &cancellables)

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in self.send(.wake) }
        }
    }

    // MARK: - What the person can do

    func setConsent(_ value: Bool) { send(.userToggleConsent(value)) }
    func pause() { send(.userPause) }
    func resume() { send(.userResume) }
    func testNudge() { send(.userTestNudge) }

    func judgeNow() {
        permissions.refresh()
        send(.accessibilityChanged(granted: permissions.accessibility == .granted))
        send(.userJudgeNow)
    }

    func setAllowed(_ bundleId: String, allowed: Bool) {
        var updated = allowedBundleIds
        if allowed { updated.insert(bundleId) } else { updated.remove(bundleId) }
        allowedBundleIds = updated
        preferences.focusAllowedBundleIds = updated
        send(.policyChanged(ObservationPolicy(allowedBundleIds: updated)))
    }

    func correct(_ verdict: FocusVerdict) {
        guard let remembered = lastJudgment, let identity = connection.identity,
            let credential = keychain.read(for: identity)
        else { return }
        let client = CompanionClient(instance: identity.instance, transport: transportFactory(identity.instance))
        track {
            try? await client.focusCorrect(
                credential: credential, judgmentId: remembered.judgment.judgmentId, verdict: verdict
            )
        }
    }

    /// The line the menu shows and the icon's hover text repeats.
    var goalLine: String? {
        guard case .watching(_, let title, let endsAt) = state else { return nil }
        return "\(title), ends \(endsAt.formatted(date: .omitted, time: .shortened))"
    }

    // MARK: - Effects

    func send(_ event: FocusEvent) {
        apply(machine.handle(event, now: Date()))
    }

    private func apply(_ effects: [FocusEffect]) {
        state = machine.state
        for effect in effects {
            switch effect {
            case .fetchContext(let generation):
                fetchContext(generation: generation)
            case .scheduleContext(let delay, let generation):
                schedule(after: delay) { self.send(.contextTimerFired(generation: generation)) }
            case .scheduleSample(let delay, let generation):
                schedule(after: delay) { self.send(.sampleTimerFired(generation: generation)) }
            case .sendObservation(let observation, let blockId, let generation):
                sendObservation(observation, blockId: blockId, generation: generation)
            case .cancelAll:
                cancelAllTasks()
            case .persistPaused(let value):
                paused = value
                preferences.focusPaused = value
            case .persistConsent(let value):
                consent = value
                preferences.focusConsent = value
            case .requestNotificationPermission:
                nudges.requestAuthorization()
            case .showNudge(let title):
                nudges.showNudge(blockTitle: title)
            case .showTestNudge:
                nudges.showTestNudge()
            case .rememberJudgment(let judgment):
                remember(judgment)
            }
        }
        updateObserving()
    }

    private func updateObserving() {
        let shouldObserve = consent && !paused && isConnected
        if shouldObserve, !observing {
            observing = true
            observer.start { [weak self] observation in self?.send(.appChanged(observation)) }
            send(.appChanged(observer.current))
        } else if !shouldObserve, observing {
            observing = false
            observer.stop()
        }
    }

    private var isConnected: Bool {
        if case .connected = connection.state { return true }
        return false
    }

    private func fetchContext(generation: Int) {
        guard let (client, credential) = clientAndCredential() else {
            send(.contextFailed(.credentialInvalid, generation: generation))
            return
        }
        track { [weak self] in
            do {
                let context = try await client.focusContext(credential: credential)
                if Task.isCancelled { return }
                self?.send(.contextLoaded(context, generation: generation))
            } catch {
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                self?.send(.contextFailed(error as? CompanionError ?? .unreachable, generation: generation))
            }
        }
    }

    private func sendObservation(_ observation: Observation, blockId: String, generation: Int) {
        guard let (client, credential) = clientAndCredential() else {
            send(.judgeFailed(.credentialInvalid, generation: generation))
            return
        }
        // Everything is shortened and stripped of secret-looking text here, at the last moment
        // before it leaves this Mac.
        let appName = TextRedactor.clean(observation.appName, limit: 64)
        let title = TextRedactor.clean(observation.windowTitle, limit: 200)
        let request = FocusJudgeRequest(
            blockId: blockId, appName: appName.isEmpty ? "App" : appName, windowTitle: title,
            observedAt: ServerTime.format(Date())
        )
        lastSent = (request.appName, request.windowTitle, currentBlockTitle ?? "")

        track { [weak self] in
            do {
                let judgment = try await client.focusJudge(credential: credential, request)
                if Task.isCancelled { return }
                self?.send(.judged(judgment, generation: generation))
            } catch {
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                self?.send(.judgeFailed(error as? CompanionError ?? .unreachable, generation: generation))
            }
        }
    }

    private var currentBlockTitle: String? {
        if case .watching(_, let title, _) = state { return title }
        return nil
    }

    private func remember(_ judgment: FocusJudgment) {
        guard let sent = lastSent else { return }
        lastJudgment = RememberedJudgment(
            judgment: judgment, at: Date(), blockTitle: sent.blockTitle, appName: sent.appName,
            windowTitle: sent.windowTitle
        )
    }

    private func clientAndCredential() -> (CompanionClient, String)? {
        guard let identity = connection.identity, let credential = keychain.read(for: identity) else { return nil }
        return (CompanionClient(instance: identity.instance, transport: transportFactory(identity.instance)), credential)
    }

    // MARK: - Tasks

    private func schedule(after delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
        track {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            work()
        }
    }

    private func track(_ work: @escaping @MainActor () async -> Void) {
        let id = UUID()
        tasks[id] = Task { @MainActor [weak self] in
            await work()
            self?.tasks.removeValue(forKey: id)
        }
    }

    private func cancelAllTasks() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
    }
}
