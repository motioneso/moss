import SwiftUI

/// Design guide §8 step 4. Permissions are optional and never block linking (§17).
struct DeviceSetupView: View {
    @ObservedObject var viewModel: OnboardingViewModel
    @ObservedObject var permissions: PermissionsService

    var body: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.section) {
            Text("Set up this Mac")
                .font(.title2.weight(.semibold))

            VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.compact) {
                Text("Device name")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                TextField("This Mac", text: $viewModel.deviceName)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 320)
            }

            Toggle("Start Trail Marker at login", isOn: $viewModel.startAtLogin)
                .toggleStyle(.switch)

            VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.group) {
                Text("Permissions")
                    .font(.headline)
                Text(
                    ObservationStatement.current(
                        focusEnabled: PreferencesStore().focusConsent,
                        watchEntireDesktop: PreferencesStore().focusWatchEntireDesktop
                    )
                )
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                PermissionRow(
                    symbol: "accessibility",
                    name: "Accessibility",
                    scope: ObservationStatement.accessibilityScope,
                    state: permissions.accessibility
                ) {
                    permissions.requestAccessibility()
                }
                PermissionRow(
                    symbol: "rectangle.inset.filled.and.person.filled",
                    name: "Screen Recording",
                    scope: "Needed for future screen-aware features.",
                    state: permissions.screenRecording
                ) {
                    permissions.requestScreenRecording()
                }

                Button("Skip for Now") {
                    viewModel.skipPermissions()
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }

            Button("Continue") {
                viewModel.finishDeviceSetup()
            }
            .buttonStyle(.borderedProminent)
            .tint(TrailMarkerTokens.Color.forest)
        }
        .padding(TrailMarkerTokens.Spacing.major)
        .frame(width: OnboardingFlow.contentWidth, alignment: .leading)
        .onAppear { permissions.refresh() }
    }
}

private struct PermissionRow: View {
    let symbol: String
    let name: String
    let scope: String
    let state: PermissionState
    let grant: () -> Void

    var body: some View {
        HStack(spacing: TrailMarkerTokens.Spacing.group) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.body)
                Text(scope)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Text(state == .granted ? "Granted" : "Not granted")
                .font(.callout)
                .foregroundStyle(state == .granted ? Color(nsColor: .systemGreen) : .secondary)
                .accessibilityLabel("\(name): \(state == .granted ? "Granted" : "Not granted")")

            if state != .granted {
                Button("Grant Access", action: grant)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }
}
