import SwiftUI

/// The one new settings pane (spec §9). Off until the person turns it on; nothing is watched
/// until they also choose at least one app. There is no image model here in slice 1.
struct FocusPane: View {
    @ObservedObject var focus: FocusRuntime
    @ObservedObject var permissions: PermissionsService

    @State private var apps: [InstalledApp] = []
    @State private var search = ""
    @State private var testNudgeNote: String?
    @State private var visionKeyEntry = ""

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
                    notificationsStatus
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

                Section("When a title alone isn't enough") {
                    Toggle(
                        "Take one picture of the screen and describe it",
                        isOn: Binding(get: { focus.rung3Enabled }, set: { focus.setRung3Enabled($0) })
                    )
                    if permissions.screenRecording != .granted {
                        Text("Screen Recording isn't granted, so this can't turn on.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Button("Open System Settings…") {
                            permissions.requestScreenRecording()
                            SystemSettingsLinks.openScreenRecording()
                        }
                    } else if focus.rung3Enabled {
                        Text(rung3ConsentSentence)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        Picker(
                            "Describe with",
                            selection: Binding(get: { focus.visionSource }, set: { focus.setVisionSource($0) })
                        ) {
                            Text("An API key").tag(VisionSource.apiKey)
                            Text("Claude Code, signed in on this Mac").tag(VisionSource.cli)
                        }
                        .pickerStyle(.radioGroup)

                        if focus.visionSource == .apiKey {
                            TextField(
                                "Endpoint URL",
                                text: Binding(get: { focus.visionEndpointURL }, set: { focus.setVisionEndpointURL($0) })
                            )
                            Text("The exact URL to send the request to, such as https://openrouter.ai/api/v1/chat/completions. Nothing is appended to it.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextField(
                                "Model", text: Binding(get: { focus.visionModel }, set: { focus.setVisionModel($0) })
                            )
                            HStack {
                                SecureField("API key", text: $visionKeyEntry)
                                    .onSubmit(saveVisionKeyEntry)
                                Button("Save", action: saveVisionKeyEntry)
                                    .disabled(visionKeyEntry.isEmpty)
                            }
                            Text(focus.hasVisionAPIKey ? "A key is stored." : "No key stored yet.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Uses whatever session Claude Code is signed into on this Mac. No key is stored here.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        // A key still sitting in the field, not yet saved, is tested too — the
                        // person should never see "no key" fail Test right after typing one in.
                        Button("Test") { focus.testVision(enteredAPIKey: visionKeyEntry) }
                        if let visionTestResult = focus.visionTestResult {
                            switch visionTestResult {
                            case .success(let description):
                                Text(description).font(.callout).fixedSize(horizontal: false, vertical: true)
                            case .failure(let error):
                                Text(visionErrorMessage(error))
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }

                Section("Check that it works") {
                    Button("Send a test nudge") { Task { await sendTestNudge() } }
                    Text("Shows a sample notification, so you can see nudges will reach you.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let testNudgeNote {
                        Text(testNudgeNote)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            permissions.refresh()
            apps = InstalledApps.list()
            Task { await permissions.refreshNotifications() }
        }
        // Coming back from System Settings after changing the answer.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await permissions.refreshNotifications() }
        }
    }

    @ViewBuilder private var notificationsStatus: some View {
        switch permissions.notifications {
        case .allowed:
            EmptyView()
        case .notAsked:
            Text("Trail Marker hasn't asked to show notifications yet, so nudges can't show.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Allow Notifications…") { Task { await permissions.requestNotifications() } }
        case .denied:
            Text("Notifications are off for Trail Marker, so nudges won't show.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Notification Settings…") { SystemSettingsLinks.openNotifications() }
        }
    }

    /// Checks the answer first: a nudge macOS will not show would otherwise vanish without a word.
    private func saveVisionKeyEntry() {
        guard !visionKeyEntry.isEmpty else { return }
        focus.setVisionAPIKey(visionKeyEntry)
        visionKeyEntry = ""
    }

    private func sendTestNudge() async {
        await permissions.refreshNotifications()
        if permissions.notifications == .notAsked { await permissions.requestNotifications() }
        if permissions.notifications == .allowed {
            testNudgeNote = nil
            focus.testNudge()
        } else {
            testNudgeNote = "Notifications are off for Trail Marker, so this test can't show. "
                + "Turn them on in System Settings, then try again."
        }
    }

    /// Rung 3 spec §5: must be literally true for the build running, in the person's chosen
    /// source's own terms — never a generic "an AI model" sentence.
    private var rung3ConsentSentence: String {
        let destination: String
        switch focus.visionSource {
        case .apiKey:
            let host = focus.visionEndpointURL.isEmpty ? "the endpoint you set below" : focus.visionEndpointURL
            destination = host
        case .cli:
            destination = "Claude Code, signed in on this Mac"
        }
        return "When Trail Marker can't tell from the window title alone, it will take one picture "
            + "of an allowed app and send it to \(destination) to describe. The picture is never "
            + "saved and never sent anywhere else."
    }

    private func visionErrorMessage(_ error: VisionError) -> String {
        switch error {
        case .notConfigured:
            return focus.visionSource == .cli
                ? "Claude Code wasn't found or isn't signed in on this Mac."
                : "Enter a base URL, model and API key first."
        case .unreachable:
            return "Couldn't reach the vision source. Try again."
        case .rejected:
            return "The vision source rejected the API key."
        case .invalidResponse:
            return "The vision source didn't answer with a usable description."
        case .noAppToCapture:
            return "Trail Marker hasn't seen another app in front yet. Switch to one, then come back and test."
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
