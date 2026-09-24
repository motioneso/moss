#if DEBUG
import XCTest
@testable import TrailMarker

/// Backtrack plan §4.2 and §4.5: the pure machine's rules. Every test drives explicit times; the
/// machine never reads the clock.
final class BacktrackMachineTests: XCTestCase {
    static let t0 = Date(timeIntervalSince1970: 1_000_000)
    static func t(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    static var allOn: BacktrackInputs {
        BacktrackInputs(
            enabled: true, consentAccepted: true, menuSwitchOn: true, pausedAll: false, screenLocked: false,
            sleeping: false, linked: true, accessibilityGranted: true, screenRecordingGranted: true,
            budget: .normal, policy: ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true)
        )
    }

    static func window(_ title: String, x: CGFloat = 0) -> Observation {
        Observation(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: title, pid: 42,
            window: WindowIdentity(frame: CGRect(x: x, y: 0, width: 800, height: 600), title: title)
        )
    }

    static let docs = window("Docs")
    static let lines = ["The quarterly plan", "Ship the companion", "Measure the battery"]

    /// Started, Docs in front, and the switch-triggered chain run to the point of `capture`.
    private func startedAtCapture(_ inputs: BacktrackInputs = allOn) -> BacktrackMachine {
        var machine = BacktrackMachine()
        _ = machine.handle(.started(inputs, at: Self.t0))
        _ = machine.handle(.frontmostChanged(Self.docs, at: Self.t0))
        let effects = machine.handle(.tick(generation: machine.generation, at: Self.t(1)))
        XCTAssertEqual(effects, [.capture(Self.docs, generation: machine.generation)])
        return machine
    }

    private func emits(_ effects: [BacktrackEffect]) -> [BacktrackSegment] {
        effects.compactMap { if case .emit(let segment) = $0 { return segment } else { return nil } }
    }

    private func schedules(_ effects: [BacktrackEffect]) -> Bool {
        effects.contains { if case .schedule = $0 { return true } else { return false } }
    }

    // MARK: - The chain

    func testAFullChainEmitsASanitisedSegment() {
        var machine = BacktrackMachine()
        _ = machine.handle(.started(Self.allOn, at: Self.t0))
        let secret = Observation(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Keys sk-proj-abcdefghijklmnop", pid: 42,
            window: WindowIdentity(frame: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Keys sk-proj-abcdefghijklmnop")
        )
        XCTAssertEqual(
            machine.handle(.frontmostChanged(secret, at: Self.t0)),
            [.schedule(after: BacktrackMachine.switchSettle, generation: machine.generation)]
        )
        let generation = machine.generation
        XCTAssertEqual(machine.handle(.tick(generation: generation, at: Self.t(1))), [.capture(secret, generation: generation)])
        XCTAssertEqual(machine.handle(.captured(generation: generation, at: Self.t(1.1))), [.recognize(generation: generation)])
        let effects = machine.handle(.recognized(
            generation: generation, lines: Self.lines + ["token sk-live-0123456789abcdef"],
            address: "https://ben:pw@example.com/a?token=abc#frag", at: Self.t(2)
        ))
        let segment = try? XCTUnwrap(emits(effects).first)
        XCTAssertEqual(segment?.windowTitle, "Keys [redacted]")
        XCTAssertEqual(segment?.address, "https://example.com/a")
        XCTAssertEqual(segment?.lines.last, "token [redacted]")
        XCTAssertEqual(segment?.start, Self.t(1))
        XCTAssertEqual(segment?.end, Self.t(2))
        XCTAssertTrue(schedules(effects), "the next periodic check is scheduled")
    }

    // MARK: - Every stop condition cancels in flight

    private static let stops: [(String, (inout BacktrackInputs) -> Void)] = [
        ("menu switch off", { $0.menuSwitchOn = false }),
        ("Pause All", { $0.pausedAll = true }),
        ("screen locked", { $0.screenLocked = true }),
        ("asleep", { $0.sleeping = true }),
        ("consent revoked", { $0.consentAccepted = false }),
        ("Accessibility revoked", { $0.accessibilityGranted = false }),
        ("Screen Recording revoked", { $0.screenRecordingGranted = false }),
        ("unlinked", { $0.linked = false }),
        ("Backtrack turned off", { $0.enabled = false }),
        ("policy excludes the app", { $0.policy.excludedBundleIds = ["com.apple.Safari"] })
    ]

    func testEveryStopConditionCancelsAChainWaitingForItsPicture() {
        for (name, stop) in Self.stops {
            var machine = startedAtCapture()
            let stale = machine.generation
            var inputs = Self.allOn
            stop(&inputs)
            let effects = machine.handle(.inputsChanged(inputs, at: Self.t(1.05)))
            XCTAssertTrue(effects.contains(.cancelInFlight), "\(name): in-flight work is cancelled")
            XCTAssertFalse(schedules(effects), "\(name): nothing new is scheduled while stopped")
            XCTAssertEqual(machine.handle(.captured(generation: stale, at: Self.t(1.1))), [], name)
            XCTAssertEqual(
                machine.handle(.recognized(generation: stale, lines: Self.lines, address: nil, at: Self.t(2))), [], name
            )
            XCTAssertEqual(machine.handle(.tick(generation: machine.generation, at: Self.t(30))), [], "\(name): no tick")
            XCTAssertFalse(machine.isRecording, name)
        }
    }

    func testEveryStopConditionCancelsAChainWaitingForItsText() {
        for (name, stop) in Self.stops {
            var machine = startedAtCapture()
            let stale = machine.generation
            XCTAssertEqual(machine.handle(.captured(generation: stale, at: Self.t(1.1))), [.recognize(generation: stale)])
            var inputs = Self.allOn
            stop(&inputs)
            let effects = machine.handle(.inputsChanged(inputs, at: Self.t(1.2)))
            XCTAssertTrue(effects.contains(.cancelInFlight), name)
            XCTAssertFalse(schedules(effects), name)
            XCTAssertEqual(
                machine.handle(.recognized(generation: stale, lines: Self.lines, address: nil, at: Self.t(2))), [], name
            )
        }
    }

    func testLogOutConsentWithdrawnOrTurnedOffDiscardsEverything() {
        for (name, stop) in Self.stops where ["consent revoked", "unlinked", "Backtrack turned off"].contains(name) {
            var machine = startedAtCapture()
            var inputs = Self.allOn
            stop(&inputs)
            XCTAssertTrue(machine.handle(.inputsChanged(inputs, at: Self.t(2))).contains(.discardAll), name)
        }
        var machine = startedAtCapture()
        var inputs = Self.allOn
        inputs.pausedAll = true
        XCTAssertFalse(machine.handle(.inputsChanged(inputs, at: Self.t(2))).contains(.discardAll), "a pause keeps state")
    }

    // MARK: - Windows

    func testGoingToAnotherWindowAndBackNeverLetsTheFirstChainEmit() {
        var machine = startedAtCapture()
        let first = machine.generation
        _ = machine.handle(.frontmostChanged(Self.window("Mail", x: 900), at: Self.t(1.2)))
        _ = machine.handle(.frontmostChanged(Self.docs, at: Self.t(1.4)))
        XCTAssertEqual(machine.handle(.captured(generation: first, at: Self.t(1.5))), [])
        XCTAssertEqual(machine.handle(.recognized(generation: first, lines: Self.lines, address: nil, at: Self.t(2))), [])

        // A new chain for the same window starts; the first chain's late events must still not
        // land on it, which only a new generation guarantees.
        let second = machine.handle(.tick(generation: machine.generation, at: Self.t(11)))
        XCTAssertEqual(second, [.capture(Self.docs, generation: machine.generation)])
        XCTAssertNotEqual(machine.generation, first)
        XCTAssertEqual(machine.handle(.captured(generation: first, at: Self.t(11.1))), [])
    }

    func testNoFrontmostWindowRecordsNothing() {
        var machine = BacktrackMachine()
        _ = machine.handle(.started(Self.allOn, at: Self.t0))
        XCTAssertEqual(machine.handle(.frontmostChanged(nil, at: Self.t0)), [])
        XCTAssertEqual(machine.handle(.tick(generation: machine.generation, at: Self.t(5))), [])
        XCTAssertFalse(machine.isRecording)
    }

    func testNothingHappensBeforeStartedOrWithoutConsent() {
        var machine = BacktrackMachine()
        XCTAssertEqual(machine.handle(.frontmostChanged(Self.docs, at: Self.t0)), [])
        XCTAssertEqual(machine.handle(.tick(generation: machine.generation, at: Self.t(5))), [])

        var inputs = Self.allOn
        inputs.consentAccepted = false
        var withoutConsent = BacktrackMachine()
        XCTAssertEqual(withoutConsent.handle(.started(inputs, at: Self.t0)), [])
        XCTAssertEqual(withoutConsent.handle(.frontmostChanged(Self.docs, at: Self.t0)), [])
        XCTAssertFalse(withoutConsent.isRecording)
    }

    func testAPrivateWindowIsNeverRecorded() {
        var machine = BacktrackMachine()
        _ = machine.handle(.started(Self.allOn, at: Self.t0))
        XCTAssertEqual(machine.handle(.frontmostChanged(Self.window("Bank — Private Browsing"), at: Self.t0)), [])
        XCTAssertFalse(machine.isRecording)
    }

    // MARK: - Dedupe and threshold

    func testTheDeduperKeepsOnlyNewLines() {
        var deduper = SegmentDeduper()
        let key = DedupeKey(bundleId: "a", frame: .zero)
        XCTAssertEqual(deduper.newLines(for: key, lines: ["A", "B", "C"]), ["A", "B", "C"])
        XCTAssertEqual(deduper.newLines(for: key, lines: ["B", "C", "D"]), ["D"])
        XCTAssertEqual(deduper.newLines(for: key, lines: ["B", "C", "D"]), [])
        XCTAssertEqual(deduper.newLines(for: DedupeKey(bundleId: "b", frame: .zero), lines: ["B"]), ["B"])
    }

    func testAMaterialChangeEmitsAndASmallOneDoesNot() {
        var machine = startedAtCapture()
        var generation = machine.generation
        _ = machine.handle(.captured(generation: generation, at: Self.t(1.1)))
        XCTAssertEqual(emits(machine.handle(.recognized(generation: generation, lines: Self.lines, address: nil, at: Self.t(2)))).count, 1)

        // The next periodic chain sees one extra short line: below both thresholds.
        _ = machine.handle(.tick(generation: machine.generation, at: Self.t(12)))
        generation = machine.generation
        _ = machine.handle(.thumbnailChecked(generation: generation, changed: true, at: Self.t(12)))
        _ = machine.handle(.captured(generation: generation, at: Self.t(12.1)))
        let small = machine.handle(.recognized(generation: generation, lines: Self.lines + ["Ten chars."], address: nil, at: Self.t(13)))
        XCTAssertEqual(emits(small), [])
    }

    func testAnUnchangedThumbnailReadsNothing() {
        var machine = startedAtCapture()
        let generation = machine.generation
        _ = machine.handle(.captured(generation: generation, at: Self.t(1.1)))
        _ = machine.handle(.recognized(generation: generation, lines: Self.lines, address: nil, at: Self.t(2)))
        XCTAssertEqual(
            machine.handle(.tick(generation: machine.generation, at: Self.t(12))),
            [.checkThumbnail(Self.docs, generation: machine.generation)]
        )
        let effects = machine.handle(.thumbnailChecked(generation: machine.generation, changed: false, at: Self.t(12)))
        XCTAssertFalse(effects.contains { if case .capture = $0 { return true } else { return false } })
    }

    // MARK: - Budget (one global deadline)

    /// A tiny discrete-event run of the machine: effects become future events, one timer at a time.
    private struct Run {
        var machine = BacktrackMachine()
        var queue: [(Date, BacktrackEvent)] = []
        var timer: (Date, Int)?
        var captures: [(Date, Observation)] = []
        let recognitionTakes: TimeInterval
        var serial = 0

        init(inputs: BacktrackInputs, recognitionTakes: TimeInterval) {
            self.recognitionTakes = recognitionTakes
            apply(machine.handle(.started(inputs, at: BacktrackMachineTests.t0)), at: BacktrackMachineTests.t0)
        }

        mutating func apply(_ effects: [BacktrackEffect], at now: Date) {
            for effect in effects {
                switch effect {
                case .schedule(let after, let generation): timer = (now.addingTimeInterval(after), generation)
                case .checkThumbnail(_, let generation):
                    queue.append((now, .thumbnailChecked(generation: generation, changed: true, at: now)))
                case .capture(let observation, let generation):
                    captures.append((now, observation))
                    queue.append((now.addingTimeInterval(0.1), .captured(generation: generation, at: now.addingTimeInterval(0.1))))
                case .recognize(let generation):
                    serial += 1
                    let done = now.addingTimeInterval(recognitionTakes)
                    let fresh = (0..<3).map { "line \(serial)-\($0) with enough words" }
                    queue.append((done, .recognized(generation: generation, lines: fresh, address: nil, at: done)))
                default: break
                }
            }
        }

        mutating func run(until end: Date, inject: [(Date, BacktrackEvent)]) {
            queue += inject
            while true {
                queue.sort { $0.0 < $1.0 }
                let nextEvent = queue.first?.0 ?? .distantFuture
                let nextTimer = timer?.0 ?? .distantFuture
                let now = min(nextEvent, nextTimer)
                guard now <= end else { return }
                if nextTimer <= nextEvent, let (at, generation) = timer {
                    timer = nil
                    apply(machine.handle(.tick(generation: generation, at: at)), at: at)
                } else {
                    let (at, event) = queue.removeFirst()
                    apply(machine.handle(event), at: at)
                }
            }
        }
    }

    func testTwentySwitchesInTenSecondsStartOneRecognitionForTheLastWindow() {
        var run = Run(inputs: Self.allOn, recognitionTakes: 2)
        let switches = (0..<20).map { index in
            (Self.t(Double(index) * 0.5), BacktrackEvent.frontmostChanged(Self.window("W\(index)", x: CGFloat(index)), at: Self.t(Double(index) * 0.5)))
        }
        run.run(until: Self.t(12), inject: switches)
        XCTAssertEqual(run.captures.count, 1)
        XCTAssertEqual(run.captures.first?.1.windowTitle, "W19")
    }

    func testReducedBudgetNeverStartsRecognitionsCloserThanSixtySeconds() {
        var inputs = Self.allOn
        inputs.budget = .reduced
        var run = Run(inputs: inputs, recognitionTakes: 2)
        let switches = stride(from: 0.0, to: 400, by: 7).map { second in
            (Self.t(second), BacktrackEvent.frontmostChanged(Self.window("W\(Int(second) % 3)", x: CGFloat(Int(second) % 3)), at: Self.t(second)))
        }
        run.run(until: Self.t(420), inject: switches)
        XCTAssertGreaterThan(run.captures.count, 2, "the run exercised the deadline")
        for (earlier, later) in zip(run.captures, run.captures.dropFirst()) {
            XCTAssertGreaterThanOrEqual(later.0.timeIntervalSince(earlier.0), 60 - 0.001)
        }
    }

    func testNormalBudgetNeverStartsRecognitionsCloserThanTenSeconds() {
        var run = Run(inputs: Self.allOn, recognitionTakes: 2)
        let switches = stride(from: 0.0, to: 120, by: 3).map { second in
            (Self.t(second), BacktrackEvent.frontmostChanged(Self.window("W\(Int(second) % 4)", x: CGFloat(Int(second) % 4)), at: Self.t(second)))
        }
        run.run(until: Self.t(130), inject: switches)
        XCTAssertGreaterThan(run.captures.count, 2)
        for (earlier, later) in zip(run.captures, run.captures.dropFirst()) {
            XCTAssertGreaterThanOrEqual(later.0.timeIntervalSince(earlier.0), 10 - 0.001)
        }
    }

    func testTheViewersSearchMatchesEveryShownFieldIgnoringCaseAndAccents() {
        let segment = BacktrackSegment(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Café menu",
            address: "https://example.com/specials", lines: ["Soup of the day", "Lemon TART"],
            start: Self.t0, end: Self.t0
        )
        for query in ["safari", "cafe", "EXAMPLE.com", "lemon tart", "soup"] {
            XCTAssertTrue(segment.contains(query), query)
        }
        XCTAssertFalse(segment.contains("pizza"))
    }
}
#endif
