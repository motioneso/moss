import SwiftUI

/// The one new settings pane (spec §9). Off until the person turns it on; nothing is watched
/// until they also choose at least one app. There is no image model here in slice 1.
struct FocusPane: View {
    @ObservedObject var focus: FocusRuntime
    @ObservedObject var permissions: PermissionsService

    @State private var apps: [InstalledApp] = []
    @State private var search = ""
    @State private var isAddingExcluded = false
    @State private var excludedSearch = ""
    @State private var isAddingApp = false
    @State private var testNudgeNote: String?
    @State private var visionKeyEntry = ""

    var body: some View {
        Form {
            Section {
                Toggle(
                    "Watch which app is in front while a Moss block is on",
                    isOn: Binding(get: { focus.consent }, set: { focus.setConsent($0) })
                )
                Text(
                    ObservationStatement.current(
                        focusEnabled: true, watchEntireDesktop: focus.watchEntireDesktop
                    )
                )
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
                }

                Section("Apps to watch") {
                    Toggle(
                        "Watch the entire desktop",
                        isOn: Binding(get: { focus.watchEntireDesktop }, set: { focus.setWatchEntireDesktop($0) })
                    )
                    Text(
                        focus.watchEntireDesktop
                            ? "Every app is watched — getting distracted rarely stays inside one app. "
                                + "The apps Trail Marker always excludes (password managers, private-browsing "
                                + "windows) are still never watched."
                            : "Off watches only the apps you choose below."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                    if !focus.watchEntireDesktop {
                        if chosenApps.isEmpty && !isAddingApp {
                            Text("Choose at least one app, or watch the entire desktop above. Nothing is watched until you do.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(chosenApps) { app in
                            HStack {
                                Text(app.name)
                                Spacer()
                                Button {
                                    focus.setAllowed(app.bundleId, allowed: false)
                                } label: {
                                    Image(systemName: "minus.circle")
                                }
                                .buttonStyle(.borderless)
                                .help("Stop watching \(app.name)")
                            }
                        }

                        if isAddingApp {
                            TextField("Search apps", text: $search)
                            if addableApps.isEmpty {
                                Text(search.isEmpty ? "No more apps to add." : "No apps found.")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(addableApps) { app in
                                Button(app.name) { focus.setAllowed(app.bundleId, allowed: true) }
                            }
                            Button("Done") {
                                isAddingApp = false
                                search = ""
                            }
                        } else {
                            Button("Add app…") { isAddingApp = true }
                        }
                    }
                }

                Section("Never watch") {
                    Text(
                        "Nothing about these apps leaves this Mac — no picture, no window title, not even "
                            + "the app's name — even when the entire desktop is watched. Password managers "
                            + "and private-browsing windows are always excluded too."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                    ForEach(excludedApps) { app in
                        HStack {
                            Text(app.name)
                            Spacer()
                            Button {
                                focus.setExcluded(app.bundleId, excluded: false)
                            } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.borderless)
                            .help("Stop excluding \(app.name)")
                        }
                    }

                    if isAddingExcluded {
                        TextField("Search apps", text: $excludedSearch)
                        if excludableApps.isEmpty {
                            Text(excludedSearch.isEmpty ? "No more apps to add." : "No apps found.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(excludableApps) { app in
                            Button(app.name) { focus.setExcluded(app.bundleId, excluded: true) }
                        }
                        Button("Done") {
                            isAddingExcluded = false
                            excludedSearch = ""
                        }
                    } else {
                        Button("Exclude app…") { isAddingExcluded = true }
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
                                "Base URL",
                                text: Binding(get: { focus.visionBaseURL }, set: { focus.setVisionBaseURL($0) })
                            )
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
                        // What was actually captured, shown so the description can be checked
                        // against it rather than trusted on its own — this view only, never sent
                        // or saved anywhere but the vision source itself.
                        if let capture = focus.visionTestCapture, let nsImage = NSImage(data: capture.image) {
                            Text("Captured from \(capture.appName):")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Image(nsImage: nsImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 360)
                                .border(Color.secondary.opacity(0.3))
                        }
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
            let host = focus.visionBaseURL.isEmpty ? "the endpoint you set below" : focus.visionBaseURL
            destination = host
        case .cli:
            destination = "Claude Code, signed in on this Mac"
        }
        let scope = focus.watchEntireDesktop ? "the app in front" : "an allowed app"
        return "When Trail Marker can't tell from the window title alone, it will take one picture "
            + "of \(scope) and send it to \(destination) to describe. The picture is never "
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
        case .invalidResponse(let detail):
            return "The vision source didn't answer with a usable description (\(detail))."
        case .noAppToCapture:
            return "Trail Marker hasn't seen another app in front yet. Switch to one, then come back and test."
        case .captureFailed(let detail):
            return "Couldn't take the picture (\(detail))."
        case .paused:
            return "Paused: resume to test."
        case .focusOff:
            return "Turn Focus on to test."
        }
    }

    /// The apps the person has chosen, in the order they'll recognize them (by name). A bundle id
    /// no longer found on disk (the app was removed) still shows, by its id, rather than silently
    /// vanishing from a list that is supposed to say what's watched.
    private var chosenApps: [InstalledApp] {
        installedApps(for: focus.allowedBundleIds)
    }

    /// The apps the person excluded, shown the same way as the chosen apps.
    private var excludedApps: [InstalledApp] {
        installedApps(for: focus.excludedBundleIds)
    }

    private func installedApps(for ids: Set<String>) -> [InstalledApp] {
        ids
            .map { id in apps.first { $0.bundleId == id } ?? InstalledApp(bundleId: id, name: id) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Installed apps not already chosen, narrowed by the add-app search field. Capped so this
    /// never becomes the big always-visible list it replaced; typing narrows it further.
    private var addableApps: [InstalledApp] {
        let query = search.trimmingCharacters(in: .whitespaces)
        let candidates = apps.filter {
            !focus.allowedBundleIds.contains($0.bundleId) && !focus.excludedBundleIds.contains($0.bundleId)
        }
        let matching = query.isEmpty ? candidates : candidates.filter { $0.name.localizedCaseInsensitiveContains(query) }
        return Array(matching.prefix(8))
    }

    /// Installed apps not already excluded, narrowed by the exclude search field. Apps on the
    /// built-in denylist are left out: they are never watched whatever the person picks.
    private var excludableApps: [InstalledApp] {
        let query = excludedSearch.trimmingCharacters(in: .whitespaces)
        let candidates = apps.filter {
            !focus.excludedBundleIds.contains($0.bundleId)
                && !ObservationPolicy.deniedBundleIds.contains($0.bundleId)
        }
        let matching = query.isEmpty ? candidates : candidates.filter { $0.name.localizedCaseInsensitiveContains(query) }
        return Array(matching.prefix(8))
    }

    private var statusText: String {
        let info = FocusMenuInfo(state: focus.state, goalLine: focus.goalLine, hasLastJudgment: false)
        switch focus.state {
        case .off: return "Focus is off."
        case .watching: return info.statusLine ?? "Watching"
        case .noBlock:
            return "No Moss calendar block is on right now. Trail Marker only watches during blocks Moss created."
        case .unreachable:
            if focus.connectionPaused { return "Trail Marker is paused, so nothing is sent. Resume it from the menu." }
            return "Can't reach Moss. Trail Marker will try again shortly."
        case .notReady:
            return "Judgment isn't set up on your Moss. Ask the admin to choose a model under Settings → AI."
        }
    }

    private var statusSymbol: String {
        switch focus.state {
        case .off: return "circle"
        case .watching: return "checkmark.circle.fill"
        case .noBlock: return "calendar"
        case .unreachable: return focus.connectionPaused ? "pause.circle.fill" : "exclamationmark.circle.fill"
        case .notReady: return "wrench.and.screwdriver"
        }
    }
}
