import AppKit
import Combine
import SwiftUI

struct MeetingRecordingPill: View {
    @ObservedObject var host: MeetingCaptureHost

    private var statusColor: Color {
        switch host.recordingPresentation.state {
        case .recording: return Color(nsColor: .systemRed)
        case .reconnecting: return Color(nsColor: .systemOrange)
        case .paused, .noAudio: return Color(nsColor: .secondaryLabelColor)
        }
    }

    var body: some View {
        HStack(spacing: TrailMarkerTokens.Spacing.related) {
            Circle().fill(statusColor).frame(width: 6, height: 6).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.compact) {
                Text(host.recordingPresentation.state.rawValue).font(.system(size: 12, weight: .semibold))
                Text(host.recordingPresentation.elapsedText).font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
            }
            .frame(width: 92, alignment: .leading)
            CapturedWaveform(levels: host.recordingPresentation.waveform)
                .frame(width: 88, height: 24)
                .accessibilityLabel("Captured audio level")
                .accessibilityValue(host.recordingPresentation.waveform.allSatisfy { $0 == 0 } ? "Silent" : "Audio arriving")
            Spacer(minLength: 0)
            Button {
                if host.phase == .paused { host.openMeetingInBrowser() }
                else { host.pauseFromUserClick() }
            } label: {
                Image(systemName: host.phase == .paused ? "play.fill" : "pause.fill").frame(width: 24, height: 24)
            }
            .disabled(host.phase != .recording && host.phase != .paused)
            .help(host.phase == .paused ? "Resume in Moss" : "Pause recording")
            .accessibilityLabel(host.phase == .paused ? "Resume in Moss" : "Pause recording")
            Button(action: host.stopFromUserClick) { Image(systemName: "stop.fill").frame(width: 24, height: 24) }
                .disabled(!host.canStop).help("Stop recording").accessibilityLabel("Stop recording")
            Button(action: host.hideRecordingPill) { Image(systemName: "xmark").frame(width: 24, height: 24) }
                .help("Hide until next Start. Recording continues.").accessibilityLabel("Hide recording pill; recording continues")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, TrailMarkerTokens.Spacing.row)
        .frame(width: 368, height: 56)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
    }
}

/// Every vertical stroke comes from an actual captured peak. Zero is a flat centre line.
private struct CapturedWaveform: View {
    let levels: [Float]
    var body: some View {
        Canvas { context, size in
            var path = Path()
            path.move(to: CGPoint(x: 0, y: size.height / 2))
            path.addLine(to: CGPoint(x: size.width, y: size.height / 2))
            for (index, level) in levels.enumerated() {
                let x = (CGFloat(index) + 0.5) * size.width / CGFloat(levels.count)
                let height = CGFloat(level) * size.height / 2
                path.move(to: CGPoint(x: x, y: size.height / 2 - height))
                path.addLine(to: CGPoint(x: x, y: size.height / 2 + height))
            }
            context.stroke(path, with: .color(.primary), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
        }
    }
}

/// A borderless nonactivating panel can still accept keyboard focus when its user clicks it.
private final class RecordingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

private final class RecordingPillHostingView: NSHostingView<MeetingRecordingPill> {
    override var mouseDownCanMoveWindow: Bool { true }
}

@MainActor
final class MeetingRecordingPillController {
    let panel: NSPanel
    private var subscription: AnyCancellable?

    init(host: MeetingCaptureHost) {
        panel = RecordingPanel(contentRect: NSRect(x: 0, y: 0, width: 368, height: 56),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Meeting recording"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.contentView = RecordingPillHostingView(rootView: MeetingRecordingPill(host: host))
        if let screen = NSScreen.main ?? NSScreen.screens.first {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 184, y: screen.visibleFrame.maxY - 72))
        }
        subscription = host.$recordingPresentation.map(\.showsPill).removeDuplicates().sink { [weak self] visible in
            if visible { self?.panel.orderFrontRegardless() }
            else { self?.panel.orderOut(nil) }
        }
    }
}
