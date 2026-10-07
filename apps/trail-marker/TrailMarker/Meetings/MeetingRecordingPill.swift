import AppKit
import Combine
import SwiftUI

struct MeetingRecordingPill: View {
    @ObservedObject var host: MeetingCaptureHost

    var body: some View {
        HStack(spacing: 0) {
            CapturedAudioLevelMeter(levels: host.recordingPresentation.meterLevels)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Captured audio level")
                .accessibilityValue(host.recordingPresentation.meterLevels.allSatisfy { $0 == 0 } ? "Silent" : "Audio arriving")
            Spacer(minLength: TrailMarkerTokens.Layout.recordingControlMinimumGap)
            Button {
                if host.phase == .paused { host.resumeFromUserClick() }
                else { host.pauseFromUserClick() }
            } label: {
                Image(systemName: host.phase == .paused ? "play.fill" : "pause")
                    .font(.system(size: TrailMarkerTokens.Layout.recordingControlIconSize, weight: .regular))
                    .frame(width: TrailMarkerTokens.Layout.recordingControlDiameter,
                           height: TrailMarkerTokens.Layout.recordingControlDiameter)
                    .foregroundStyle(TrailMarkerTokens.Color.recordingForeground)
                    .background(TrailMarkerTokens.Color.recordingSurface, in: Circle())
                    .overlay(Circle().strokeBorder(TrailMarkerTokens.Color.recordingControlBorder,
                                                  lineWidth: TrailMarkerTokens.Layout.recordingControlBorderWidth))
                    .contentShape(Circle())
            }
            .disabled(host.phase != .recording && !host.canResumeFromUserClick)
            .help(host.phase == .paused ? "Resume recording" : "Pause recording")
            .accessibilityLabel(host.phase == .paused ? "Resume recording" : "Pause recording")
            Spacer(minLength: TrailMarkerTokens.Layout.recordingControlMinimumGap)
            Button(action: host.stopFromUserClick) {
                Image(systemName: "stop.fill")
                    .font(.system(size: TrailMarkerTokens.Layout.recordingControlIconSize, weight: .regular))
                    .frame(width: TrailMarkerTokens.Layout.recordingControlDiameter,
                           height: TrailMarkerTokens.Layout.recordingControlDiameter)
                    .foregroundStyle(TrailMarkerTokens.Color.recordingOnDanger)
                    .background(TrailMarkerTokens.Color.recordingDanger, in: Circle())
                    .contentShape(Circle())
            }
                .disabled(!host.canStop).help("Stop recording").accessibilityLabel("Stop recording")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, TrailMarkerTokens.Layout.recordingPillHorizontalInset)
        .frame(width: TrailMarkerTokens.Layout.recordingPillWidth, height: TrailMarkerTokens.Layout.recordingPillHeight)
        .background(TrailMarkerTokens.Color.recordingSurface, in: Capsule())
        .overlay(Capsule().strokeBorder(TrailMarkerTokens.Color.recordingBorder,
                                       lineWidth: TrailMarkerTokens.Layout.recordingPillBorderWidth))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Meeting recording controls")
        .accessibilityValue(host.recordingPresentation.state.rawValue)
    }
}

/// Three recent captured peaks, with no connecting waveform or decorative motion.
/// Silence collapses every bar to a flat dash immediately, including stale input.
private struct CapturedAudioLevelMeter: View {
    let levels: [Float]
    var body: some View {
        HStack(spacing: TrailMarkerTokens.Layout.recordingMeterBarSpacing) {
            ForEach(levels.indices, id: \.self) { index in
                RoundedRectangle(cornerRadius: TrailMarkerTokens.Layout.recordingMeterBarCornerRadius)
                    .fill(TrailMarkerTokens.Color.recordingDanger)
                    .frame(width: TrailMarkerTokens.Layout.recordingMeterBarWidth,
                           height: max(TrailMarkerTokens.Layout.recordingMeterSilentHeight,
                                       CGFloat(levels[index]) * TrailMarkerTokens.Layout.recordingMeterHeight))
            }
        }
        .frame(width: TrailMarkerTokens.Layout.recordingMeterWidth,
               height: TrailMarkerTokens.Layout.recordingMeterHeight)
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
