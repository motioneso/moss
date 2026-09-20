import AppKit

/// Owns the menu-bar status item. Task 10 scope: show the monochrome mark and a Quit item only.
/// The state-driven menu (Views/Menu/StatusMenu.swift) replaces the menu contents in Task 13.
final class MenuBarController {
    private let statusItem: NSStatusItem

    init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            let mark = NSImage(named: "MenuBarMark")
            mark?.isTemplate = true
            button.image = mark
            button.setAccessibilityLabel("Trail Marker")
        }

        let menu = NSMenu()
        menu.addItem(
            NSMenuItem(
                title: "Quit Trail Marker",
                action: #selector(NSApplication.terminate(_:)),
                keyEquivalent: "q"
            )
        )
        statusItem.menu = menu
    }
}
