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
                }

                Section {
                    HStack {
                        Button(MenuModel.primaryActionTitle(for: connection.state)) {
                            performPrimaryAction()
                        }
                        Spacer()
                        Button("Log Out…", role: .destructive) {
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
                        .tint(TrailMarkerTokens.Color.forest)
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog(
            "Log out of this Moss account?", isPresented: $showingLogOutConfirmation, titleVisibility: .visible
        ) {
            Button("Log Out", role: .destructive) {
                connection.send(.userLogout)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Trail Marker will remove this Mac's credential and try to notify Moss.")
        }
    }

    private func performPrimaryAction() {
        switch connection.state {
        case .connected:
            connection.send(.userDisconnect)
        case .disconnected:
            connection.send(.userConnect)
        case .reconnecting, .signInRequired:
            connection.send(.userRetry)
        case .notLinked:
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
        case .notLinked: return "link.circle"
        }
    }

    private var color: Color {
        switch state {
        case .connected: return Color(nsColor: .systemGreen)
        case .disconnected: return Color(nsColor: .secondaryLabelColor)
        case .reconnecting: return Color(nsColor: .systemOrange)
        case .signInRequired: return Color(nsColor: .systemRed)
        case .notLinked: return Color(nsColor: .tertiaryLabelColor)
        }
    }
}
