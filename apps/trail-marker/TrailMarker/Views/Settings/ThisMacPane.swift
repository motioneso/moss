import SwiftUI

/// Design guide §11 "This Mac".
struct ThisMacPane: View {
    @ObservedObject var connection: ConnectionRuntime
    let loginItem: LoginItemService

    @State private var deviceName: String = ""
    @State private var startAtLogin = false
    @State private var loginItemRequiresApproval = false

    var body: some View {
        Form {
            Section("Device name") {
                TextField("This Mac", text: $deviceName)
                    .onSubmit { rename() }
                    .disabled(connection.identity == nil)
            }

            Section("Login item") {
                Toggle("Start Trail Marker at login", isOn: $startAtLogin)
                    .onChange(of: startAtLogin) { _, newValue in
                        try? loginItem.setEnabled(newValue)
                        refreshLoginItemStatus()
                    }

                if loginItemRequiresApproval {
                    Button("Open System Settings…") {
                        loginItem.openSystemSettings()
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            deviceName = connection.displayName ?? ""
            startAtLogin = loginItem.isRegistered
            refreshLoginItemStatus()
        }
    }

    private func rename() {
        let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        connection.rename(displayName: trimmed)
    }

    private func refreshLoginItemStatus() {
        loginItemRequiresApproval = loginItem.requiresApproval
    }
}
