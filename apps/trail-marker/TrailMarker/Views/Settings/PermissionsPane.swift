import SwiftUI

/// Design guide §11 "Permissions". Status only (Granted / Not granted) — recovery for a denied
/// permission goes through System Settings, since the app cannot re-prompt once denied.
struct PermissionsPane: View {
    @ObservedObject var permissions: PermissionsService

    var body: some View {
        Form {
            Section {
                Text("These permissions prepare future capabilities. Trail Marker is not observing your activity.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section("Permissions") {
                PermissionSettingsRow(
                    symbol: "accessibility", name: "Accessibility",
                    scope: "Needed for future shortcuts and automation.",
                    state: permissions.accessibility,
                    openSystemSettings: {
                        // Asking once registers Trail Marker in the list; macOS shows no
                        // entry to switch on until an app has asked.
                        if permissions.accessibility != .granted { permissions.requestAccessibility() }
                        SystemSettingsLinks.openAccessibility()
                    }
                )
                PermissionSettingsRow(
                    symbol: "rectangle.inset.filled.and.person.filled", name: "Screen Recording",
                    scope: "Needed for future screen-aware features.",
                    state: permissions.screenRecording,
                    openSystemSettings: {
                        if permissions.screenRecording != .granted { permissions.requestScreenRecording() }
                        SystemSettingsLinks.openScreenRecording()
                    }
                )
            }
        }
        .formStyle(.grouped)
        .onAppear { permissions.refresh() }
    }
}

private struct PermissionSettingsRow: View {
    let symbol: String
    let name: String
    let scope: String
    let state: PermissionState
    let openSystemSettings: () -> Void

    var body: some View {
        HStack(spacing: TrailMarkerTokens.Spacing.group) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                Text(scope)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Text(state == .granted ? "Granted" : "Not granted")
                .foregroundStyle(state == .granted ? Color(nsColor: .systemGreen) : .secondary)
                .accessibilityLabel("\(name): \(state == .granted ? "Granted" : "Not granted")")

            Button("Open System Settings…", action: openSystemSettings)
        }
    }
}
