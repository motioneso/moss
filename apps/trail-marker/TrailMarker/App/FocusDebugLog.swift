import AppKit
import SwiftUI

/// Adds a line to the floating focus log. Debug builds only: in a Release build this does nothing,
/// so no window title is ever kept for it. The log lives in memory and on screen only — never on
/// disk, never in the system log.
@MainActor
func focusDebug(_ message: @autoclosure () -> String) {
    #if DEBUG
    FocusDebugLog.shared.add(message())
    #endif
}

extension ObservationPolicy {
    /// Why `allows(_:)` answered the way it did, in the same order it checks, for the debug log.
    func explain(_ observation: Observation) -> String {
        if Self.deniedBundleIds.contains(observation.bundleId) { return "never watched (denylist)" }
        let title = observation.windowTitle.lowercased()
        if Self.deniedTitleMarkers.contains(where: { title.contains($0) }) {
            return "never watched (private window)"
        }
        if watchEntireDesktop { return "watched (entire desktop)" }
        if allowedBundleIds.contains(observation.bundleId) { return "watched (chosen app)" }
        return "not watched (not a chosen app)"
    }
}

/// Records a judgment in the debug log's running tally. Does nothing in a Release build.
@MainActor
func focusDebugTally(_ judgment: FocusJudgment, blockId: String?, at: Date = Date()) {
    #if DEBUG
    FocusDebugLog.shared.tally.record(judgment.label, nudged: judgment.nudge, blockId: blockId, at: at)
    #endif
}

/// Running counts for the debug log, mirroring the server's nudge rule (`decideNudge`): a nudge
/// needs the two newest judgments for the current block both distracted, and none in the last 45
/// minutes. Any other label breaks the run. Counts start over when the block changes.
struct FocusTally: Equatable {
    static let capMinutes: Double = 45

    private(set) var blockId: String?
    private(set) var counts: [FocusLabel: Int] = [:]
    private(set) var distractedRun = 0
    private(set) var lastNudgeAt: Date?

    mutating func record(_ label: FocusLabel, nudged: Bool, blockId: String?, at: Date) {
        if blockId != self.blockId {
            self.blockId = blockId
            counts = [:]
            distractedRun = 0
        }
        counts[label, default: 0] += 1
        distractedRun = label == .distracted ? distractedRun + 1 : 0
        if nudged { lastNudgeAt = at }
    }

    func summary(now: Date) -> String {
        let run = distractedRun >= 2
            ? "distracted \(distractedRun) in a row (nudge due)"
            : "distracted \(distractedRun) in a row (nudge at 2)"
        let count = { (label: FocusLabel) in self.counts[label] ?? 0 }
        let totals = "focused \(count(.focused)), detour \(count(.necessaryDetour)), "
            + "distracted \(count(.distracted)), unsure \(count(.insufficientEvidence))"
        var nudge = "no nudge yet"
        if let lastNudgeAt {
            let capEnds = lastNudgeAt.addingTimeInterval(Self.capMinutes * 60)
            let time = { (date: Date) in date.formatted(date: .omitted, time: .shortened) }
            nudge = "last nudge \(time(lastNudgeAt))"
                + (capEnds > now ? ", next allowed \(time(capEnds))" : ", next allowed now")
        }
        return "Run: \(run)\nThis block: \(totals)\n\(nudge) (on this Mac)"
    }
}

#if DEBUG
/// The last few focus events, newest first, for watching a live test.
@MainActor
final class FocusDebugLog: ObservableObject {
    static let shared = FocusDebugLog()
    private static let limit = 60

    @Published private(set) var lines: [String] = []
    @Published var tally = FocusTally()

    func add(_ message: String) {
        let time = Date().formatted(date: .omitted, time: .standard)
        lines.insert("\(time)  \(message)", at: 0)
        if lines.count > Self.limit { lines.removeLast(lines.count - Self.limit) }
    }
}

/// A small always-on-top panel showing `FocusDebugLog`. It never takes focus from the app in
/// front, so it does not change what is being observed.
@MainActor
final class FocusDebugOverlay {
    private let panel: NSPanel

    init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 280),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .hudWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Trail Marker focus log (debug build)"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: FocusDebugLogView(log: .shared))
    }

    func show() {
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.maxX - panel.frame.width - 16, y: screen.maxY - 8))
        }
        panel.orderFrontRegardless()
    }
}

private struct FocusDebugLogView: View {
    @ObservedObject var log: FocusDebugLog

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(log.tally.summary(now: context.date))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            Divider()
            lines
        }
    }

    private var lines: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if log.lines.isEmpty {
                    Text("Nothing yet.").foregroundStyle(.secondary)
                }
                ForEach(Array(log.lines.enumerated()), id: \.offset) { _, line in
                    Text(line).textSelection(.enabled)
                }
            }
            .font(.system(size: 11, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
        }
    }
}
#endif
