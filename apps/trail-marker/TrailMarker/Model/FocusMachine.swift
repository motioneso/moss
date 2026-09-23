import Foundation

enum FocusWatchState: Equatable {
    /// The person has not turned Focus on.
    case off
    /// Focus is on and connected, but no Moss calendar block covers now.
    case noBlock
    case watching(blockId: String, title: String, endsAt: Date)
    case paused
    /// Moss can't be reached (or the last judgment failed); the next scheduled try runs by itself.
    case unreachable
    /// Focus module is off for this person, or no judgment model is bound in Moss.
    case notReady
}

enum FocusEvent: Equatable {
    case launched(consent: Bool, paused: Bool)
    case connectionChanged(isConnected: Bool)
    case userToggleConsent(Bool)
    case userPause
    case userResume
    case userJudgeNow
    case userTestNudge
    case contextLoaded(FocusContext, generation: Int)
    case contextFailed(CompanionError, generation: Int)
    case appChanged(Observation?)
    case sampleTimerFired(generation: Int)
    /// A window has stayed in front for the dwell time. `change` names which app change started
    /// the wait, so only the newest one counts.
    case dwellTimerFired(generation: Int, change: Int)
    case contextTimerFired(generation: Int)
    case judged(FocusJudgment, generation: Int)
    case judgeFailed(CompanionError, generation: Int)
    case wake
    case accessibilityChanged(granted: Bool)
    /// The person changed the app allowlist in the Focus settings.
    case policyChanged(ObservationPolicy)
}

enum FocusEffect: Equatable {
    case fetchContext(generation: Int)
    case scheduleContext(after: TimeInterval, generation: Int)
    case sendObservation(Observation, blockId: String, generation: Int)
    case scheduleSample(after: TimeInterval, generation: Int)
    /// Judge this change if the window is still in front after the dwell time.
    case scheduleDwell(after: TimeInterval, generation: Int, change: Int)
    case cancelAll
    case persistPaused(Bool)
    case persistConsent(Bool)
    case requestNotificationPermission
    case showNudge(title: String)
    case showTestNudge
    /// Kept in memory only, so the Last judgment panel can show it. Never written to disk.
    case rememberJudgment(FocusJudgment)
}

/// Pure `(state, event) -> (state, [effect])`, in the same style as `ConnectionMachine`, so
/// "Pause really stops requests" can be tested without a network. Anything that can send is
/// gated on being *active* (consent on, not paused, connected to Moss); every timer and reply
/// carries the generation it was started under, and a change of activity bumps the generation so
/// old ones are ignored.
struct FocusMachine {
    static let contextInterval: TimeInterval = 60
    static let sampleInterval: TimeInterval = 300
    /// A window must stay in front this long before it is judged, so glances and cmd-tab passes
    /// are never sent and a real switch is judged within seconds (Ben, 2026-09-22; replaces a
    /// 30-second spacing after each send).
    static let dwell: TimeInterval = 5

    private(set) var state: FocusWatchState = .off
    private(set) var generation = 0
    private(set) var policy: ObservationPolicy

    private var consent = false
    private var paused = false
    private var connected = false
    private var accessibilityGranted = false
    private var currentApp: Observation?
    private var block: (id: String, title: String, endsAt: Date)?
    private var judgmentReady = false
    private var contextLoadedOnce = false
    private var failed = false
    /// What was last sent, so returning to the same window after a glance is not judged again.
    private var lastSent: Observation?
    /// Counts app changes; a dwell timer from an older change is ignored.
    private var changeCount = 0
    private var sampledBlockId: String?
    private var sampleChainGeneration: Int?
    private var requestedNotificationPermission = false

    init(policy: ObservationPolicy = ObservationPolicy(allowedBundleIds: [])) {
        self.policy = policy
    }

    private var isActive: Bool { consent && !paused && connected }

    mutating func handle(_ event: FocusEvent, now: Date) -> [FocusEffect] {
        var effects: [FocusEffect] = []

        switch event {
        case .launched(let consent, let paused):
            self.consent = consent
            self.paused = paused

        case .connectionChanged(let isConnected):
            let wasActive = isActive
            connected = isConnected
            effects += activityChanged(wasActive: wasActive)

        case .userToggleConsent(let value):
            let wasActive = isActive
            consent = value
            effects.append(.persistConsent(value))
            if value, !requestedNotificationPermission {
                requestedNotificationPermission = true
                effects.append(.requestNotificationPermission)
            }
            effects += activityChanged(wasActive: wasActive)

        case .userPause:
            guard consent, !paused else { return [] }
            let wasActive = isActive
            paused = true
            if wasActive { bumpGeneration() }
            effects = [.persistPaused(true), .cancelAll]

        case .userResume:
            guard paused else { return [] }
            paused = false
            effects.append(.persistPaused(false))
            if isActive {
                bumpGeneration()
                effects.append(.fetchContext(generation: generation))
            }

        case .userJudgeNow:
            if let app = currentApp, let block, canObserve(app, now: now) {
                lastSent = app
                effects.append(.sendObservation(app, blockId: block.id, generation: generation))
            }

        case .userTestNudge:
            effects.append(.showTestNudge)

        case .contextLoaded(let context, let eventGeneration):
            guard eventGeneration == generation, isActive else { return [] }
            judgmentReady = context.judgmentReady
            block = context.block.flatMap { loaded in
                ServerTime.parse(loaded.endsAt).map { (id: loaded.id, title: loaded.title, endsAt: $0) }
            }
            contextLoadedOnce = true
            failed = false
            effects.append(.scheduleContext(after: Self.contextInterval, generation: generation))
            if let app = currentApp, let block, block.id != sampledBlockId, canObserve(app, now: now) {
                effects += send(app, block: block, now: now)
            }

        case .contextFailed(_, let eventGeneration):
            guard eventGeneration == generation, isActive else { return [] }
            failed = true
            effects.append(.scheduleContext(after: Self.contextInterval, generation: generation))

        case .appChanged(let observation):
            guard let observation else { return [] }
            currentApp = observation
            changeCount += 1
            guard isActive, block != nil, canObserve(observation, now: now),
                !observation.isSameWindow(as: lastSent)
            else { break }
            effects.append(.scheduleDwell(after: Self.dwell, generation: generation, change: changeCount))

        case .dwellTimerFired(let eventGeneration, let change):
            guard eventGeneration == generation, isActive, change == changeCount else { return [] }
            guard let app = currentApp, let block, canObserve(app, now: now),
                !app.isSameWindow(as: lastSent)
            else { break }
            effects += send(app, block: block, now: now)

        case .sampleTimerFired(let eventGeneration):
            guard eventGeneration == generation, isActive else { return [] }
            guard let block, blockIsCurrent(now) else {
                sampleChainGeneration = nil
                break
            }
            if let app = currentApp, canObserve(app, now: now) {
                lastSent = app
                effects.append(.sendObservation(app, blockId: block.id, generation: generation))
            }
            effects.append(.scheduleSample(after: Self.sampleInterval, generation: generation))

        case .contextTimerFired(let eventGeneration):
            guard eventGeneration == generation, isActive else { return [] }
            effects.append(.fetchContext(generation: generation))

        case .judged(let judgment, let eventGeneration):
            guard eventGeneration == generation, isActive else { return [] }
            failed = false
            effects.append(.rememberJudgment(judgment))
            if judgment.nudge, let block {
                effects.append(.showNudge(title: block.title))
            }

        case .judgeFailed(let error, let eventGeneration):
            guard eventGeneration == generation, isActive else { return [] }
            switch error {
            case .focusNotReady:
                judgmentReady = false
                contextLoadedOnce = true
            case .noBlock:
                effects.append(.fetchContext(generation: generation))
            default:
                // Not retried here: the next scheduled sample tries again, so a struggling
                // server sees one request per interval, never a burst.
                failed = true
            }

        case .wake:
            if isActive { effects.append(.fetchContext(generation: generation)) }

        case .accessibilityChanged(let granted):
            accessibilityGranted = granted

        case .policyChanged(let newPolicy):
            policy = newPolicy
        }

        refreshState(now: now)
        return effects
    }

    // MARK: - Helpers

    private mutating func bumpGeneration() {
        generation += 1
        contextLoadedOnce = false
        failed = false
        block = nil
        sampledBlockId = nil
        sampleChainGeneration = nil
        lastSent = nil
    }

    /// Called after a change that may have moved the machine into or out of being active.
    private mutating func activityChanged(wasActive: Bool) -> [FocusEffect] {
        if isActive, !wasActive {
            bumpGeneration()
            return [.fetchContext(generation: generation)]
        }
        if wasActive, !isActive {
            bumpGeneration()
            return [.cancelAll]
        }
        return []
    }

    private func blockIsCurrent(_ now: Date) -> Bool {
        guard let block else { return false }
        return block.endsAt > now
    }

    /// Everything that must be true before the app in front may be reported.
    private func canObserve(_ app: Observation, now: Date) -> Bool {
        isActive && judgmentReady && accessibilityGranted && blockIsCurrent(now) && policy.allows(app)
    }

    private mutating func send(
        _ app: Observation, block: (id: String, title: String, endsAt: Date), now: Date
    ) -> [FocusEffect] {
        lastSent = app
        sampledBlockId = block.id
        var effects: [FocusEffect] = [.sendObservation(app, blockId: block.id, generation: generation)]
        if sampleChainGeneration != generation {
            sampleChainGeneration = generation
            effects.append(.scheduleSample(after: Self.sampleInterval, generation: generation))
        }
        return effects
    }

    private mutating func refreshState(now: Date) {
        if !consent {
            state = .off
        } else if paused {
            state = .paused
        } else if !connected || failed {
            state = .unreachable
        } else if contextLoadedOnce && !judgmentReady {
            state = .notReady
        } else if let block, blockIsCurrent(now) {
            state = .watching(blockId: block.id, title: block.title, endsAt: block.endsAt)
        } else {
            state = .noBlock
        }
    }
}
