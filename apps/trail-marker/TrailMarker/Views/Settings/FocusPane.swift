import SwiftUI

/// The one new settings pane (spec §9). Off until the person turns it on; nothing is watched
/// until they also choose at least one app. There is no image model here in slice 1.
struct FocusPane: View {
    @ObservedObject var focus: FocusRuntime
    @ObservedObject var permissions: PermissionsService

    @State private var apps: [InstalledApp] = []
    @State private var search = ""

    var body: some View {
        Form {
            Section {
                Toggle(
                    "Watch which app is in front while a Moss block is on",
                    isOn: Binding(get: { focus.consent }, set: { focus.setConsent($0) })
                )
                Text(ObservationStatement.current(focusEnabled: true, paused: focus.paused))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if focus.consent {
                Section("Status") {
                    Label(statusText, systemImage: statusSymbol)
                        .fixedSize(horizontal: false, vertical: true)
                    if permissions.accessibility != .granted {
                        Text("Accessibility isn't granted, so nothing is sent yet.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Button("Open System Settings…") {
                            permissions.requestAccessibility()
                            SystemSettingsLinks.openAccessibility()
                        }
                    }
                    Button(focus.paused ? "Resume Focus" : "Pause Focus") {
                        if focus.paused { focus.resume() } else { focus.pause() }
                    }
                }

                Section("Apps to watch") {
                    if focus.allowedBundleIds.isEmpty {
                        Text("Choose at least one app. Nothing is watched until you do.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    TextField("Search apps", text: $search)
                    if visibleApps.isEmpty {
                        Text("No apps found.").foregroundStyle(.secondary)
                    }
                    ForEach(visibleApps) { app in
                        Toggle(
                            app.name,
                            isOn: Binding(
                                get: { focus.allowedBundleIds.contains(app.bundleId) },
                                set: { focus.setAllowed(app.bundleId, allowed: $0) }
                            )
                        )
                    }
                }

                Section("Check that it works") {
                    Button("Send a test nudge") { focus.testNudge() }
                    Text("Shows a sample notification, so you can see nudges will reach you.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            permissions.refresh()
            apps = InstalledApps.list()
        }
    }

    private var visibleApps: [InstalledApp] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return apps }
        return apps.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    private var statusText: String {
        let info = FocusMenuInfo(state: focus.state, goalLine: focus.goalLine, hasLastJudgment: false)
        switch focus.state {
        case .off: return "Focus is off."
        case .watching: return info.statusLine ?? "Watching"
        case .paused: return "Paused. Nothing is sent until you resume."
        case .noBlock:
            return "No Moss calendar block is on right now. Trail Marker only watches during blocks Moss created."
        case .unreachable: return "Can't reach Moss. Trail Marker will try again shortly."
        case .notReady:
            return "Judgment isn't set up on your Moss. Ask the admin to choose a model under Settings → AI."
        }
    }

    private var statusSymbol: String {
        switch focus.state {
        case .off: return "circle"
        case .watching: return "checkmark.circle.fill"
        case .paused: return "pause.circle.fill"
        case .noBlock: return "calendar"
        case .unreachable: return "exclamationmark.circle.fill"
        case .notReady: return "wrench.and.screwdriver"
        }
    }
}
