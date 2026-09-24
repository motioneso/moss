import SwiftUI

enum SettingsSection: String, CaseIterable, Identifiable {
    case connection = "Connection"
    case thisMac = "This Mac"
    case focus = "Focus"
    #if DEBUG
    /// Backtrack's Phase 1 preview, Debug builds only (plan §4.4).
    case backtrack = "Backtrack"
    #endif
    case permissions = "Permissions"
    case updates = "Updates"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .connection: return "network"
        case .thisMac: return "laptopcomputer"
        case .focus: return "scope"
        #if DEBUG
        case .backtrack: return "clock.arrow.circlepath"
        #endif
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
    #if DEBUG
    var backtrack: BacktrackRuntime?
    #endif

    @State private var selection: SettingsSection? = .connection
    @State private var autoCheckUpdates = PreferencesStore().autoCheckUpdates

    var body: some View {
        NavigationSplitView {
            List(SettingsSection.allCases, selection: $selection) { section in
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
            #if DEBUG
            case .backtrack:
                if let backtrack {
                    BacktrackPane(backtrack: backtrack, permissions: permissions, onEditNeverWatch: { selection = .focus })
                } else {
                    Text("Not available in this build.").foregroundStyle(.secondary)
                }
            #endif
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
