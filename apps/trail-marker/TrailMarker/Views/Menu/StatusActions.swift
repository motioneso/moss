import AppKit

/// What each item in the status card does. Kept apart from the card so the card stays a plain
/// view of `MenuModel` and the actions stay in one place.
@MainActor
final class StatusActions {
    private let connection: ConnectionRuntime
    private let onShowLastJudgment: () -> Void
    private let onOpenSettings: () -> Void
    private let onOpenOnboarding: () -> Void

    init(
        connection: ConnectionRuntime,
        onShowLastJudgment: @escaping () -> Void,
        onOpenSettings: @escaping () -> Void,
        onOpenOnboarding: @escaping () -> Void
    ) {
        self.connection = connection
        self.onShowLastJudgment = onShowLastJudgment
        self.onOpenSettings = onOpenSettings
        self.onOpenOnboarding = onOpenOnboarding
    }

    func perform(_ role: MenuItemDescriptor.Role) {
        switch role {
        case .status, .focusStatus, .instanceInfo:
            break
        case .lastJudgment:
            onShowLastJudgment()
        case .primaryAction:
            performPrimaryAction()
        case .openMoss:
            connection.openInstanceInBrowser()
        case .settings:
            onOpenSettings()
        case .logOut:
            confirmLogOut()
        case .quit:
            connection.send(.userQuit)
            NSApp.terminate(nil)
        }
    }

    private func performPrimaryAction() {
        switch connection.state {
        case .connected:
            connection.send(.userDisconnect)
        case .disconnected:
            connection.send(.userConnect)
        case .reconnecting:
            connection.send(.userRetry)
        case .signInRequired, .notLinked:
            // The old credential is gone; signing in means linking again through the browser.
            onOpenOnboarding()
        }
    }

    /// Log Out asks for confirmation (guide §9); Pause (disconnect) does not (§7 "not destructive").
    private func confirmLogOut() {
        let alert = NSAlert()
        alert.messageText = "Log out of this Moss account?"
        alert.informativeText = "Trail Marker will remove this Mac's credential and try to notify Moss."
        alert.addButton(withTitle: "Log Out")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.first?.hasDestructiveAction = true

        if alert.runModal() == .alertFirstButtonReturn {
            connection.send(.userLogout)
        }
    }
}
