import AppKit
import SwiftUI

/// Design guide §11 "This Mac".
struct ThisMacPane: View {
    @ObservedObject var connection: ConnectionRuntime
    let loginItem: any LoginItemManaging

    @State private var deviceName: String = ""
    @State private var loginItemState = LoginItemState()

    var body: some View {
        Form {
            Section("Device name") {
                TextField("This Mac", text: $deviceName)
                    .onSubmit { rename() }
                    .disabled(connection.identity == nil)
            }

            Section("Login item") {
                Toggle("Start Trail Marker at login", isOn: Binding(
                    get: { loginItemState.isEnabled },
                    set: { loginItemState.setEnabled($0, using: loginItem) }
                ))

                Text(loginItemState.statusMessage)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let error = loginItemState.errorMessage {
                    Text(error)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if loginItemState.showsSystemSettings {
                    Button("Open System Settings…") {
                        loginItem.openSystemSettings()
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            deviceName = connection.displayName ?? ""
            loginItemState.refresh(using: loginItem)
        }
        // AppDelegate hosts this pane manually, so use the app signal rather than scenePhase.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            loginItemState.refresh(using: loginItem)
        }
    }

    private func rename() {
        let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        connection.rename(displayName: trimmed)
    }
}
