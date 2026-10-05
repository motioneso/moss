import AppKit
import Combine
import Foundation

/// A cancellable one-shot timer, so the runtime's timing is replaced in tests.
@MainActor
protocol BacktrackTimer: AnyObject { func cancel() }

@MainActor
protocol BacktrackScheduling {
    func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> BacktrackTimer
}

@MainActor
private final class RunLoopTimer: BacktrackTimer {
    var timer: Timer?
    func cancel() {
        timer?.invalidate()
        timer = nil
    }
}

struct RunLoopScheduler: BacktrackScheduling {
    func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> BacktrackTimer {
        let handle = RunLoopTimer()
        handle.timer = Timer.scheduledTimer(withTimeInterval: max(delay, 0), repeats: false) { _ in
            Task { @MainActor in action() }
        }
        return handle
    }
}

/// What the runtime needs from the outside world, all replaceable in tests.
@MainActor
struct BacktrackServices {
    var capture: WindowCapturing
    var secureFields: SecureFieldLocating
    var addresses: BrowserAddressReading
    var recognizer: TextRecognizing
    var thumbnails: ThumbnailComparing
    /// The focused window of a process as it is right now (plan §3.1: capture binds to a fresh read).
    var freshWindowIdentity: (pid_t) -> WindowIdentity?
    var clock: () -> Date
    var scheduler: BacktrackScheduling
    var idleSeconds: () -> TimeInterval = { 0 }
    /// Seconds since a key last went down; periodic reads wait while the person types.
    var keyboardIdleSeconds: () -> TimeInterval = { .infinity }
    /// Accessibility text first (plan §7, retry 2, task 3). The default reads nothing, so
    /// recognition decides, as before.
    var windowText: WindowTextReading = NoWindowText()

    static func live() -> BacktrackServices {
        BacktrackServices(
            capture: ScreenCaptureKitCapture(),
            secureFields: AXSecureFieldLocator(),
            addresses: AXBrowserAddressReader(),
            recognizer: VisionTextRecognizer(),
            thumbnails: ThumbnailChangeDetector(),
            freshWindowIdentity: { WorkspaceFrontmostSource.focusedWindowIdentity(pid: $0) },
            clock: Date.init,
            scheduler: RunLoopScheduler(),
            idleSeconds: {
                CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
            },
            keyboardIdleSeconds: { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown) },
            windowText: AXWindowTextReader()
        )
    }
    /// For the UI test harness: every capture fails, so nothing is ever read from the screen.
    static func inert() -> BacktrackServices {
        struct NoCapture: WindowCapturing {
            func capture(_ window: WindowIdentity, pid: pid_t, maxDimension: CGFloat) async throws -> CGImage {
                throw ScreenCaptureError.captureFailed
            }
        }
        struct NoSecureFields: SecureFieldLocating {
            func secureFieldFrames(pid: pid_t, window: WindowIdentity, budget: TimeInterval) -> [CGRect]? { nil }
        }
        struct NoAddress: BrowserAddressReading {
            func address(pid: pid_t, window: WindowIdentity, bundleId: String) -> String? { nil }
        }
        struct NoText: TextRecognizing {
            func recognize(_ image: CGImage) async throws -> [String] { [] }
        }
        return BacktrackServices(
            capture: NoCapture(), secureFields: NoSecureFields(), addresses: NoAddress(), recognizer: NoText(),
            thumbnails: ThumbnailChangeDetector(), freshWindowIdentity: { _ in nil }, clock: Date.init,
            scheduler: RunLoopScheduler()
        )
    }
}

/// Executes what `BacktrackMachine` returns. The machine decides; this only does. Its only
/// outputs are `sink` and `isRecording` (plan §4.5): nothing here talks to the network or the
/// disk, and a source check enforces that for every file in this folder but the uploader and
/// its buffer.
@MainActor
final class BacktrackRuntime: ObservableObject {
    /// The version this build's consent sheet records. 2: sent to Moss and kept there (phase 2b).
    static let consentVersion = 2
    /// Secure fields must be found within this, or the capture is skipped (plan §4.3).
    static let secureFieldBudget: TimeInterval = 0.05
    /// One Accessibility text walk, off the main actor (plan §7, retry 2, task 3).
    static let windowTextBudget: TimeInterval = 0.15
    /// Recognition wants more pixels than a vision description does, for small text. Past about
    /// 1600 px Vision costs more without reading better (plan §7, retry 2, task 1).
    static let captureMaxDimension: CGFloat = 1600
    static let thumbnailMaxDimension: CGFloat = 32
    static let idleThreshold: TimeInterval = 300

    @Published private(set) var isRecording = false
    @Published private(set) var enabled: Bool
    @Published private(set) var consentGiven: Int
    @Published private(set) var menuSwitchOn: Bool
    /// The sink's state, for showing Backtrack at all (Release) and "Paused from Moss".
    @Published private(set) var availability: BacktrackSinkAvailability = .unavailable
    /// The menu card's Backtrack row and the menu-bar dot, shared with non-Backtrack views.
    let menuState = FeatureSwitchState()

    private var machine = BacktrackMachine()
    private let connection: ConnectionRuntime
    private let permissions: PermissionsService
    private let focus: FocusRuntime
    private let preferences: PreferencesStore
    private let observer: FrontmostObserver
    private let sink: BacktrackSink
    private let services: BacktrackServices

    private var inputs = BacktrackInputs()
    private var screenLocked = false
    private var sleeping = false
    private var timer: BacktrackTimer?
    private var activityTimer: Timer?
    /// In-flight work, keyed so each task can drop itself when done; reads that end without an
    /// event (an Accessibility read, an unchanged screen) would otherwise pile up all day.
    private var tasks: [UUID: Task<Void, Never>] = [:]
    /// Masked pixels and the address for the chain in flight, never kept past it.
    private var held: (generation: Int, image: CGImage, address: String?, key: DedupeKey)?
    private var cancellables = Set<AnyCancellable>()
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var didStart = false
    /// Kill-gate measurement (#2638): timings and counts only.
    private let metrics = BacktrackMetrics()
    private var trigger = "switch"

    init(
        connection: ConnectionRuntime,
        permissions: PermissionsService,
        focus: FocusRuntime,
        preferences: PreferencesStore = PreferencesStore(),
        observer: FrontmostObserver? = nil,
        sink: BacktrackSink,
        services: BacktrackServices? = nil
    ) {
        self.connection = connection
        self.permissions = permissions
        self.focus = focus
        self.preferences = preferences
        self.observer = observer ?? FrontmostObserver()
        self.sink = sink
        self.services = services ?? .live()
        enabled = preferences.backtrackEnabled
        consentGiven = preferences.backtrackConsentVersion
        menuSwitchOn = !preferences.backtrackSwitchedOff
        menuState.onToggle = { [weak self] on in self?.setMenuSwitch(on: on) }
        availability = sink.availability
    }

    /// The consent the sink requires; a stored older one shows the sheet again.
    var requiredConsentVersion: Int { sink.requiredConsentVersion }
    var needsConsent: Bool { enabled && consentGiven < sink.requiredConsentVersion }

    /// Whether held text may be sent now: Backtrack on and agreed to, its menu switch on, not
    /// Pause All, linked, the screen neither locked nor asleep. Idle doesn't stop sending.
    var allowsSending: Bool {
        guard didStart else { return false }
        let now = currentInputs()
        return now.enabled && now.consentAccepted && now.menuSwitchOn && !now.pausedAll && !now.screenLocked
            && !now.sleeping && now.linked
    }

    // MARK: - Lifecycle

    deinit { activityTimer?.invalidate() }

    func start() {
        guard !didStart else { return }
        didStart = true
        metrics.start()
        inputs = currentInputs()
        apply(machine.handle(.started(inputs, at: services.clock())))
        observer.start { [weak self] observation in
            guard let self else { return }
            self.inputsMayHaveChanged()
            self.trigger = "switch"
            self.apply(self.machine.handle(.frontmostChanged(observation, at: self.services.clock())))
        }
        apply(machine.handle(.frontmostChanged(observer.current, at: services.clock())))

        connection.$state.combineLatest(connection.$identity)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _ in self?.inputsMayHaveChanged() }
            .store(in: &cancellables)
        permissions.$accessibility.combineLatest(permissions.$screenRecording)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _ in self?.inputsMayHaveChanged() }
            .store(in: &cancellables)
        focus.$excludedBundleIds
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.inputsMayHaveChanged() }
            .store(in: &cancellables)
        connection.$backtrackState
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.inputsMayHaveChanged()
                self?.publish()
            }
            .store(in: &cancellables)
        connection.$linkEndCount
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.resetForEndedLink() }
            .store(in: &cancellables)

        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.willSleepNotification) { $0.noteSleeping(true) }
        observe(workspace, NSWorkspace.screensDidSleepNotification) { $0.noteSleeping(true) }
        observe(workspace, NSWorkspace.didWakeNotification) { $0.noteSleeping(false) }
        observe(workspace, NSWorkspace.screensDidWakeNotification) { $0.noteSleeping(false) }
        let distributed = DistributedNotificationCenter.default()
        observe(distributed, Notification.Name("com.apple.screenIsLocked")) { $0.noteScreenLocked(true) }
        observe(distributed, Notification.Name("com.apple.screenIsUnlocked")) { $0.noteScreenLocked(false) }
        observe(NotificationCenter.default, ProcessInfo.thermalStateDidChangeNotification) { _ in }
        observe(NotificationCenter.default, .NSProcessInfoPowerStateDidChange) { _ in }
        activityTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.inputsMayHaveChanged() }
        }
        publish()
    }

    private func observe(
        _ center: NotificationCenter, _ name: Notification.Name, _ change: @escaping @MainActor (BacktrackRuntime) -> Void
    ) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                change(self)
                self.inputsMayHaveChanged()
            }
        }
        observers.append((center, token))
    }

    /// The system's lock and sleep signals land here (and tests call these directly, rather
    /// than posting real system-wide notifications other apps also hear).
    func noteScreenLocked(_ locked: Bool) {
        screenLocked = locked
        inputsMayHaveChanged()
    }

    func noteSleeping(_ asleep: Bool) {
        sleeping = asleep
        inputsMayHaveChanged()
    }

    // MARK: - What the person can do

    /// Settings' switch. Turning it on needs consent first (the sheet calls `acceptConsent`).
    func setEnabled(_ value: Bool) {
        guard !value || consentGiven >= sink.requiredConsentVersion else { return }
        enabled = value
        preferences.backtrackEnabled = value
        if value { permissions.refresh() }
        inputsMayHaveChanged()
    }

    func acceptConsent() {
        consentGiven = Self.consentVersion
        preferences.backtrackConsentVersion = Self.consentVersion
        setEnabled(true)
    }

    /// The menu's Backtrack switch: pauses Backtrack alone.
    func setMenuSwitch(on: Bool) {
        menuSwitchOn = on
        preferences.backtrackSwitchedOff = !on
        inputsMayHaveChanged()
    }

    var needsScreenRecording: Bool { permissions.screenRecording != .granted }
    var needsAccessibility: Bool { permissions.accessibility != .granted }

    // MARK: - Inputs

    private func currentInputs() -> BacktrackInputs {
        var policy = ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true)
        policy.excludedBundleIds = focus.excludedBundleIds
        let thermal = ProcessInfo.processInfo.thermalState
        return BacktrackInputs(
            enabled: enabled,
            consentAccepted: consentGiven >= sink.requiredConsentVersion,
            menuSwitchOn: menuSwitchOn,
            pausedAll: connection.state == .disconnected,
            screenLocked: screenLocked,
            sleeping: sleeping,
            idle: services.idleSeconds() >= Self.idleThreshold,
            linked: connection.identity != nil,
            accessibilityGranted: permissions.accessibility == .granted,
            screenRecordingGranted: permissions.screenRecording == .granted,
            sinkReady: sink.availability == .ready,
            budget: thermal == .serious || thermal == .critical || ProcessInfo.processInfo.isLowPowerModeEnabled
                ? .reduced : .normal,
            policy: policy
        )
    }

    func inputsMayHaveChanged() {
        guard didStart else { return }
        if availability != sink.availability { publish() }
        let next = currentInputs()
        guard next != inputs else { return }
        inputs = next
        apply(machine.handle(.inputsChanged(next, at: services.clock())))
    }

    /// The link ended: forget the account's Backtrack choices and anything held.
    private func resetForEndedLink() {
        enabled = preferences.backtrackEnabled
        consentGiven = preferences.backtrackConsentVersion
        menuSwitchOn = !preferences.backtrackSwitchedOff
        sink.discardAll()
        services.thumbnails.reset()
        inputsMayHaveChanged()
        publish()
    }

    // MARK: - Effects

    private func send(_ event: BacktrackEvent) {
        switch event {
        case .recognized(let generation, _, _, _), .failed(let generation, _):
            if generation == machine.generation { tasks = [:] }
        default: break
        }
        apply(machine.handle(event))
    }

    private func apply(_ effects: [BacktrackEffect]) {
        for effect in effects {
            switch effect {
            case .schedule(let delay, let generation):
                timer?.cancel()
                timer = services.scheduler.schedule(after: delay) { [weak self] in
                    guard let self else { return }
                    self.inputsMayHaveChanged()
                    let typingRecently = self.services.keyboardIdleSeconds() < BacktrackMachine.typingQuiet
                    self.send(.tick(generation: generation, at: self.services.clock(), typingRecently: typingRecently))
                }
            case .readText(let observation, let generation):
                run { [weak self] in await self?.readText(observation, generation: generation) }
            case .checkThumbnail(let observation, let generation):
                run { [weak self] in await self?.checkThumbnail(observation, generation: generation) }
            case .capture(let observation, let generation):
                run { [weak self] in await self?.capture(observation, generation: generation) }
            case .recognize(let generation):
                run { [weak self] in await self?.recognize(generation: generation) }
            case .cancelInFlight:
                timer?.cancel()
                for task in tasks.values { task.cancel() }
                tasks = [:]
                held = nil
            case .emit(let segment):
                metrics.emittedLines = segment.lines.count
                sink.accept(segment)
            case .discardAll:
                held = nil
                services.thumbnails.reset()
                metrics.reset()
                sink.discardAll()
            }
        }
        publish()
    }

    private func run(_ work: @escaping @MainActor () async -> Void) {
        let id = UUID()
        // Runs on the main actor after this insert, so it can't finish before it is tracked.
        tasks[id] = Task { @MainActor [weak self] in
            await work()
            self?.tasks[id] = nil
        }
    }

    private func publish() {
        isRecording = machine.isRecording
        menuState.showsRecordingDot = machine.isRecording
        availability = sink.availability
        menuState.row = enabled && consentGiven >= sink.requiredConsentVersion
            && BacktrackVisibility.shows(isDebugBuild: Self.isDebugBuild, availability: availability)
            ? FeatureSwitchState.Row(title: "Backtrack", isOn: menuSwitchOn)
            : nil
    }

    static var isDebugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    /// The window as it is now, re-checked against the policy on its current title.
    private func freshWindow(for observation: Observation) -> WindowIdentity? {
        let fresh = observation.refreshed(window: services.freshWindowIdentity(observation.pid))
        guard inputs.policy.allowsCapture(fresh) else { return nil }
        return fresh.window
    }

    /// Why a chain stopped, for the focus log. The app name and the kind of failure only: a
    /// capture error's Debug detail carries window titles, which these lines never do.
    private func noteSkipped(_ observation: Observation, _ reason: String) {
        focusDebug("Backtrack: skipped \(observation.appName) — \(reason)")
    }

    private static func describe(_ error: Error) -> String {
        switch error as? ScreenCaptureError {
        case .noMatchingWindow: return "no single on-screen window matched the focused one"
        case .focusMovedDuringCapture: return "focus moved during the picture"
        case .captureFailed, nil: return "the picture couldn't be taken"
        }
    }

    /// The secure-field search, with one immediate second try at the same budget. Measured live
    /// (plan Q1, 2026-09-23): Safari's first search after a switch took 67 ms while its page built
    /// its accessibility tree, then 26 ms and 8 ms. The rule is unchanged: a capture needs a
    /// completed search, and both tries are held to the budget.
    private func locateSecureFields(_ observation: Observation, window: WindowIdentity) -> [CGRect]? {
        if let frames = services.secureFields.secureFieldFrames(
            pid: observation.pid, window: window, budget: Self.secureFieldBudget
        ) {
            return frames
        }
        return services.secureFields.secureFieldFrames(pid: observation.pid, window: window, budget: Self.secureFieldBudget)
    }

    /// Plan §7, retry 2, task 3: the visible text of the bound window, read off the main actor,
    /// and kept only if the window is still the same one afterwards.
    private func readText(_ observation: Observation, generation: Int) async {
        inputsMayHaveChanged()
        guard machine.isRecording, generation == machine.generation else { return }
        guard let window = freshWindow(for: observation) else {
            noteSkipped(observation, "its window couldn't be identified, or it is never watched")
            return send(.failed(generation: generation, at: services.clock()))
        }
        let step = BacktrackStopwatch()
        let result = await services.windowText.visibleText(pid: observation.pid, window: window, budget: Self.windowTextBudget)
        guard !Task.isCancelled else { return }
        inputsMayHaveChanged()
        guard machine.isRecording, generation == machine.generation else { return }
        guard freshWindow(for: observation) == window else {
            noteSkipped(observation, "its window changed while its text was read")
            return send(.failed(generation: generation, at: services.clock()))
        }
        let address = services.addresses.address(pid: observation.pid, window: window, bundleId: observation.bundleId)
        let trigger = self.trigger
        let verdict = WindowTextPolicy.verdict(result, address: address)
        send(.textRead(generation: generation, result: result, address: address, at: services.clock()))
        metrics.text(trigger: trigger, app: observation.bundleId, step, result: result, verdict: verdict)
        if verdict == .use { self.trigger = "changed" }
    }

    private func checkThumbnail(_ observation: Observation, generation: Int) async {
        inputsMayHaveChanged()
        guard machine.isRecording, generation == machine.generation else { return }
        guard let window = freshWindow(for: observation) else {
            noteSkipped(observation, "its window couldn't be identified, or it is never watched")
            return send(.failed(generation: generation, at: services.clock()))
        }
        let step = BacktrackStopwatch()
        do {
            let image = try await services.capture.capture(
                window, pid: observation.pid, maxDimension: Self.thumbnailMaxDimension
            )
            guard !Task.isCancelled else { return }
            inputsMayHaveChanged()
            guard machine.isRecording, generation == machine.generation else { return }
            let key = DedupeKey(bundleId: observation.bundleId, frame: window.frame)
            let changed = services.thumbnails.changed(key, thumbnail: image, at: services.clock())
            metrics.thumbnail(trigger: trigger, step, distance: metrics.distance(key, image: image), changed: changed)
            if !changed { trigger = "changed" }
            send(.thumbnailChecked(generation: generation, changed: changed, at: services.clock()))
        } catch {
            guard !Task.isCancelled else { return }
            noteSkipped(observation, Self.describe(error))
            send(.failed(generation: generation, at: services.clock()))
        }
    }

    /// Plan §4.3 step 1: secure fields located before and after the picture and required
    /// identical, the picture bound to the fresh window, the fields painted black, the address read
    /// from that same window.
    private func capture(_ observation: Observation, generation: Int) async {
        inputsMayHaveChanged()
        guard machine.isRecording, generation == machine.generation else { return }
        let step = BacktrackStopwatch()
        let failed = { [weak self] in
            guard let self, !Task.isCancelled else { return }
            self.metrics.skipped("capture")
            self.send(.failed(generation: generation, at: self.services.clock()))
        }
        guard let window = freshWindow(for: observation) else {
            noteSkipped(observation, "its window couldn't be identified, or it is never watched")
            return failed()
        }
        let located = services.clock()
        guard let before = locateSecureFields(observation, window: window) else {
            // Plan Q1: what each app allows is recorded from these lines during the live proof.
            noteSkipped(observation, "its password fields couldn't all be found in 50 ms, twice")
            return failed()
        }
        let locateMilliseconds = Int(services.clock().timeIntervalSince(located) * 1000)
        let image: CGImage
        do {
            image = try await services.capture.capture(
                window, pid: observation.pid, maxDimension: Self.captureMaxDimension
            )
        } catch {
            if !Task.isCancelled { noteSkipped(observation, Self.describe(error)) }
            return failed()
        }
        guard !Task.isCancelled else { return }
        inputsMayHaveChanged()
        guard machine.isRecording, generation == machine.generation else { return }
        let distance = metrics.distance(DedupeKey(bundleId: observation.bundleId, frame: window.frame), image: image)
        guard let after = locateSecureFields(observation, window: window), after == before else {
            noteSkipped(observation, "a password field moved or appeared during the picture")
            return failed()
        }
        guard let masked = SecureFieldMask.apply(before, to: image, windowFrame: window.frame) else {
            noteSkipped(observation, "the password fields couldn't be painted over")
            return failed()
        }
        let address = services.addresses.address(pid: observation.pid, window: window, bundleId: observation.bundleId)
        // Plan Q1/Q2, per app, for the live proof. The app name only; no title, no text.
        focusDebug(
            "Backtrack: \(observation.appName) · \(before.count) password field(s) masked (\(locateMilliseconds) ms) · "
                + (address == nil ? "no address exposed" : "address read")
        )
        metrics.capture(trigger: trigger, step, distance: distance)
        held = (generation, masked, address, DedupeKey(bundleId: observation.bundleId, frame: window.frame))
        send(.captured(generation: generation, at: services.clock()))
    }

    private func recognize(generation: Int) async {
        inputsMayHaveChanged()
        guard machine.isRecording, generation == machine.generation else { return }
        guard let held, held.generation == generation else { return }
        self.held = nil
        let trigger = self.trigger
        let step = BacktrackStopwatch()
        do {
            let lines = try await services.recognizer.recognize(held.image)
            guard !Task.isCancelled else { return }
            inputsMayHaveChanged()
            guard machine.isRecording, generation == machine.generation else { return }
            services.thumbnails.recognized(held.key, thumbnail: held.image, at: services.clock())
            metrics.emittedLines = nil
            send(.recognized(generation: generation, lines: lines, address: held.address, at: services.clock()))
            metrics.recognition(trigger: trigger, app: held.key.bundleId, step, lines: lines.count)
            self.trigger = "changed"
        } catch {
            metrics.skipped("ocr")
            guard !Task.isCancelled else { return }
            focusDebug("Backtrack: skipped — the text couldn't be recognised")
            send(.failed(generation: generation, at: services.clock()))
        }
    }
}
