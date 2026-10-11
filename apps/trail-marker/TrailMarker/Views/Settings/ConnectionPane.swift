import SwiftUI

/// Design guide §11 "Connection". Changing the instance or account requires Log Out first —
/// there is no in-place re-link, only Set Up Trail Marker from Not linked.
struct ConnectionPane: View {
    @ObservedObject var connection: ConnectionRuntime
    let onSetUp: () -> Void

    @State private var showingLogOutConfirmation = false

    var body: some View {
        Form {
            if let identity = connection.identity {
                Section("Instance") {
                    LabeledContent("Address", value: identity.instance.origin.absoluteString)
                    LabeledContent("Account", value: "\(identity.accountName) · \(identity.accountEmail)")
                }

                Section("Status") {
                    LabeledContent("State") {
                        StatusLabel(state: connection.state)
                    }
                    LabeledContent("Last successful contact", value: lastContactText)
                    if let diagnostic = connection.lastDiagnostic {
                        Text(diagnostic).font(.callout).foregroundStyle(.secondary)
                    }
                }

                Section {
                    HStack {
                        Button(MenuModel.primaryActionTitle(for: connection.state)) {
                            performPrimaryAction()
                        }
                        Spacer()
                        Button("Unlink…", role: .destructive) {
                            showingLogOutConfirmation = true
                        }
                    }
                }
            } else {
                Section {
                    Text("Not linked")
                        .font(.headline)
                    Text("Connect this Mac to a Moss account from Trail Marker's onboarding.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Button("Set Up Trail Marker", action: onSetUp)
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog(
            "Unlink this Mac from Moss?", isPresented: $showingLogOutConfirmation, titleVisibility: .visible
        ) {
            Button("Unlink", role: .destructive) {
                connection.send(.userLogout)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Recording stops now. Trail Marker removes this Mac’s saved link only after Moss confirms Unlink.")
        }
    }

    private func performPrimaryAction() {
        switch connection.state {
        case .connected:
            connection.send(.userDisconnect)
        case .disconnected:
            connection.send(.userConnect)
        case .reconnecting, .unlinking:
            connection.send(.userRetry)
        case .signInRequired, .notLinked:
            onSetUp()
        }
    }

    private var lastContactText: String {
        let date: Date?
        switch connection.state {
        case .connected(let lastContact):
            date = lastContact
        case .reconnecting(_, let lastContact):
            date = lastContact
        default:
            date = nil
        }
        guard let date else { return "Never" }
        return date.formatted(.relative(presentation: .named))
    }
}

/// Every status uses a symbol plus text (§2 "State is always explicit") — never color alone.
struct StatusLabel: View {
    let state: ConnectionState

    var body: some View {
        Label(MenuModel.statusTitle(for: state), systemImage: symbolName)
            .foregroundStyle(color)
    }

    private var symbolName: String {
        switch state {
        case .connected: return "checkmark.circle.fill"
        case .disconnected: return "pause.circle.fill"
        case .reconnecting: return "arrow.triangle.2.circlepath"
        case .signInRequired: return "key.fill"
        case .unlinking: return "arrow.triangle.2.circlepath"
        case .notLinked: return "link.circle"
        }
    }

    private var color: Color {
        switch state {
        case .connected: return Color(nsColor: .systemGreen)
        case .disconnected: return Color(nsColor: .secondaryLabelColor)
        case .reconnecting: return Color(nsColor: .systemOrange)
        case .signInRequired: return Color(nsColor: .systemRed)
        case .unlinking: return Color(nsColor: .systemOrange)
        case .notLinked: return Color(nsColor: .tertiaryLabelColor)
        }
    }
}
