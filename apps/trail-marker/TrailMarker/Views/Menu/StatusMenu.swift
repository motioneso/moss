import AppKit
import Combine

/// Builds and keeps the status-bar `NSMenu` in sync with `ConnectionRuntime`, from the pure
/// ordering `MenuModel` derives. Rebuilds the whole menu on every state or identity change
/// rather than diffing — a menu this short makes that the simpler correct choice.
@MainActor
final class StatusMenu: NSObject {
    let menu = NSMenu()

    private let connection: ConnectionRuntime
    private let onOpenSettings: () -> Void
    private let onOpenOnboarding: () -> Void
    private let onCheckForUpdates: () -> Void
    private var cancellables = Set<AnyCancellable>()

    init(
        connection: ConnectionRuntime,
        onOpenSettings: @escaping () -> Void,
        onOpenOnboarding: @escaping () -> Void,
        onCheckForUpdates: @escaping () -> Void
    ) {
        self.connection = connection
        self.onOpenSettings = onOpenSettings
        self.onOpenOnboarding = onOpenOnboarding
        self.onCheckForUpdates = onCheckForUpdates
        super.init()

        // AppKit auto-enables any item with a valid target/action pair unless this is off,
        // which would silently override the disabled status/info rows and a disabled Open Moss.
        menu.autoenablesItems = false

        Publishers.CombineLatest(connection.$state, connection.$identity)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state, identity in
                self?.rebuild(state: state, identity: identity)
            }
            .store(in: &cancellables)

        rebuild(state: connection.state, identity: connection.identity)
    }

    private func rebuild(state: ConnectionState, identity: LinkedIdentity?) {
        menu.removeAllItems()
        for descriptor in MenuModel.items(state: state, identity: identity) {
            switch descriptor.kind {
            case .separator:
                menu.addItem(.separator())
            case .text:
                let item = NSMenuItem(
                    title: descriptor.title, action: #selector(handleItem(_:)), keyEquivalent: ""
                )
                item.target = self
                item.isEnabled = descriptor.isEnabled
                item.representedObject = descriptor.role
                menu.addItem(item)
            }
        }
    }

    @objc private func handleItem(_ sender: NSMenuItem) {
        guard let role = sender.representedObject as? MenuItemDescriptor.Role else { return }
        switch role {
        case .status, .instanceInfo:
            break
        case .primaryAction:
            performPrimaryAction()
        case .openMoss:
            connection.openInstanceInBrowser()
        case .settings:
            onOpenSettings()
        case .checkForUpdates:
            onCheckForUpdates()
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
        case .reconnecting, .signInRequired:
            connection.send(.userRetry)
        case .notLinked:
            onOpenOnboarding()
        }
    }

    /// Log Out asks for confirmation (guide §9); Disconnect does not (§7 "not destructive").
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
