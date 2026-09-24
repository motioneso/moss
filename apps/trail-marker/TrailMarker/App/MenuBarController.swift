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
    /// A small gold dot over the template mark while a feature is recording (Backtrack, spec §4:
    /// it is never on silently). A subview, so the mark itself keeps its template tinting.
    private let recordingDot = NSView()

    init(
        connection: ConnectionRuntime,
        focus: FocusRuntime,
        onShowLastJudgment: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onOpenOnboarding: @escaping () -> Void,
        feature: FeatureSwitchState? = nil
    ) {
        let feature = feature ?? FeatureSwitchState()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        actions = StatusActions(
            connection: connection, onShowLastJudgment: onShowLastJudgment,
            onOpenSettings: onOpenSettings, onOpenOnboarding: onOpenOnboarding
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

            recordingDot.wantsLayer = true
            recordingDot.layer?.backgroundColor = NSColor(TrailMarkerTokens.Color.gold).cgColor
            recordingDot.layer?.cornerRadius = 3
            recordingDot.isHidden = true
            recordingDot.frame = NSRect(x: button.bounds.width - 8, y: button.bounds.height - 8, width: 6, height: 6)
            recordingDot.autoresizingMask = [.minXMargin, .minYMargin]
            button.addSubview(recordingDot)
        }
        feature.$showsRecordingDot
            .receive(on: DispatchQueue.main)
            .sink { [weak self] on in self?.recordingDot.isHidden = !on }
            .store(in: &cancellables)

        keepToolTipInSync(with: focus)

        popover.behavior = .transient
        let hosting = NSHostingController(
            rootView: StatusCardView(
                connection: connection,
                focus: focus,
                feature: feature,
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
