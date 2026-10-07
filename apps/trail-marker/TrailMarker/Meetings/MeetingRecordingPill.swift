import AppKit
import Combine
import SwiftUI

struct MeetingRecordingPill: View {
    @ObservedObject var host: MeetingCaptureHost

    var body: some View {
        HStack(spacing: 0) {
            CapturedWaveform(levels: host.recordingPresentation.waveform)
                .frame(width: 32, height: 24)
                .accessibilityLabel("Captured audio level")
                .accessibilityValue(host.recordingPresentation.waveform.allSatisfy { $0 == 0 } ? "Silent" : "Audio arriving")
            Spacer(minLength: TrailMarkerTokens.Spacing.related)
            Button {
                if host.phase == .paused { host.openMeetingInBrowser() }
                else { host.pauseFromUserClick() }
            } label: {
                Image(systemName: host.phase == .paused ? "play.fill" : "pause")
                    .font(.system(size: 24, weight: .medium))
                    .frame(width: TrailMarkerTokens.Layout.recordingControlDiameter,
                           height: TrailMarkerTokens.Layout.recordingControlDiameter)
                    .foregroundStyle(TrailMarkerTokens.Color.recordingForeground)
                    .background(TrailMarkerTokens.Color.recordingSurface, in: Circle())
                    .overlay(Circle().strokeBorder(TrailMarkerTokens.Color.recordingControlBorder, lineWidth: 1))
                    .contentShape(Circle())
            }
            .disabled(host.phase != .recording && host.phase != .paused)
            .help(host.phase == .paused ? "Resume in Moss" : "Pause recording")
            .accessibilityLabel(host.phase == .paused ? "Resume in Moss" : "Pause recording")
            Spacer(minLength: TrailMarkerTokens.Spacing.related)
            Button(action: host.stopFromUserClick) {
                Image(systemName: "stop")
                    .font(.system(size: 24, weight: .medium))
                    .frame(width: TrailMarkerTokens.Layout.recordingControlDiameter,
                           height: TrailMarkerTokens.Layout.recordingControlDiameter)
                    .foregroundStyle(TrailMarkerTokens.Color.recordingOnDanger)
                    .background(TrailMarkerTokens.Color.recordingDanger, in: Circle())
                    .contentShape(Circle())
            }
                .disabled(!host.canStop).help("Stop recording").accessibilityLabel("Stop recording")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, TrailMarkerTokens.Spacing.section)
        .frame(width: TrailMarkerTokens.Layout.recordingPillWidth, height: TrailMarkerTokens.Layout.recordingPillHeight)
        .background(TrailMarkerTokens.Color.recordingSurface, in: Capsule())
        .overlay(Capsule().strokeBorder(TrailMarkerTokens.Color.recordingBorder, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Meeting recording controls")
        .accessibilityValue(host.recordingPresentation.state.rawValue)
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
            let visibleLevels = levels.suffix(8)
            for (index, level) in visibleLevels.enumerated() {
                let x = (CGFloat(index) + 0.5) * size.width / CGFloat(visibleLevels.count)
                let height = CGFloat(level) * size.height / 2
                path.move(to: CGPoint(x: x, y: size.height / 2 - height))
                path.addLine(to: CGPoint(x: x, y: size.height / 2 + height))
            }
            context.stroke(path, with: .color(TrailMarkerTokens.Color.recordingDanger), style: StrokeStyle(lineWidth: 2, lineCap: .round))
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
        panel = RecordingPanel(contentRect: NSRect(x: 0, y: 0,
                        width: TrailMarkerTokens.Layout.recordingPillWidth, height: TrailMarkerTokens.Layout.recordingPillHeight),
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
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - TrailMarkerTokens.Layout.recordingPillWidth / 2,
                y: screen.visibleFrame.maxY - TrailMarkerTokens.Layout.recordingPillHeight - TrailMarkerTokens.Spacing.group))
        }
        subscription = host.$recordingPresentation.map(\.showsPill).removeDuplicates().sink { [weak self] visible in
            if visible { self?.panel.orderFrontRegardless() }
            else { self?.panel.orderOut(nil) }
        }
    }
}
