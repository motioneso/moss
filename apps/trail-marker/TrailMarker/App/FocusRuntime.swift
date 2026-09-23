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
    /// Rung 3's text description, when a capture happened. Never the image (rung3 spec §7:
    /// nothing is written to disk or kept beyond one request); this is the same text that was
    /// sent to Moss for the second judge call.
    let screenDescription: String?
}

/// Whether a rung-1 answer is worth escalating to a capture (rung3 spec §2). Pure and separate
/// from the async capture/describe/re-judge mechanics in `FocusRuntime`, so this one decision —
/// only to resolve insufficient_evidence, only with consent, only with the permission granted —
/// has a direct test.
enum Rung3Decision {
    static func shouldCapture(label: FocusLabel, rung3Enabled: Bool, screenRecordingGranted: Bool) -> Bool {
        label == .insufficientEvidence && rung3Enabled && screenRecordingGranted
    }
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
    /// Watch every app instead of only the chosen ones (still subject to the denylist).
    @Published private(set) var watchEntireDesktop: Bool
    /// Rung 3 (#2570 slice 2). Off by default; the Focus pane refuses to turn it on without
    /// Screen Recording already granted.
    @Published private(set) var rung3Enabled: Bool
    @Published private(set) var visionSource: VisionSource
    @Published private(set) var visionBaseURL: String
    @Published private(set) var visionModel: String
    /// The last "Test vision" result, shown in the Focus pane. Cleared on the next attempt.
    @Published private(set) var visionTestResult: Result<String, VisionError>?
    /// What Test actually captured — kept only for this in-memory debugging view, never sent
    /// anywhere but the vision source, so the person can see whether the wrong window was
    /// captured instead of only trusting the description.
    @Published private(set) var visionTestCapture: (appName: String, image: Data)?
    /// Whether a key is stored, so the Focus pane can say so. A plain keychain read would not
    /// republish the view on its own; this is updated everywhere the key can change.
    @Published private(set) var hasVisionAPIKey: Bool

    private var machine: FocusMachine
    private let connection: ConnectionRuntime
    private let permissions: PermissionsService
    private let preferences: PreferencesStore
    private let keychain: KeychainStore
    private let observer: FrontmostObserver
    private let nudges: NudgeDelivering
    private let transportFactory: (InstanceURL) -> CompanionTransport
    private let windowCapture: WindowCapturing
    private let visionDescriberFactory: (VisionSource, String, String, String) -> VisionDescribing

    /// `observer.current` reads nil whenever Trail Marker's own window is frontmost — which it
    /// always is while the person is sitting in Focus settings pressing Test. This is the last
    /// real app seen, kept only in memory, so Test has something to capture without asking the
    /// person to go click into another app first.
    private var lastKnownApp: Observation?

    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var lastSent: (appName: String, windowTitle: String, blockTitle: String, description: String?)?
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
        transportFactory: @escaping (InstanceURL) -> CompanionTransport = { _ in URLSessionTransport() },
        windowCapture: WindowCapturing = ScreenCaptureKitCapture(),
        visionDescriberFactory: @escaping (VisionSource, String, String, String) -> VisionDescribing = {
            source, baseURL, model, apiKey in
            switch source {
            case .cli:
                return CLIVisionDescriber()
            case .apiKey:
                guard let url = URL(string: baseURL), !baseURL.isEmpty else {
                    return HTTPVisionDescriber(baseURL: URL(string: "about:blank")!, model: model, apiKey: "")
                }
                return HTTPVisionDescriber(baseURL: url, model: model, apiKey: apiKey)
            }
        }
    ) {
        self.connection = connection
        self.permissions = permissions
        self.nudges = nudges
        self.preferences = preferences
        self.keychain = keychain
        self.observer = observer ?? FrontmostObserver()
        self.transportFactory = transportFactory
        self.windowCapture = windowCapture
        self.visionDescriberFactory = visionDescriberFactory
        self.consent = preferences.focusConsent
        self.paused = preferences.focusPaused
        self.allowedBundleIds = preferences.focusAllowedBundleIds
        self.watchEntireDesktop = preferences.focusWatchEntireDesktop
        self.rung3Enabled = preferences.focusRung3Enabled
        self.visionSource = preferences.focusVisionSource
        self.visionBaseURL = preferences.focusVisionBaseURL
        self.visionModel = preferences.focusVisionModel
        self.hasVisionAPIKey = keychain.readVisionKey() != nil
        self.machine = FocusMachine(policy: ObservationPolicy(
            allowedBundleIds: preferences.focusAllowedBundleIds,
            watchEntireDesktop: preferences.focusWatchEntireDesktop
        ))
    }

    func start() {
        // macOS shows the prompt only while the answer is still "never asked", so this does nothing
        // once the person has answered. Without it a build that never got the first answer (a new
        // signing identity, an install made after Focus was already on) would never ask at all.
        if consent { nudges.requestAuthorization() }
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
        send(.policyChanged(ObservationPolicy(allowedBundleIds: updated, watchEntireDesktop: watchEntireDesktop)))
    }

    /// Watching the whole desktop instead of chosen apps. The chosen apps are kept, not cleared,
    /// so turning this back off restores exactly what was picked before.
    func setWatchEntireDesktop(_ value: Bool) {
        watchEntireDesktop = value
        preferences.focusWatchEntireDesktop = value
        send(.policyChanged(ObservationPolicy(allowedBundleIds: allowedBundleIds, watchEntireDesktop: value)))
    }

    /// Refused (left unchanged) without Screen Recording already granted, so the toggle can never
    /// silently do nothing (rung3 spec §5).
    func setRung3Enabled(_ value: Bool) {
        guard !value || permissions.screenRecording == .granted else { return }
        rung3Enabled = value
        preferences.focusRung3Enabled = value
    }

    func setVisionSource(_ value: VisionSource) {
        visionSource = value
        preferences.focusVisionSource = value
    }

    func setVisionBaseURL(_ value: String) {
        visionBaseURL = value
        preferences.focusVisionBaseURL = value
    }

    func setVisionModel(_ value: String) {
        visionModel = value
        preferences.focusVisionModel = value
    }

    /// `nil` or empty clears the stored key without setting a new one (an empty "Test" field, say).
    func setVisionAPIKey(_ value: String?) {
        if let value, !value.isEmpty {
            try? keychain.storeVisionKey(value)
        } else {
            keychain.deleteVisionKey()
        }
        hasVisionAPIKey = keychain.readVisionKey() != nil
    }

    /// Captures and describes right now, independent of any judgment, so the person can see the
    /// chosen source actually works before relying on it (rung3 spec §9's "Send a test nudge"
    /// pattern, applied to vision). Saves `enteredAPIKey` first when one was typed but not yet
    /// submitted, so Test never silently runs against an empty key the person can see on screen.
    func testVision(enteredAPIKey: String = "") {
        if !enteredAPIKey.isEmpty { setVisionAPIKey(enteredAPIKey) }
        // `observer.current` reads nil while Trail Marker's own Settings window is frontmost,
        // which it is right now — `lastKnownApp` is the real app that was in front just before.
        visionTestCapture = nil
        guard let app = lastKnownApp ?? observer.current else {
            visionTestResult = .failure(.noAppToCapture)
            return
        }
        let describer = visionDescriberFactory(
            visionSource, visionBaseURL, visionModel, keychain.readVisionKey() ?? ""
        )
        track { [weak self] in
            guard let self else { return }
            let image: Data
            do {
                image = try await self.windowCapture.captureFrontmostWindow(bundleId: app.bundleId)
            } catch let error as ScreenCaptureError {
                // Distinct from describe() failing below: this never reached the vision source at
                // all, so it must never be reported as "couldn't reach the vision source".
                switch error {
                case .windowNotFound:
                    self.visionTestResult = .failure(
                        .captureFailed(detail: "\(app.appName) has no window on screen right now")
                    )
                case .captureFailed:
                    self.visionTestResult = .failure(
                        .captureFailed(detail: "the screenshot itself failed — check Screen Recording is granted")
                    )
                }
                return
            } catch {
                self.visionTestResult = .failure(.captureFailed(detail: "\(error)"))
                return
            }
            // Recorded before describe() runs, so a describe failure still shows what was
            // actually captured — the two are separate questions and separate places to be wrong.
            self.visionTestCapture = (appName: app.appName, image: image)
            do {
                let description = try await describer.describe(image)
                self.visionTestResult = .success(description)
            } catch let error as VisionError {
                self.visionTestResult = .failure(error)
            } catch {
                self.visionTestResult = .failure(.unreachable)
            }
        }
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
        if machine.state != state { focusDebug("State: \(Self.describe(machine.state))") }
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
                focusDebug("NUDGE shown: back to \"\(title)\"")
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
            observer.start { [weak self] observation in self?.appChanged(observation) }
            appChanged(observer.current)
        } else if !shouldObserve, observing {
            observing = false
            observer.stop()
        }
    }

    private func appChanged(_ observation: Observation?) {
        if let observation {
            lastKnownApp = observation
            let policy = ObservationPolicy(allowedBundleIds: allowedBundleIds, watchEntireDesktop: watchEntireDesktop)
            let title = observation.windowTitle.isEmpty ? "(no title)" : "\"\(observation.windowTitle.prefix(80))\""
            focusDebug("Now in \(observation.appName) \(title): \(policy.explain(observation))")
        }
        send(.appChanged(observation))
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

        focusDebug("-> Judging \(request.appName) \"\(request.windowTitle.prefix(80))\"")
        track { [weak self] in
            guard let self else { return }
            do {
                let judgment = try await client.focusJudge(credential: credential, request)
                if Task.isCancelled { return }
                focusDebug("<- \(Self.describe(judgment))")

                // A capture failure or an unreachable/rejected/unconfigured vision source is soft:
                // rung 1's own answer stands, exactly as if rung 3 were off.
                guard
                    Rung3Decision.shouldCapture(
                        label: judgment.label, rung3Enabled: self.rung3Enabled,
                        screenRecordingGranted: self.permissions.screenRecording == .granted
                    )
                else {
                    if judgment.label == .insufficientEvidence {
                        focusDebug(
                            "No screen capture: " + (self.rung3Enabled ? "Screen Recording not granted" : "screen capture is off")
                        )
                    }
                    self.lastSent = (request.appName, request.windowTitle, self.currentBlockTitle ?? "", nil)
                    self.send(.judged(judgment, generation: generation))
                    return
                }

                let describer = self.visionDescriberFactory(
                    self.visionSource, self.visionBaseURL, self.visionModel,
                    self.keychain.readVisionKey() ?? ""
                )
                let description: String?
                do {
                    focusDebug("Capturing \(observation.appName)'s window…")
                    let image = try await self.windowCapture.captureFrontmostWindow(
                        bundleId: observation.bundleId
                    )
                    focusDebug("Captured \(image.count / 1024) KB, describing…")
                    description = try await describer.describe(image)
                    focusDebug("Screen described: \"\((description ?? "").prefix(200))\"")
                } catch {
                    focusDebug("Capture or description failed: \(error)")
                    description = nil
                }

                guard let description, !Task.isCancelled else {
                    self.lastSent = (request.appName, request.windowTitle, self.currentBlockTitle ?? "", nil)
                    self.send(.judged(judgment, generation: generation))
                    return
                }

                let cleanedDescription = TextRedactor.clean(description, limit: 280)
                let secondRequest = FocusJudgeRequest(
                    blockId: blockId, appName: request.appName, windowTitle: request.windowTitle,
                    description: cleanedDescription, observedAt: ServerTime.format(Date())
                )
                self.lastSent = (
                    secondRequest.appName, secondRequest.windowTitle, self.currentBlockTitle ?? "",
                    cleanedDescription
                )
                focusDebug("-> Judging again with the screen description")
                do {
                    let secondJudgment = try await client.focusJudge(credential: credential, secondRequest)
                    if Task.isCancelled { return }
                    focusDebug("<- \(Self.describe(secondJudgment))")
                    self.send(.judged(secondJudgment, generation: generation))
                } catch {
                    if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                    focusDebug("Judge failed: \(error)")
                    self.send(.judgeFailed(error as? CompanionError ?? .unreachable, generation: generation))
                }
            } catch {
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
                focusDebug("Judge failed: \(error)")
                self.send(.judgeFailed(error as? CompanionError ?? .unreachable, generation: generation))
            }
        }
    }

    // MARK: - Debug log text

    private static func describe(_ judgment: FocusJudgment) -> String {
        let reason = judgment.reason.isEmpty ? "" : ": \(judgment.reason)"
        return "\(judgment.label.rawValue)\(judgment.nudge ? " (nudge)" : "")\(reason)"
    }

    private static func describe(_ state: FocusWatchState) -> String {
        if case .watching(_, let title, let endsAt) = state {
            return "watching \"\(title)\" until \(endsAt.formatted(date: .omitted, time: .shortened))"
        }
        return "\(state)"
    }

    private var currentBlockTitle: String? {
        if case .watching(_, let title, _) = state { return title }
        return nil
    }

    private func remember(_ judgment: FocusJudgment) {
        guard let sent = lastSent else { return }
        lastJudgment = RememberedJudgment(
            judgment: judgment, at: Date(), blockTitle: sent.blockTitle, appName: sent.appName,
            windowTitle: sent.windowTitle, screenDescription: sent.description
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
