#if DEBUG
import CoreGraphics
import Darwin
import Foundation
import os

// Kill-gate follow-up (#2638, 2026-09-24): the day-1 CPU sample failed at 10.8%, so this measures
// where the time goes across trial builds. Numbers only — no app, window, address or text
// ever reaches these lines; the unified log keeps them where `log show` can count them:
//
//   /usr/bin/log show --last 2h --predicate 'subsystem == "com.moss.trailmarker" AND category == "backtrack-metrics"'
//
// CPU is this process's user+system time across the step, so a step that overlaps other work in
// the app is slightly overstated; the periodic `total` line bounds what is left unexplained.

/// Process CPU time (user + system) in milliseconds.
func backtrackProcessCPUMilliseconds() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    func ms(_ t: timeval) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_usec) / 1000 }
    return ms(usage.ru_utime) + ms(usage.ru_stime)
}

/// A step's wall and CPU time, started when created.
struct BacktrackStopwatch {
    private let wall = Date()
    private let cpu = backtrackProcessCPUMilliseconds()
    var wallMilliseconds: Int { Int(Date().timeIntervalSince(wall) * 1000) }
    var cpuMilliseconds: Int { Int(backtrackProcessCPUMilliseconds() - cpu) }
}

@MainActor
final class BacktrackMetrics {
    private let log = Logger(subsystem: "com.moss.trailmarker", category: "backtrack-metrics")
    /// Measurement-only mean-difference baseline, updated on checks and captures. The real
    /// detector uses successful-recognition fingerprints and is not affected by these samples.
    private var seen: [DedupeKey: [UInt8]] = [:]
    private var order: [DedupeKey] = []
    private var totalTimer: Timer?
    private var lastTotal = (at: Date(), cpu: backtrackProcessCPUMilliseconds())
    /// Set by the runtime while a pass's segment is emitted, read back when the pass is logged.
    var emittedLines: Int?

    deinit { totalTimer?.invalidate() }

    func start() {
        guard totalTimer == nil else { return }
        log.notice("start")
        totalTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
            Task { @MainActor [weak self] in self?.logTotal() }
        }
    }

    private func logTotal() {
        let now = (at: Date(), cpu: backtrackProcessCPUMilliseconds())
        let wall = Int(now.at.timeIntervalSince(lastTotal.at) * 1000)
        let cpu = Int(now.cpu - lastTotal.cpu)
        lastTotal = now
        log.notice("total wall_ms=\(wall, privacy: .public) cpu_ms=\(cpu, privacy: .public)")
    }

    /// Mean absolute greyscale difference from what was last seen for this window, then remembers
    /// the new one. Nil the first time a window is seen.
    func distance(_ key: DedupeKey, image: CGImage) -> Double? {
        guard let pixels = ThumbnailChangeDetector.greyscale(image) else { return nil }
        defer {
            seen[key] = pixels
            order.removeAll { $0 == key }
            order.append(key)
            if order.count > ThumbnailChangeDetector.maxWindows { seen[order.removeFirst()] = nil }
        }
        guard let previous = seen[key], previous.count == pixels.count else { return nil }
        let total = zip(previous, pixels).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }
        return Double(total) / Double(pixels.count)
    }

    func reset() {
        seen = [:]
        order = []
    }

    func thumbnail(trigger: String, _ step: BacktrackStopwatch, distance: Double?, changed: Bool) {
        log.notice(
            "thumb trigger=\(trigger, privacy: .public) wall_ms=\(step.wallMilliseconds, privacy: .public) cpu_ms=\(step.cpuMilliseconds, privacy: .public) diff=\(Self.format(distance), privacy: .public) changed=\(changed ? 1 : 0, privacy: .public)"
        )
    }

    func capture(trigger: String, _ step: BacktrackStopwatch, distance: Double?) {
        log.notice(
            "capture trigger=\(trigger, privacy: .public) wall_ms=\(step.wallMilliseconds, privacy: .public) cpu_ms=\(step.cpuMilliseconds, privacy: .public) diff=\(Self.format(distance), privacy: .public) idle_s=\(Int(Self.idleSeconds()), privacy: .public)"
        )
    }

    /// An Accessibility read. The app is its bundle id, which is app metadata, never window content.
    func text(trigger: String, app: String, _ step: BacktrackStopwatch, result: WindowTextResult?, verdict: WindowTextVerdict) {
        let emitted = emittedLines
        emittedLines = nil
        let outcome: String
        switch verdict {
        case .use: outcome = "use"
        case .thin(let reason): outcome = reason
        }
        log.notice(
            "ax trigger=\(trigger, privacy: .public) app=\(app, privacy: .public) wall_ms=\(step.wallMilliseconds, privacy: .public) cpu_ms=\(step.cpuMilliseconds, privacy: .public) walk_ms=\(result?.walkMilliseconds ?? -1, privacy: .public) content=\(result?.contentCharacters ?? 0, privacy: .public) controls=\(result?.controlCharacters ?? 0, privacy: .public) truncated=\(result?.truncated == true ? 1 : 0, privacy: .public) verdict=\(outcome, privacy: .public) emitted_lines=\(emitted ?? 0, privacy: .public)"
        )
    }

    func recognition(trigger: String, app: String, _ step: BacktrackStopwatch, lines: Int) {
        let emitted = emittedLines
        emittedLines = nil
        log.notice(
            "ocr trigger=\(trigger, privacy: .public) app=\(app, privacy: .public) wall_ms=\(step.wallMilliseconds, privacy: .public) cpu_ms=\(step.cpuMilliseconds, privacy: .public) lines=\(lines, privacy: .public) emitted_lines=\(emitted ?? 0, privacy: .public)"
        )
    }

    func skipped(_ stage: String) {
        log.notice("skip stage=\(stage, privacy: .public)")
    }

    private static func format(_ distance: Double?) -> String {
        distance.map { String(format: "%.2f", $0) } ?? "none"
    }

    /// Seconds since any keyboard or mouse input, for sizing an idle pause.
    private static func idleSeconds() -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    }
}
#endif
