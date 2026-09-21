import AppKit
import SwiftUI

/// Owns the menu-bar status item. Clicking it opens the status card in a popover, as on the
/// approved board, rather than a plain text menu.
@MainActor
final class MenuBarController: NSObject {
    private let statusItem: NSStatusItem
    private let popover = NSPopover()
    private let actions: StatusActions

    init(
        connection: ConnectionRuntime,
        onOpenSettings: @escaping () -> Void,
        onOpenOnboarding: @escaping () -> Void,
        onCheckForUpdates: @escaping () -> Void
    ) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        actions = StatusActions(
            connection: connection, onOpenSettings: onOpenSettings, onOpenOnboarding: onOpenOnboarding,
            onCheckForUpdates: onCheckForUpdates
        )
        super.init()

        if let button = statusItem.button {
            let mark = NSImage(named: "MenuBarMark")
            mark?.isTemplate = true
            button.image = mark
            button.setAccessibilityLabel("Trail Marker")
            button.toolTip = "Trail Marker"
            button.target = self
            button.action = #selector(togglePopover(_:))
        }

        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: StatusCardView(
                connection: connection,
                perform: { [actions] role in actions.perform(role) },
                dismiss: { [weak self] in self?.popover.performClose(nil) }
            )
        )
    }

    @objc private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}
