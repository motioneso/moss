#if DEBUG
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

    static func live() -> BacktrackServices {
        BacktrackServices(
            capture: ScreenCaptureKitCapture(),
            secureFields: AXSecureFieldLocator(),
            addresses: AXBrowserAddressReader(),
            recognizer: VisionTextRecognizer(),
            thumbnails: ThumbnailChangeDetector(),
            freshWindowIdentity: { WorkspaceFrontmostSource.focusedWindowIdentity(pid: $0) },
            clock: Date.init,
            scheduler: RunLoopScheduler()
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
/// disk, and a source check enforces that for every file in this folder.
@MainActor
final class BacktrackRuntime: ObservableObject {
    /// The version this build's consent sheet records. Phase 1: in memory on this Mac.
    static let consentVersion = 1
    /// Secure fields must be found within this, or the capture is skipped (plan §4.3).
    static let secureFieldBudget: TimeInterval = 0.05
    /// Recognition wants more pixels than a vision description does, for small text.
    static let captureMaxDimension: CGFloat = 2048
    static let thumbnailMaxDimension: CGFloat = 32

    @Published private(set) var isRecording = false
    @Published private(set) var enabled: Bool
    @Published private(set) var consentGiven: Int
    @Published private(set) var menuSwitchOn: Bool
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
    private var tasks: [Task<Void, Never>] = []
    /// Masked pixels and the address for the chain in flight, never kept past it.
    private var held: (generation: Int, image: CGImage, address: String?)?
    private var cancellables = Set<AnyCancellable>()
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var didStart = false

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
    }

    // MARK: - Lifecycle

    func start() {
        guard !didStart else { return }
        didStart = true
        inputs = currentInputs()
        apply(machine.handle(.started(inputs, at: services.clock())))
        observer.start { [weak self] observation in
            guard let self else { return }
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
            linked: connection.identity != nil,
            accessibilityGranted: permissions.accessibility == .granted,
            screenRecordingGranted: permissions.screenRecording == .granted,
            budget: thermal == .serious || thermal == .critical || ProcessInfo.processInfo.isLowPowerModeEnabled
                ? .reduced : .normal,
            policy: policy
        )
    }

    func inputsMayHaveChanged() {
        guard didStart else { return }
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
        apply(machine.handle(event))
    }

    private func apply(_ effects: [BacktrackEffect]) {
        for effect in effects {
            switch effect {
            case .schedule(let delay, let generation):
                timer?.cancel()
                timer = services.scheduler.schedule(after: delay) { [weak self] in
                    guard let self else { return }
                    self.send(.tick(generation: generation, at: self.services.clock()))
                }
            case .checkThumbnail(let observation, let generation):
                run { [weak self] in await self?.checkThumbnail(observation, generation: generation) }
            case .capture(let observation, let generation):
                run { [weak self] in await self?.capture(observation, generation: generation) }
            case .recognize(let generation):
                run { [weak self] in await self?.recognize(generation: generation) }
            case .cancelInFlight:
                for task in tasks { task.cancel() }
                tasks = []
                held = nil
            case .emit(let segment):
                sink.accept(segment)
            case .discardAll:
                held = nil
                services.thumbnails.reset()
                sink.discardAll()
            }
        }
        publish()
    }

    private func run(_ work: @escaping @MainActor () async -> Void) {
        tasks.append(Task { @MainActor in await work() })
    }

    private func publish() {
        isRecording = machine.isRecording
        menuState.showsRecordingDot = machine.isRecording
        menuState.row = enabled && consentGiven >= sink.requiredConsentVersion
            ? FeatureSwitchState.Row(title: "Backtrack", isOn: menuSwitchOn)
            : nil
    }

    /// The window as it is now, re-checked against the policy on its current title.
    private func freshWindow(for observation: Observation) -> WindowIdentity? {
        let fresh = observation.refreshed(window: services.freshWindowIdentity(observation.pid))
        guard inputs.policy.allowsCapture(fresh) else { return nil }
        return fresh.window
    }

    private func checkThumbnail(_ observation: Observation, generation: Int) async {
        guard let window = freshWindow(for: observation) else {
            return send(.failed(generation: generation, at: services.clock()))
        }
        do {
            let image = try await services.capture.capture(
                window, pid: observation.pid, maxDimension: Self.thumbnailMaxDimension
            )
            guard !Task.isCancelled else { return }
            let changed = services.thumbnails.changed(
                DedupeKey(bundleId: observation.bundleId, frame: window.frame), thumbnail: image
            )
            send(.thumbnailChecked(generation: generation, changed: changed, at: services.clock()))
        } catch {
            guard !Task.isCancelled else { return }
            send(.failed(generation: generation, at: services.clock()))
        }
    }

    /// Plan §4.3 step 1: secure fields located before and after the picture and required
    /// identical, the picture bound to the fresh window, the fields painted black, the address read
    /// from that same window.
    private func capture(_ observation: Observation, generation: Int) async {
        let failed = { [weak self] in
            guard let self, !Task.isCancelled else { return }
            self.send(.failed(generation: generation, at: self.services.clock()))
        }
        guard let window = freshWindow(for: observation),
              let before = services.secureFields.secureFieldFrames(
                  pid: observation.pid, window: window, budget: Self.secureFieldBudget
              )
        else { return failed() }
        let image: CGImage
        do {
            image = try await services.capture.capture(
                window, pid: observation.pid, maxDimension: Self.captureMaxDimension
            )
        } catch {
            return failed()
        }
        guard !Task.isCancelled else { return }
        guard let after = services.secureFields.secureFieldFrames(
            pid: observation.pid, window: window, budget: Self.secureFieldBudget
        ), after == before,
            let masked = SecureFieldMask.apply(before, to: image, windowFrame: window.frame)
        else { return failed() }
        let address = services.addresses.address(pid: observation.pid, window: window, bundleId: observation.bundleId)
        held = (generation, masked, address)
        send(.captured(generation: generation, at: services.clock()))
    }

    private func recognize(generation: Int) async {
        guard let held, held.generation == generation else { return }
        self.held = nil
        do {
            let lines = try await services.recognizer.recognize(held.image)
            guard !Task.isCancelled else { return }
            send(.recognized(generation: generation, lines: lines, address: held.address, at: services.clock()))
        } catch {
            guard !Task.isCancelled else { return }
            send(.failed(generation: generation, at: services.clock()))
        }
    }
}
#endif
