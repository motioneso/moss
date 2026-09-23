import AppKit
import Combine
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

/// The top edge for a panel: below the menu bar even when it auto-hides (full-screen apps), so the
/// Trail Marker icon stays clickable and Pause is always reachable.
@MainActor
private func topBelowMenuBar(_ screen: NSScreen) -> CGFloat {
    screen.frame.maxY - NSStatusBar.system.thickness - 12
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
        if let screen = NSScreen.main {
            panel.setFrameTopLeftPoint(
                NSPoint(x: screen.frame.maxX - panel.frame.width - 16, y: topBelowMenuBar(screen))
            )
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

/// What a judgment does to the debug "back to work" banner (Ben's call, 2026-09-22): a distracted
/// answer shows it, only a focused answer (or pressing Wrong) clears it, anything else leaves it.
enum FocusBannerChange: Equatable {
    case show
    case hide
    case keep

    static func after(_ label: FocusLabel) -> FocusBannerChange {
        switch label {
        case .distracted: return .show
        case .focused: return .hide
        case .necessaryDetour, .insufficientEvidence: return .keep
        }
    }
}

#if DEBUG
/// An experiment, Debug builds only: a banner that stays above every window from a distracted
/// judgment until a focused one, instead of waiting for a real two-in-a-row nudge. It never takes
/// focus, so it does not change what is being observed.
@MainActor
final class FocusDebugBanner {
    private let panel: NSPanel
    private let model = BannerModel()
    private var cancellables = Set<AnyCancellable>()

    final class BannerModel: ObservableObject {
        @Published var goal = ""
        @Published var reason = ""
    }

    init(focus: FocusRuntime) {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 64),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.contentView = NSHostingView(
            rootView: FocusDebugBannerView(model: model) { [weak self, weak focus] in
                focus?.correct(.wrong)
                focusDebug("Banner cleared: Wrong sent")
                self?.panel.orderOut(nil)
            }
        )

        focus.$lastJudgment
            .compactMap { $0 }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] remembered in self?.apply(remembered) }
            .store(in: &cancellables)

        // Pause, Focus off, the block ending or no block: the banner points at nothing now.
        focus.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self, self.panel.isVisible else { return }
                if case .watching = state { return }
                self.panel.orderOut(nil)
                focusDebug("Banner cleared: no longer watching")
            }
            .store(in: &cancellables)
    }

    private func apply(_ remembered: RememberedJudgment) {
        switch FocusBannerChange.after(remembered.judgment.label) {
        case .show:
            model.goal = remembered.blockTitle
            model.reason = remembered.judgment.reason
            if !panel.isVisible {
                if let screen = NSScreen.main {
                    panel.setFrameTopLeftPoint(
                        NSPoint(x: screen.frame.midX - panel.frame.width / 2, y: topBelowMenuBar(screen))
                    )
                }
                panel.orderFrontRegardless()
                focusDebug("Banner shown")
            }
        case .hide:
            if panel.isVisible {
                panel.orderOut(nil)
                focusDebug("Banner cleared: focused")
            }
        case .keep:
            break
        }
    }
}

private struct FocusDebugBannerView: View {
    @ObservedObject var model: FocusDebugBanner.BannerModel
    let onWrong: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Back to: \(model.goal)").font(.system(size: 14, weight: .semibold))
                if !model.reason.isEmpty {
                    Text(model.reason).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Button("Wrong", action: onWrong)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}
#endif
