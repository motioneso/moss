import CoreGraphics
import Foundation

// Backtrack (spec docs/superpowers/specs/2026-09-23-trail-marker-screen-history.md, plan
// docs/superpowers/plans/2026-09-23-backtrack.md §4; phase 2 plan 2026-10-03-backtrack-phase2.md).
// The machine decides; `BacktrackRuntime` only does. It never reads the clock: every time arrives
// on an event.

/// How often a recognition may start. One global deadline (plan §4.2, round 2 B6): no
/// recognition starts less than `minGap` after the previous one, from any trigger.
enum BacktrackBudget: Equatable {
    case normal
    /// Thermal pressure or Low Power Mode.
    case reduced

    var minGap: TimeInterval { self == .normal ? 10 : 60 }
}

/// Everything outside the window in front that decides whether Backtrack may record.
struct BacktrackInputs: Equatable {
    var enabled = false
    /// The stored consent is at least the version the sink requires (plan §6, native part 2b).
    var consentAccepted = false
    var menuSwitchOn = true
    var pausedAll = false
    var screenLocked = false
    var sleeping = false
    var idle = false
    var linked = false
    var accessibilityGranted = false
    var screenRecordingGranted = false
    /// The sink can take text now (phase 2: Moss stores Backtrack and it isn't paused there).
    var sinkReady = true
    var budget: BacktrackBudget = .normal
    /// Backtrack reads whatever is in front, minus the Never watch list shared with Focus.
    var policy = ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true)

    var permitsRecording: Bool {
        enabled && consentAccepted && menuSwitchOn && !pausedAll && !screenLocked && !sleeping && !idle && linked
            && sinkReady && accessibilityGranted && screenRecordingGranted
    }
}

enum BacktrackEvent: Equatable {
    /// The initial snapshot. Nothing happens before it.
    case started(BacktrackInputs, at: Date)
    case inputsChanged(BacktrackInputs, at: Date)
    /// Nil means no frontmost window (or only Trail Marker's own).
    case frontmostChanged(Observation?, at: Date)
    /// `typingRecently`: a key went down within `BacktrackMachine.typingQuiet`.
    case tick(generation: Int, at: Date, typingRecently: Bool = false)
    /// Accessibility text of the window (nil: none could be read) and the raw address.
    case textRead(generation: Int, result: WindowTextResult?, address: String?, at: Date)
    case thumbnailChecked(generation: Int, changed: Bool, at: Date)
    /// Pixels are in the runtime's hands, secure fields masked, before recognition.
    case captured(generation: Int, at: Date)
    /// Raw recognised lines and the raw address. The machine sanitises them before anything else.
    case recognized(generation: Int, lines: [String], address: String?, at: Date)
    case failed(generation: Int, at: Date)
}

enum BacktrackEffect: Equatable {
    /// Replaces any pending timer; it fires `tick(generation:at:)`.
    case schedule(after: TimeInterval, generation: Int)
    /// Read the window's visible text through Accessibility (plan §7, retry 2, task 3).
    case readText(Observation, generation: Int)
    case checkThumbnail(Observation, generation: Int)
    /// Capture by window identity (plan §3.1), fresh AX read, secure fields masked.
    case capture(Observation, generation: Int)
    /// The runtime holds the pixels, never the machine.
    case recognize(generation: Int)
    /// Drop held pixels and cancel in-flight tasks.
    case cancelInFlight
    /// The only way data leaves the machine: straight to `BacktrackSink.accept`.
    case emit(BacktrackSegment)
    /// Forget dedupe state and whatever the sink holds.
    case discardAll
}

/// One stretch of new text from one window. Every field has been through `BacktrackSanitizer`
/// by the time a segment exists: it is built only inside `BacktrackMachine`, which sanitises
/// first.
struct BacktrackSegment: Equatable {
    let appName: String
    let bundleId: String
    let windowTitle: String
    let address: String?
    let lines: [String]
    let start: Date
    let end: Date
}

/// Which window a set of lines belongs to, for dedupe. The app and the frame, not the title: a
/// title with a live unread count changes every few minutes and would resend the whole page.
struct DedupeKey: Hashable {
    let bundleId: String
    let x: Int, y: Int, width: Int, height: Int

    init(bundleId: String, frame: CGRect) {
        self.bundleId = bundleId
        x = Int(frame.minX.rounded())
        y = Int(frame.minY.rounded())
        width = Int(frame.width.rounded())
        height = Int(frame.height.rounded())
    }
}

/// Keeps the previous capture's lines for each window and returns only the ones that are new, so
/// scrolling a page adds lines instead of resending it. Bounded, so it never grows with the day.
struct SegmentDeduper: Equatable {
    static let maxWindows = 32
    private var last: [DedupeKey: Set<String>] = [:]
    private var order: [DedupeKey] = []

    mutating func newLines(for key: DedupeKey, lines: [String]) -> [String] {
        let previous = last[key] ?? []
        var seen = Set<String>()
        let fresh = lines.filter { !previous.contains($0) && seen.insert($0).inserted }
        last[key] = Set(lines)
        order.removeAll { $0 == key }
        order.append(key)
        if order.count > Self.maxWindows {
            last[order.removeFirst()] = nil
        }
        return fresh
    }

    mutating func reset() {
        last = [:]
        order = []
    }
}

/// How long a window waits between periodic reads. A read that finds nothing new doubles it, up to
/// `BacktrackMachine.maxWindowGap`; one that finds something resets it (plan §7, retry 2, task 2).
/// Bounded, like the deduper.
struct WindowBackoff: Equatable {
    static let maxWindows = 32
    private var gaps: [DedupeKey: TimeInterval] = [:]
    private var order: [DedupeKey] = []

    func gap(for key: DedupeKey) -> TimeInterval? { gaps[key] }

    mutating func record(_ key: DedupeKey, foundNew: Bool, base: TimeInterval) {
        order.removeAll { $0 == key }
        guard !foundNew else {
            gaps[key] = nil
            return
        }
        gaps[key] = min(max(gaps[key] ?? base, base) * 2, BacktrackMachine.maxWindowGap)
        order.append(key)
        if order.count > Self.maxWindows {
            gaps[order.removeFirst()] = nil
        }
    }

    mutating func reset() {
        gaps = [:]
        order = []
    }
}

struct BacktrackMachine {
    /// A switch waits this long for the person to settle before its window is read, so a burst of
    /// switches reads only where they ended up (plan §4.5 budget test).
    static let switchSettle: TimeInterval = 1
    /// A segment is emitted only for a material change (plan §4.2).
    static let minNewLines = 3
    static let minNewCharacters = 80
    /// A window whose reads keep finding nothing new is read at most this often (plan §7, retry 2).
    static let maxWindowGap: TimeInterval = 60
    /// Periodic reads wait until the keyboard has been quiet this long, re-checking at this pace...
    static let typingQuiet: TimeInterval = 2
    /// ...but never longer than this in total, so long typing is still read.
    static let maxTypingDeferral: TimeInterval = 30

    private enum Stage: Equatable { case readingText, checking, capturing, recognizing }

    private struct Chain: Equatable {
        let observation: Observation
        var start: Date
        var stage: Stage
    }

    private(set) var generation = 0
    private var started = false
    private var inputs = BacktrackInputs()
    private var frontmost: Observation?
    private var chain: Chain?
    private var lastRecognitionStart: Date?
    private var deduper = SegmentDeduper()
    private var backoff = WindowBackoff()
    private var accessibilityCost = AccessibilityCostTracker()
    /// The pending tick was scheduled by a switch: it is never deferred for typing.
    private var switchPending = false
    private var typingSince: Date?

    /// Drives the menu-bar dot.
    var isRecording: Bool {
        guard started, inputs.permitsRecording, let frontmost else { return false }
        return inputs.policy.allowsCapture(frontmost)
    }

    mutating func handle(_ event: BacktrackEvent) -> [BacktrackEffect] {
        switch event {
        case .started(let initial, let at):
            guard !started else { return [] }
            started = true
            inputs = initial
            return bump() + planSwitch(at: at)

        case .inputsChanged(let new, let at):
            guard started else { return [] }
            let old = inputs
            inputs = new
            var effects = bump()
            if (old.enabled && !new.enabled) || (old.consentAccepted && !new.consentAccepted)
                || (old.linked && !new.linked) {
                deduper.reset()
                backoff.reset()
                effects.append(.discardAll)
            }
            return effects + planSwitch(at: at)

        case .frontmostChanged(let observation, let at):
            frontmost = observation
            guard started else { return [] }
            return bump() + planSwitch(at: at)

        case .tick(let eventGeneration, let at, let typingRecently):
            guard started, eventGeneration == generation, chain == nil, isRecording, let observation = frontmost
            else { return [] }
            let gap = inputs.budget.minGap
            if let last = lastRecognitionStart, at < last.addingTimeInterval(gap) {
                // A budget change or an early timer: never start before the global deadline.
                return [.schedule(after: last.addingTimeInterval(gap).timeIntervalSince(at), generation: generation)]
            }
            if typingRecently, !switchPending {
                let since = typingSince ?? at
                typingSince = since
                if at.timeIntervalSince(since) < Self.maxTypingDeferral {
                    return [.schedule(after: Self.typingQuiet, generation: generation)]
                }
            }
            typingSince = nil
            switchPending = false
            if WindowTextPolicy.skipsAccessibility(bundleId: observation.bundleId)
                || accessibilityCost.skips(observation.bundleId, at: at) {
                // Switches and periodic checks use the same gate, including returns to a read screen.
                chain = Chain(observation: observation, start: at, stage: .checking)
                return [.checkThumbnail(observation, generation: generation)]
            }
            chain = Chain(observation: observation, start: at, stage: .readingText)
            return [.readText(observation, generation: generation)]

        case .textRead(let eventGeneration, let result, let rawAddress, let at):
            guard eventGeneration == generation, let current = chain, current.stage == .readingText, isRecording
            else { return [] }
            if let result {
                accessibilityCost.record(
                    current.observation.bundleId, milliseconds: result.walkMilliseconds, truncated: result.truncated, at: at
                )
            }
            guard let result, WindowTextPolicy.verdict(result, address: rawAddress) == .use else {
                // Too little: the picture decides, through the same gate as before.
                chain?.stage = .checking
                return [.checkThumbnail(current.observation, generation: generation)]
            }
            lastRecognitionStart = current.start
            chain = nil
            return finish(current, rawLines: result.lines, rawAddress: rawAddress, at: at)

        case .thumbnailChecked(let eventGeneration, let changed, let at):
            guard eventGeneration == generation, let current = chain, current.stage == .checking, isRecording
            else { return [] }
            guard changed else {
                chain = nil
                return [.schedule(after: inputs.budget.minGap, generation: generation)]
            }
            return startCapture(current.observation, at: at)

        case .captured(let eventGeneration, _):
            // Revalidation (plan §4.2): the generation must be current AND recording still true.
            guard eventGeneration == generation, chain?.stage == .capturing, isRecording else { return [] }
            chain?.stage = .recognizing
            return [.recognize(generation: generation)]

        case .recognized(let eventGeneration, let rawLines, let rawAddress, let at):
            guard eventGeneration == generation, let current = chain, current.stage == .recognizing, isRecording
            else { return [] }
            chain = nil
            return finish(current, rawLines: rawLines, rawAddress: rawAddress, at: at)

        case .failed(let eventGeneration, _):
            guard eventGeneration == generation, chain != nil else { return [] }
            chain = nil
            return isRecording ? [.schedule(after: inputs.budget.minGap, generation: generation)] : []
        }
    }

    /// Raw lines from either source: sanitised, deduped, emitted if material, and the window's
    /// backoff updated.
    private mutating func finish(_ current: Chain, rawLines: [String], rawAddress: String?, at: Date) -> [BacktrackEffect] {
        var effects: [BacktrackEffect] = []
        let observation = current.observation
        let key = DedupeKey(bundleId: observation.bundleId, frame: observation.window?.frame ?? .zero)
        let fresh = deduper.newLines(for: key, lines: BacktrackSanitizer.lines(rawLines))
        let foundNew = fresh.count >= Self.minNewLines || fresh.reduce(0, { $0 + $1.count }) >= Self.minNewCharacters
        backoff.record(key, foundNew: foundNew, base: inputs.budget.minGap)
        if foundNew {
            effects.append(.emit(BacktrackSegment(
                appName: BacktrackSanitizer.title(observation.appName),
                bundleId: observation.bundleId,
                windowTitle: BacktrackSanitizer.title(observation.windowTitle),
                address: rawAddress.flatMap(BacktrackSanitizer.address),
                lines: fresh,
                start: current.start,
                end: at
            )))
        }
        var next = max(inputs.budget.minGap, backoff.gap(for: key) ?? 0)
        if WindowTextPolicy.ocrOnlyBundles.contains(observation.bundleId) {
            next = max(next, WindowTextPolicy.ocrOnlyFloor)
        }
        effects.append(.schedule(after: next, generation: generation))
        return effects
    }

    /// Every change of input or window: a new generation, and whatever was in flight is dropped.
    private mutating func bump() -> [BacktrackEffect] {
        generation += 1
        guard chain != nil else { return [] }
        chain = nil
        return [.cancelInFlight]
    }

    /// A coalesced read of the window now in front, at the global deadline, after the settle delay.
    private mutating func planSwitch(at: Date) -> [BacktrackEffect] {
        guard isRecording else { return [] }
        switchPending = true
        typingSince = nil
        var delay = Self.switchSettle
        if let last = lastRecognitionStart {
            delay = max(delay, last.addingTimeInterval(inputs.budget.minGap).timeIntervalSince(at))
        }
        return [.schedule(after: delay, generation: generation)]
    }

    private mutating func startCapture(_ observation: Observation, at: Date) -> [BacktrackEffect] {
        lastRecognitionStart = at
        chain = Chain(observation: observation, start: at, stage: .capturing)
        return [.capture(observation, generation: generation)]
    }
}
