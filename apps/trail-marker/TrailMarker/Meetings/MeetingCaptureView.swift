import AppKit
import Combine
import SwiftUI

/// Compact native companion to the approved capture-focused Setup and Pause/Stop controls.
struct MeetingCaptureView: View {
    @ObservedObject var host: MeetingCaptureHost

    var body: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.group) {
            Label("Meeting capture", systemImage: "waveform")
                .font(.title2.weight(.semibold))
            Label(status, systemImage: statusSymbol)
                .font(.headline)
            if let warning = host.interruptionWarning {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else {
                Text(host.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            if host.phase == .recording || host.phase == .recovering || host.phase == .paused || host.phase == .stopping {
                Text(host.sourceDescription).font(.callout).foregroundStyle(.secondary)
            }
            Divider()
            if let output = host.outputMessage {
                Text(output).font(.callout).foregroundStyle(.secondary)
            }
            if let connectivity = host.connectivityMessage {
                Text(connectivity).font(.callout).foregroundStyle(.secondary)
            }
            if let backlog = host.backlogMessage {
                Text(backlog).font(.callout).foregroundStyle(.secondary)
            }
            if let processing = host.processingMessage {
                Text(processing).font(.callout).foregroundStyle(.secondary)
            }
            HStack(spacing: TrailMarkerTokens.Spacing.related) {
                Button("Open meeting in Moss") { host.openMeetingInBrowser() }
                    .disabled(host.activation == nil || host.phase == .recording || host.phase == .recovering || host.phase == .stopping)
                if host.phase == .paused || host.interruptionWarning != nil {
                    Button("Resume", action: host.resumeFromUserClick).disabled(!host.canResumeFromUserClick)
                } else {
                    Button("Pause", action: host.pauseFromUserClick).disabled(!host.recordingPresentation.canPause)
                }
                Button("Stop", role: .destructive) { host.stopFromUserClick() }.disabled(!host.canStop)
            }
            if host.inventory?.microphonePermission == .denied {
                Button("Open microphone settings") { MeetingCapturePermissions.openMicrophoneSettings() }
            }
            if host.phase == .paused || host.phase == .error {
                Button("Open system-audio settings") { SystemSettingsLinks.openScreenRecording() }
            }
            Text("Computer audio can include unrelated sound. Audio stays in a bounded memory buffer until sent to your configured Moss processing route. Closing this window keeps capture running; use Pause or Stop.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(TrailMarkerTokens.Spacing.section)
        .frame(width: 460)
    }

    private var statusSymbol: String {
        if host.interruptionWarning != nil { return "exclamationmark.triangle.fill" }
        if host.phase == .recovering { return "arrow.triangle.2.circlepath" }
        return host.phase == .recording ? "record.circle" : "pause.circle"
    }

    private var status: String {
        switch host.phase {
        case .unprepared: return "Not recording"
        case .ready: return "Ready for Start meeting in Moss"
        case .recording: return "Recording"
        case .recovering: return MeetingRecordingPresentation.State.recovering.rawValue
        case .paused: return "Paused"
        case .stopping: return "Finishing captured audio"
        case .stopped: return "Stopped"
        case .error: return host.cleanupBlocked ? "Audio cleanup needs attention" : "Capture unavailable"
        }
    }
}

/// A separate labelled status item keeps Meetings visible without changing Backtrack's dot,
/// consent, switch or lifecycle. The item cannot be dismissed while recording.
@MainActor
final class MeetingCaptureStatusItem: NSObject {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let host: MeetingCaptureHost
    private let showControls: () -> Void
    private var cancellables = Set<AnyCancellable>()
    private var menuState: MenuState?

    private struct MenuState: Equatable {
        let phase: MeetingCaptureHost.Phase
        let cleanup: Bool
        let recording: Bool
        let showsPill: Bool
        let showsAttention: Bool
        let canPause: Bool
        let canResume: Bool
        let canStop: Bool
        let status: String
        let warning: String?
    }

    init(host: MeetingCaptureHost, showControls: @escaping () -> Void) {
        self.host = host
        self.showControls = showControls
        super.init()
        host.objectWillChange
        .sink { [weak self] _ in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.update(self.host.phase, cleanup: self.host.cleanupBlocked)
            }
        }.store(in: &cancellables)
        update(host.phase, cleanup: host.cleanupBlocked)
    }

    private func update(_ phase: MeetingCaptureHost.Phase, cleanup: Bool) {
        let presentation = host.recordingPresentation
        let status = presentation.showsAttention ? presentation.state.rawValue : phase.rawValue
        let next = MenuState(phase: phase, cleanup: cleanup, recording: presentation.showsRedDot,
            showsPill: presentation.showsPill, showsAttention: presentation.showsAttention,
            canPause: presentation.canPause, canResume: host.canResumeFromUserClick, canStop: host.canStop,
            status: status, warning: host.interruptionWarning)
        // Resume eligibility can change on an acknowledgment without changing phase. Observe
        // it too, but do not replace an open menu for every audio-meter/display tick.
        guard menuState != next else { return }
        menuState = next
        item.isVisible = ![.unprepared, .stopped].contains(phase) || cleanup || next.showsAttention
        let recording = next.recording
        let title = NSMutableAttributedString(string: recording ? "● Meeting" : "Meeting",
            attributes: [.foregroundColor: NSColor.labelColor])
        if recording { title.addAttribute(.foregroundColor, value: NSColor.systemRed, range: NSRange(location: 0, length: 1)) }
        item.button?.attributedTitle = title
        item.button?.toolTip = next.warning ?? "Meeting capture: \(status). Click for controls."
        item.button?.setAccessibilityLabel("Meeting capture: \(status)")
        let menu = NSMenu()
        menu.autoenablesItems = false
        if next.showsAttention {
            let statusItem = NSMenuItem(title: status, action: nil, keyEquivalent: "")
            statusItem.isEnabled = false
            statusItem.toolTip = next.warning
            menu.addItem(statusItem)
        }
        menu.addItem(action("Meeting controls…", #selector(openControls)))
        if recording && !next.showsPill {
            menu.addItem(action("Show recording pill", #selector(showRecordingPill)))
        }
        if phase == .paused || next.warning != nil {
            let resume = action("Resume recording", #selector(resumeCapture))
            resume.isEnabled = next.canResume
            menu.addItem(resume)
        } else {
            let pause = action("Pause recording", #selector(pauseCapture))
            pause.isEnabled = next.canPause
            menu.addItem(pause)
        }
        let stop = action("Stop recording", #selector(stopCapture))
        stop.isEnabled = next.canStop
        menu.addItem(stop)
        item.menu = menu
    }

    private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        item.target = self
        return item
    }
    @objc private func openControls() { showControls() }
    @objc private func showRecordingPill() { host.showRecordingPill() }
    @objc private func pauseCapture() { host.pauseFromUserClick() }
    @objc private func resumeCapture() { host.resumeFromUserClick() }
    @objc private func stopCapture() { host.stopFromUserClick() }
}
