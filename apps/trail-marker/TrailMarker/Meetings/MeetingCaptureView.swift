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
            Label(status, systemImage: host.isRecording ? "record.circle" : "pause.circle")
                .font(.headline)
            Text(host.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            if host.phase == .recording || host.phase == .paused || host.phase == .stopping {
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
                Button(host.phase == .paused ? "Resume in Moss" : "Open meeting in Moss") { host.openMeetingInBrowser() }
                    .disabled(host.activation == nil || host.phase == .recording || host.phase == .stopping)
                Button("Pause") { host.pauseFromUserClick() }.disabled(host.phase != .recording)
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

    private var status: String {
        switch host.phase {
        case .unprepared: return "Not recording"
        case .ready: return "Ready for Start meeting in Moss"
        case .recording: return "Recording"
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

    init(host: MeetingCaptureHost, showControls: @escaping () -> Void) {
        self.host = host
        self.showControls = showControls
        super.init()
        host.$phase.combineLatest(host.$cleanupBlocked,
            host.$recordingPresentation.map(\.showsRedDot).removeDuplicates(),
            host.$recordingPresentation.map(\.showsPill).removeDuplicates())
        .sink { [weak self] _, _, _, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.update(self.host.phase, cleanup: self.host.cleanupBlocked)
            }
        }.store(in: &cancellables)
        update(host.phase, cleanup: host.cleanupBlocked)
    }

    private func update(_ phase: MeetingCaptureHost.Phase, cleanup: Bool) {
        item.isVisible = ![.unprepared, .stopped].contains(phase) || cleanup
        let recording = host.recordingPresentation.showsRedDot
        let title = NSMutableAttributedString(string: recording ? "● Meeting" : "Meeting",
            attributes: [.foregroundColor: NSColor.labelColor])
        if recording { title.addAttribute(.foregroundColor, value: NSColor.systemRed, range: NSRange(location: 0, length: 1)) }
        item.button?.attributedTitle = title
        item.button?.toolTip = recording ? "Meeting recording: click for Pause and Stop" : "Meeting capture: \(phase.rawValue)"
        item.button?.setAccessibilityLabel(recording ? "Meeting recording" : "Meeting capture \(phase.rawValue)")
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(action("Meeting controls…", #selector(openControls)))
        if recording && !host.recordingPresentation.showsPill {
            menu.addItem(action("Show recording pill", #selector(showRecordingPill)))
        }
        let pause = action("Pause recording", #selector(pauseCapture))
        pause.isEnabled = phase == .recording
        menu.addItem(pause)
        let stop = action("Stop recording", #selector(stopCapture))
        stop.isEnabled = host.canStop
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
    @objc private func stopCapture() { host.stopFromUserClick() }
}
