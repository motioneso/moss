import SwiftUI

/// Settings → Backtrack (mockup B, phase 2 plan §5.1): text is sent to Moss and kept there. A
/// Release build shows this pane only once Moss has said it stores Backtrack.
struct BacktrackPane: View {
    @ObservedObject var backtrack: BacktrackRuntime
    @ObservedObject var permissions: PermissionsService
    /// Nil where nothing is sent (the UI harness).
    var uploader: BacktrackUploader?
    let onEditNeverWatch: () -> Void
    /// Opens Settings → Modules → Backtrack in Moss; nil where there is no linked Moss.
    var onOpenInMoss: (() -> Void)?
    /// Opens the window of remembered text, Debug builds only; nil where there is no ring to show.
    var onShowText: (() -> Void)?

    @State private var showingConsent = false

    var body: some View {
        Form {
            Section("Backtrack") {
                Toggle(
                    "Remember what's on my screen",
                    isOn: Binding(
                        get: { backtrack.enabled && !backtrack.needsConsent },
                        set: { on in
                            if on && backtrack.consentGiven < backtrack.requiredConsentVersion {
                                showingConsent = true
                            } else {
                                backtrack.setEnabled(on)
                            }
                        }
                    )
                )
                .accessibilityIdentifier("backtrack.enabled")
                Text(Self.explanation)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            Section("Status") {
                HStack {
                    Circle()
                        .fill(backtrack.isRecording ? TrailMarkerTokens.Color.gold : Color.secondary.opacity(0.4))
                        .frame(width: 8, height: 8)
                    Text(statusLine)
                }
                if let uploader, backtrack.enabled, !backtrack.needsConsent {
                    BacktrackSendStatus(uploader: uploader)
                }
                if backtrack.enabled && permissions.accessibility != .granted {
                    HStack {
                        Text("Needs Accessibility to find the window in front and its password fields.")
                            .font(.callout)
                        Spacer()
                        Button("Open System Settings…") {
                            permissions.requestAccessibility()
                            SystemSettingsLinks.openAccessibility()
                        }
                    }
                }
                if backtrack.enabled && permissions.screenRecording != .granted {
                    HStack {
                        Text("Needs Screen Recording to read the window's text.")
                            .font(.callout)
                        Spacer()
                        Button("Open System Settings…") {
                            permissions.requestScreenRecording()
                            SystemSettingsLinks.openScreenRecording()
                        }
                    }
                }
            }

            if let onOpenInMoss {
                Section("In Moss") {
                    HStack {
                        Text("Pause Backtrack for all your Macs, see what's kept and delete it in Moss.")
                            .font(.callout)
                        Spacer()
                        Button("Open in Moss…", action: onOpenInMoss)
                            .accessibilityIdentifier("backtrack.openInMoss")
                    }
                }
            }

            if let onShowText {
                Section("What's remembered (debug build)") {
                    HStack {
                        Text("The last 200 segments, newest first, kept in memory on this Mac too.")
                            .font(.callout)
                        Spacer()
                        Button("Show text…", action: onShowText)
                            .accessibilityIdentifier("backtrack.showText")
                    }
                }
            }

            Section("Never watch") {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Same list as Focus")
                        Text("Your Never watch apps, password managers, private windows and password fields.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Edit in Focus…", action: onEditNeverWatch)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            permissions.refresh()
            // A consent from before text was sent to Moss doesn't cover sending: ask again.
            if backtrack.needsConsent { showingConsent = true }
        }
        .sheet(isPresented: $showingConsent) {
            BacktrackConsentSheet(
                onTurnOn: {
                    showingConsent = false
                    backtrack.acceptConsent()
                },
                onNotNow: { showingConsent = false }
            )
        }
    }

    static let explanation = "Reads the window in front of you and sends the text to your Moss, where only you can "
        + "see it. Kept 37 days, plus up to one hourly run. Delete any of it from Moss at any time."

    private var statusLine: String {
        if !backtrack.enabled { return "Off" }
        if backtrack.needsConsent { return "Off until you agree to sending text to Moss" }
        switch backtrack.storageAvailability {
        case .paused: return "Paused from Moss"
        case .unavailable: return "Moss isn't storing Backtrack, so nothing is recorded"
        case .ready: break
        }
        if backtrack.isRecording { return "Recording" }
        if !backtrack.menuSwitchOn { return "Paused from the menu" }
        return "Not recording right now"
    }
}

/// "Last sent …" and the clock warning, from the uploader's own record.
private struct BacktrackSendStatus: View {
    @ObservedObject var uploader: BacktrackUploader

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(sentLine).font(.callout).foregroundStyle(.secondary)
            if uploader.clockLooksWrong {
                Text("This Mac's clock looks wrong. Set the date and time correctly so Moss can keep what it reads.")
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var sentLine: String {
        let waiting = uploader.pendingCount > 0 ? " · \(uploader.pendingCount) waiting on this Mac" : ""
        guard let last = uploader.lastSentAt else { return "Nothing sent since Trail Marker started\(waiting)" }
        return "Last sent \(last.formatted(date: .omitted, time: .shortened))\(waiting)"
    }
}

/// The one-time consent (mockup C), version 2: text is sent to Moss and kept there.
struct BacktrackConsentSheet: View {
    let onTurnOn: () -> Void
    let onNotNow: () -> Void

    private let points = [
        "Reads the words in the window in front of you, at most every 10 seconds while it changes. "
            + "Never pictures, sound or typing.",
        "That includes messages people send you and pages you read.",
        "Keys, card numbers and codes Trail Marker can recognise are removed on this Mac first, and password "
            + "fields are never read.",
        "Sent to your Moss and kept there 37 days, plus up to one hourly run. If Moss can't be reached, "
            + "it waits on this Mac, encrypted, for up to a day.",
        "Apps on your Never watch list and private windows are skipped.",
        "Only you can see it. Delete any of it from Moss at any time."
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.row) {
            Text("Turn on Backtrack?").font(.title3.weight(.semibold))
            Text("Backtrack helps Moss remember your day so you can ask about it later.")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(points, id: \.self) { point in
                    HStack(alignment: .top, spacing: 6) {
                        Text("•")
                        Text(point).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            HStack {
                Spacer()
                Button("Not now", action: onNotNow)
                    .keyboardShortcut(.cancelAction)
                Button("Turn on", action: onTurnOn)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("backtrack.consent.turnOn")
            }
        }
        .padding(TrailMarkerTokens.Spacing.section)
        .frame(width: 460)
    }
}
