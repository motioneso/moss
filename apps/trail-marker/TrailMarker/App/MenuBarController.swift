import AppKit

/// Owns the menu-bar status item and hands its menu's content to `StatusMenu`, which keeps it
/// in sync with `ConnectionRuntime`.
@MainActor
final class MenuBarController {
    private let statusItem: NSStatusItem
    private let statusMenu: StatusMenu

    init(
        connection: ConnectionRuntime,
        onOpenSettings: @escaping () -> Void,
        onOpenOnboarding: @escaping () -> Void,
        onCheckForUpdates: @escaping () -> Void
    ) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            let mark = NSImage(named: "MenuBarMark")
            mark?.isTemplate = true
            button.image = mark
            button.setAccessibilityLabel("Trail Marker")
        }

        statusMenu = StatusMenu(
            connection: connection, onOpenSettings: onOpenSettings, onOpenOnboarding: onOpenOnboarding,
            onCheckForUpdates: onCheckForUpdates
        )
        statusItem.menu = statusMenu.menu
    }
}
