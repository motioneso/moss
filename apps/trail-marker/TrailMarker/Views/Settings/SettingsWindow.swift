import SwiftUI

enum SettingsSection: String, CaseIterable, Identifiable {
    case connection = "Connection"
    case thisMac = "This Mac"
    case focus = "Focus"
    /// Shown in Release only once Moss has said it stores Backtrack (phase 2 plan §5.1).
    case backtrack = "Backtrack"
    case permissions = "Permissions"
    case updates = "Updates"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .connection: return "network"
        case .thisMac: return "laptopcomputer"
        case .focus: return "scope"
        case .backtrack: return "clock.arrow.circlepath"
        case .permissions: return "hand.raised"
        case .updates: return "arrow.triangle.2.circlepath"
        }
    }
}

/// One native settings window with sidebar navigation (design guide §11).
struct SettingsWindow: View {
    @ObservedObject var connection: ConnectionRuntime
    @ObservedObject var permissions: PermissionsService
    @ObservedObject var focus: FocusRuntime
    @ObservedObject var updater: UpdaterService
    let loginItem: LoginItemService
    let onSetUp: () -> Void
    var backtrack: BacktrackRuntime?
    var uploader: BacktrackUploader?
    var onOpenBacktrackInMoss: (() -> Void)?
    var onShowBacktrackText: (() -> Void)?

    @State private var selection: SettingsSection? = .connection
    @State private var autoCheckUpdates = PreferencesStore().autoCheckUpdates

    private var sections: [SettingsSection] {
        let showsBacktrack = backtrack != nil && BacktrackVisibility.shows(
            isDebugBuild: BacktrackRuntime.isDebugBuild, availability: BacktrackSinkAvailability(connection.backtrackState)
        )
        return SettingsSection.allCases.filter { $0 != .backtrack || showsBacktrack }
    }

    var body: some View {
        NavigationSplitView {
            List(sections, selection: $selection) { section in
                Label(section.rawValue, systemImage: section.symbol).tag(section)
            }
            .navigationSplitViewColumnWidth(
                min: TrailMarkerTokens.Layout.settingsSidebarWidth,
                ideal: TrailMarkerTokens.Layout.settingsSidebarWidth
            )
        } detail: {
            switch selection ?? .connection {
            case .connection:
                ConnectionPane(connection: connection, onSetUp: onSetUp)
            case .thisMac:
                ThisMacPane(connection: connection, loginItem: loginItem)
            case .focus:
                FocusPane(focus: focus, permissions: permissions)
            case .backtrack:
                if let backtrack, sections.contains(.backtrack) {
                    BacktrackPane(
                        backtrack: backtrack, permissions: permissions, uploader: uploader,
                        onEditNeverWatch: { selection = .focus }, onOpenInMoss: onOpenBacktrackInMoss,
                        onShowText: onShowBacktrackText
                    )
                } else {
                    Text("Backtrack isn't available on this Moss.").foregroundStyle(.secondary)
                }
            case .permissions:
                PermissionsPane(permissions: permissions)
            case .updates:
                UpdatesPane(updater: updater, autoCheckUpdates: $autoCheckUpdates)
            }
        }
        .frame(
            width: TrailMarkerTokens.Layout.settingsWidth, height: TrailMarkerTokens.Layout.settingsHeight
        )
        .onChange(of: autoCheckUpdates) { _, newValue in
            let preferences = PreferencesStore()
            preferences.autoCheckUpdates = newValue
            updater.setAutomaticChecksEnabled(newValue && connection.state != .disconnected)
        }
    }
}
