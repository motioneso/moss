import Foundation

/// A menu-independent description of what the status-bar menu should contain for a given
/// connection state. `StatusMenu` turns this into a real `NSMenu`; keeping the derivation pure
/// here means the menu's content and order are testable without building any AppKit objects.
struct MenuItemDescriptor: Equatable {
    enum Kind: Equatable {
        case text
        case separator
    }

    /// What an item does, so `StatusMenu` can wire actions without matching on display text.
    enum Role: Equatable {
        case status
        case instanceInfo
        case primaryAction
        case openMoss
        case settings
        case checkForUpdates
        case logOut
        case quit
    }

    var kind: Kind = .text
    var title: String = ""
    var role: Role = .status
    var isEnabled: Bool = true
    var isDestructive: Bool = false

    static let separator = MenuItemDescriptor(kind: .separator)

    static func item(
        _ title: String, role: Role, enabled: Bool = true, destructive: Bool = false
    ) -> MenuItemDescriptor {
        MenuItemDescriptor(kind: .text, title: title, role: role, isEnabled: enabled, isDestructive: destructive)
    }
}

/// Menu order per the design guide (§10): status summary; connected instance and account; the
/// state-specific primary action; Open Moss; Settings…; Check for Updates…; Log Out… (only when
/// linked); Quit. Separators fall between the status group, the navigation/action group, the
/// account-action group, and Quit.
enum MenuModel {
    static func statusTitle(for state: ConnectionState) -> String {
        switch state {
        case .connected: return "Connected"
        case .disconnected: return "Disconnected"
        case .reconnecting: return "Reconnecting"
        case .signInRequired: return "Sign-in required"
        case .notLinked: return "Not linked"
        }
    }

    static func primaryActionTitle(for state: ConnectionState) -> String {
        switch state {
        case .connected: return "Disconnect"
        case .disconnected: return "Connect"
        case .reconnecting: return "Retry Now"
        case .signInRequired: return "Sign In"
        case .notLinked: return "Set Up Trail Marker"
        }
    }

    static func items(state: ConnectionState, identity: LinkedIdentity?) -> [MenuItemDescriptor] {
        var items: [MenuItemDescriptor] = [.item(statusTitle(for: state), role: .status, enabled: false)]

        if let identity {
            items.append(.item(identity.instance.origin.host ?? "", role: .instanceInfo, enabled: false))
            items.append(.item(identity.accountEmail, role: .instanceInfo, enabled: false))
        }

        items.append(.separator)
        items.append(.item(primaryActionTitle(for: state), role: .primaryAction))
        items.append(.item("Open Moss", role: .openMoss, enabled: identity != nil))
        items.append(.item("Settings…", role: .settings))
        items.append(.item("Check for Updates…", role: .checkForUpdates))

        if identity != nil {
            items.append(.separator)
            items.append(.item("Log Out…", role: .logOut, destructive: true))
        }

        items.append(.separator)
        items.append(.item("Quit Trail Marker", role: .quit))

        return items
    }
}
