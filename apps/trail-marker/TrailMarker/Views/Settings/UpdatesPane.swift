import SwiftUI

/// Design guide §11 "Updates". Sparkle's own standard user driver shows the available-update
/// summary, install/restart and failure sheets (§10) — this pane only surfaces the version,
/// the toggle, and Check Now.
struct UpdatesPane: View {
    @ObservedObject var updater: UpdaterService
    @Binding var autoCheckUpdates: Bool

    private var installedVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Installed version", value: installedVersion)
            }

            if updater.isDistributionBuild {
                Section {
                    Toggle("Automatically check for updates", isOn: $autoCheckUpdates)
                    Button("Check Now") {
                        updater.checkForUpdates()
                    }
                    .disabled(!updater.canCheckForUpdates)
                }
            } else {
                Section {
                    Text("Development build. Updates come with the public release.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Button("Check Now") {}
                        .disabled(true)
                }
            }
        }
        .formStyle(.grouped)
    }
}
