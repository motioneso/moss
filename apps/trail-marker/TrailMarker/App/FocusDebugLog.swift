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

#if DEBUG
/// The last few focus events, newest first, for watching a live test.
@MainActor
final class FocusDebugLog: ObservableObject {
    static let shared = FocusDebugLog()
    private static let limit = 60

    @Published private(set) var lines: [String] = []

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
