import AppKit
import Combine
import SwiftUI

struct MeetingRecordingPill: View {
    @ObservedObject var host: MeetingCaptureHost
    let presentation: MeetingRecordingPresentation

    var body: some View {
        Group {
            if presentation.showsAttention { attentionControls }
            else { compactControls }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Meeting recording controls")
        .accessibilityValue(presentation.state.rawValue)
    }

    private var attentionControls: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.row) {
            Label(presentation.state.rawValue,
                  systemImage: presentation.interruptionWarning == nil ? "arrow.triangle.2.circlepath" : "exclamationmark.triangle.fill")
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            if let warning = presentation.interruptionWarning {
                Text(warning)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else {
                Text("Capture is interrupted while the same audio sources restart.")
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: TrailMarkerTokens.Spacing.related) {
                if presentation.state == .recovering {
                    Button("Pause", action: host.pauseFromUserClick)
                        .disabled(!presentation.canPause)
                } else {
                    Button("Resume", action: host.resumeFromUserClick)
                        .disabled(!host.canResumeFromUserClick)
                }
                Button("Stop", role: .destructive, action: host.stopFromUserClick)
                    .disabled(!host.canStop)
            }
            .buttonStyle(.bordered)
        }
        .foregroundStyle(TrailMarkerTokens.Color.charcoal)
        .padding(TrailMarkerTokens.Spacing.group)
        .frame(width: TrailMarkerTokens.Layout.menuPopoverWidth, alignment: .leading)
        .background(TrailMarkerTokens.Color.recordingSurface,
                    in: RoundedRectangle(cornerRadius: TrailMarkerTokens.Layout.brandPanelRadius))
        .overlay(RoundedRectangle(cornerRadius: TrailMarkerTokens.Layout.brandPanelRadius)
            .strokeBorder(TrailMarkerTokens.Color.recordingBorder,
                          lineWidth: TrailMarkerTokens.Layout.recordingPillBorderWidth))
    }

    private var compactControls: some View {
        HStack(spacing: 0) {
            CapturedAudioLevelMeter(levels: presentation.meterLevels)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Captured audio level")
                .accessibilityValue(presentation.meterLevels.allSatisfy { $0 == 0 } ? "Silent" : "Audio arriving")
            Spacer(minLength: TrailMarkerTokens.Layout.recordingControlMinimumGap)
            MeetingRecordingSourceMenu(host: host)
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
            .disabled(!presentation.canPause && !host.canResumeFromUserClick)
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
            Spacer(minLength: TrailMarkerTokens.Layout.recordingControlMinimumGap)
            HStack(spacing: TrailMarkerTokens.Layout.recordingCloseSectionSpacing) {
                Rectangle().fill(TrailMarkerTokens.Color.recordingBorder)
                    .frame(width: TrailMarkerTokens.Layout.recordingCloseDividerWidth,
                           height: TrailMarkerTokens.Layout.recordingCloseDividerHeight)
                    .accessibilityHidden(true)
                Button(action: host.hideRecordingPill) {
                    Image(systemName: "xmark")
                        .font(.system(size: TrailMarkerTokens.Layout.recordingCloseIconSize, weight: .regular))
                        .frame(width: TrailMarkerTokens.Layout.recordingCloseDiameter,
                               height: TrailMarkerTokens.Layout.recordingCloseDiameter)
                        .foregroundStyle(TrailMarkerTokens.Color.recordingForeground)
                        .contentShape(Rectangle())
                }
                .disabled(!presentation.canHide)
                .help("Hide recording pill; recording continues")
                .accessibilityLabel("Hide recording pill")
                .accessibilityHint("Recording continues. Show it again from the Meeting menu.")
            }
            .frame(width: TrailMarkerTokens.Layout.recordingCloseSectionWidth)
        }
        .buttonStyle(.plain)
        .padding(.leading, TrailMarkerTokens.Layout.recordingPillLeadingInset)
        .padding(.trailing, TrailMarkerTokens.Layout.recordingPillTrailingInset)
        .frame(width: TrailMarkerTokens.Layout.recordingPillWidth, height: TrailMarkerTokens.Layout.recordingPillHeight)
        .background(TrailMarkerTokens.Color.recordingSurface, in: Capsule())
        .overlay(Capsule().strokeBorder(TrailMarkerTokens.Color.recordingBorder,
                                       lineWidth: TrailMarkerTokens.Layout.recordingPillBorderWidth))
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
    var hidePill: (() -> Void)?
    override var canBecomeKey: Bool { true }
    // A native close command has the same visibility-only meaning as the pill's X.
    override func close() { hidePill?() }
    override func performClose(_ sender: Any?) { close() }
}

private final class RecordingPillHostingView: NSHostingView<MeetingRecordingPill> {
    override var mouseDownCanMoveWindow: Bool { true }
}

@MainActor
final class MeetingRecordingPillController {
    let panel: NSPanel
    private var subscription: AnyCancellable?
    private let host: MeetingCaptureHost
    private let hostingView: RecordingPillHostingView

    init(host: MeetingCaptureHost) {
        self.host = host
        hostingView = RecordingPillHostingView(rootView: MeetingRecordingPill(host: host, presentation: host.recordingPresentation))
        let recordingPanel = RecordingPanel(contentRect: NSRect(x: 0, y: 0,
                        width: TrailMarkerTokens.Layout.recordingPillWidth, height: TrailMarkerTokens.Layout.recordingPillHeight),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        recordingPanel.hidePill = { [weak host] in host?.hideRecordingPill() }
        panel = recordingPanel
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
        panel.appearance = NSAppearance(named: .aqua)
        panel.contentView = hostingView
        if let screen = NSScreen.main ?? NSScreen.screens.first {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - TrailMarkerTokens.Layout.recordingPillWidth / 2,
                y: screen.visibleFrame.maxY - TrailMarkerTokens.Layout.recordingPillHeight - TrailMarkerTokens.Spacing.group))
        }
        subscription = host.$recordingPresentation.removeDuplicates().sink { [weak self] presentation in
            self?.present(presentation)
        }
    }

    func present(_ presentation: MeetingRecordingPresentation) {
        hostingView.rootView = MeetingRecordingPill(host: host, presentation: presentation)
        hostingView.layoutSubtreeIfNeeded()
        let size = presentation.showsAttention ? hostingView.fittingSize : NSSize(
            width: TrailMarkerTokens.Layout.recordingPillWidth, height: TrailMarkerTokens.Layout.recordingPillHeight)
        if panel.frame.size != size {
            // Keep the top edge steady and the entire warning readable after expanding a
            // compact pill, including one dragged to a display edge before interruption.
            var frame = NSRect(x: panel.frame.midX - size.width / 2,
                               y: panel.frame.maxY - size.height, width: size.width, height: size.height)
            if let visible = panel.screen?.visibleFrame {
                frame.origin.x = max(visible.minX, min(frame.minX, visible.maxX - frame.width))
                frame.origin.y = max(visible.minY, min(frame.minY, visible.maxY - frame.height))
            }
            panel.setFrame(frame, display: true)
        }
        if presentation.showsPill {
            if !panel.isVisible { panel.orderFrontRegardless() }
        } else { panel.orderOut(nil) }
    }
}
