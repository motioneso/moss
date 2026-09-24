#if DEBUG
import SwiftUI

/// Settings → Backtrack (mockup B), with Phase 1's truthful copy (plan §4.4): a Debug preview that
/// keeps text in memory on this Mac only. Nothing here offers to open Moss, because nothing is
/// stored there yet.
struct BacktrackPane: View {
    @ObservedObject var backtrack: BacktrackRuntime
    @ObservedObject var permissions: PermissionsService
    let onEditNeverWatch: () -> Void
    /// Opens the window of remembered text; nil where there is no ring to show (the UI harness).
    var onShowText: (() -> Void)?

    @State private var showingConsent = false

    var body: some View {
        Form {
            Section("Backtrack") {
                Toggle(
                    "Remember what's on my screen",
                    isOn: Binding(
                        get: { backtrack.enabled },
                        set: { on in
                            if on && backtrack.consentGiven < BacktrackRuntime.consentVersion {
                                showingConsent = true
                            } else {
                                backtrack.setEnabled(on)
                            }
                        }
                    )
                )
                .accessibilityIdentifier("backtrack.enabled")
                Text(
                    "Debug preview. Reads the window in front of you and keeps the text in memory on this Mac "
                        + "only. Nothing is sent to Moss yet."
                )
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

            if let onShowText {
                Section("What's remembered") {
                    HStack {
                        Text("The text Backtrack kept, newest first. In memory only.")
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
        .onAppear { permissions.refresh() }
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

    private var statusLine: String {
        if !backtrack.enabled { return "Off" }
        if backtrack.isRecording { return "Recording on this Mac only" }
        if !backtrack.menuSwitchOn { return "Paused from the menu" }
        return "Not recording right now"
    }
}

/// The one-time consent (mockup C), with Phase 1's storage sentence. Mockup C's final copy ships
/// only when text is stored in Moss (plan §4.4).
struct BacktrackConsentSheet: View {
    let onTurnOn: () -> Void
    let onNotNow: () -> Void

    private let points = [
        "Reads the words in the window in front of you, at most every 10 seconds while it changes. "
            + "Never pictures, sound or typing.",
        "That includes messages people send you and pages you read.",
        "Keys, card numbers and codes Trail Marker can recognise are removed first, and password fields "
            + "are never read.",
        "Kept in memory on this Mac, and cleared when Trail Marker quits. Nothing is sent to Moss.",
        "Apps on your Never watch list and private windows are skipped."
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.row) {
            Text("Turn on Backtrack?").font(.title3.weight(.semibold))
            Text("Backtrack helps you find what you saw earlier. This is a Debug preview.")
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
#endif
