import SwiftUI

/// The menu expresses a user choice for the current recording; it never changes OS defaults.
struct MeetingRecordingSourceMenu: View {
    @ObservedObject var host: MeetingCaptureHost

    var body: some View {
        let microphones = host.inventory?.microphones ?? []
        let choice = host.currentSourceChoice
        Menu {
            Section("Microphone") {
                sourceItem("None", selected: choice?.microphone == nil) {
                    host.selectMicrophoneFromUserClick(nil)
                }
                ForEach(Array(microphones.enumerated()), id: \.offset) { entry in
                    let microphone = entry.element
                    sourceItem(microphone.label, selected:
                        choice?.microphone?.deviceId == microphone.deviceId &&
                        choice?.microphone?.sourceId == microphone.sourceId) {
                        host.selectMicrophoneFromUserClick(.init(deviceId: microphone.deviceId, sourceId: microphone.sourceId))
                    }
                }
            }
            Section("System Audio") {
                sourceItem("No computer audio", selected: choice?.mode == "microphone-only") {
                    host.setComputerAudioFromUserClick(false)
                }
                sourceItem("Record computer audio", selected: choice?.mode == "computer-audio") {
                    host.setComputerAudioFromUserClick(true)
                }
                if choice?.mode == "selected-app" {
                    Label("Selected app (saved)", systemImage: "checkmark").disabled(true)
                }
            }
        } label: {
            HStack(spacing: 2) {
                Image(systemName: "mic")
                    .font(.system(size: TrailMarkerTokens.Layout.recordingSourceIconSize))
                Image(systemName: "chevron.down")
                    .font(.system(size: TrailMarkerTokens.Layout.recordingSourceChevronSize))
            }
            .foregroundStyle(TrailMarkerTokens.Color.recordingForeground)
            .frame(width: TrailMarkerTokens.Layout.recordingSourceMenuWidth,
                   height: TrailMarkerTokens.Layout.recordingControlDiameter)
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(!host.canChangeSourcesFromUserClick)
        .help("Recording audio sources")
        .accessibilityLabel("Recording audio sources")
        .alert("Recording audio sources", isPresented: Binding(
            get: { host.sourceSelectionError != nil },
            set: { if !$0 { host.dismissSourceSelectionError() } }
        )) {
            Button("OK", role: .cancel) { host.dismissSourceSelectionError() }
        } message: {
            Text(host.sourceSelectionError ?? "")
        }
    }

    @ViewBuilder
    private func sourceItem(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if selected { Label(title, systemImage: "checkmark") }
            else { Text(title) }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
