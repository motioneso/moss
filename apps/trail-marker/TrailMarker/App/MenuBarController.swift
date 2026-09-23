import AppKit
import Combine
import SwiftUI

/// Owns the menu-bar status item. Clicking it opens the status card in a popover, as on the
/// approved board, rather than a plain text menu.
@MainActor
final class MenuBarController: NSObject {
    private let statusItem: NSStatusItem
    private let popover = NSPopover()
    private let actions: StatusActions
    private var cancellables = Set<AnyCancellable>()

    init(
        connection: ConnectionRuntime,
        focus: FocusRuntime,
        onShowLastJudgment: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onOpenOnboarding: @escaping () -> Void,
        onCheckForUpdates: @escaping () -> Void
    ) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        actions = StatusActions(
            connection: connection, focus: focus, onShowLastJudgment: onShowLastJudgment,
            onOpenSettings: onOpenSettings, onOpenOnboarding: onOpenOnboarding,
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

        keepToolTipInSync(with: focus)

        popover.behavior = .transient
        let hosting = NSHostingController(
            rootView: StatusCardView(
                connection: connection,
                focus: focus,
                perform: { [actions] role in actions.perform(role) },
                dismiss: { [weak self] in self?.popover.performClose(nil) }
            )
        )
        // The popover follows the card's size as it changes, still hanging from the icon. Without
        // this the card was placed at its first measured height and, when it grew (focus state,
        // goal line), its window grew upward under the menu bar.
        hosting.sizingOptions = [.preferredContentSize]
        popover.contentViewController = hosting
    }

    /// Hovering the icon shows the current goal without opening the card.
    private func keepToolTipInSync(with focus: FocusRuntime) {
        focus.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                let info = FocusMenuInfo(state: focus.state, goalLine: focus.goalLine, hasLastJudgment: false)
                self?.statusItem.button?.toolTip = info.hoverText
            }
            .store(in: &cancellables)
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
