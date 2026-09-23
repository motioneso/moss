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
        case focusStatus
        case instanceInfo
        case primaryAction
        case pauseResume
        case lastJudgment
        case openMoss
        case settings
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

/// What the menu needs to know about Focus. The goal is the current Moss calendar block, so the
/// state line carries it ("Watching · Study AI, ends 11:00 AM") rather than a separate row.
struct FocusMenuInfo: Equatable {
    var state: FocusWatchState
    /// "Study AI, ends 11:00 AM"; present only while watching.
    var goalLine: String?
    var hasLastJudgment: Bool

    /// The line under the connection status. Nil when Focus is off.
    var statusLine: String? {
        switch state {
        case .off: return nil
        case .watching: return "Watching · \(goalLine ?? "")"
        case .paused: return "Paused"
        case .noBlock: return "No block right now"
        case .unreachable: return "Can't reach Moss"
        case .notReady: return "Judgment isn't set up on your Moss (ask the admin)"
        }
    }

    /// The menu-bar icon's hover text: the goal when there is one.
    var hoverText: String {
        if case .watching = state, let goalLine { return "Trail Marker: \(goalLine)" }
        return "Trail Marker"
    }

    var isPaused: Bool { state == .paused }
}

extension FocusLabel {
    /// Plain words for the label, shown as the model's note, not as a verdict on the person.
    var displayName: String {
        switch self {
        case .focused: return "On track"
        case .necessaryDetour: return "Necessary detour"
        case .distracted: return "Off track"
        case .insufficientEvidence: return "Not enough to tell"
        }
    }
}

/// Menu order per the design guide (§10): status summary; connected instance and account; the
/// state-specific primary action; Open Moss; Settings…; Log Out… (only when linked); Quit.
/// Checking for updates lives in Settings → Updates, not here. Separators fall between the status group, the navigation/action group, the
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

    static func items(
        state: ConnectionState, identity: LinkedIdentity?, focus: FocusMenuInfo? = nil
    ) -> [MenuItemDescriptor] {
        var items: [MenuItemDescriptor] = [.item(statusTitle(for: state), role: .status, enabled: false)]

        // Focus rows only exist for a linked Mac with Focus turned on.
        let focusOn = identity != nil && focus != nil && focus?.state != .off
        if focusOn, let line = focus?.statusLine {
            items.append(.item(line, role: .focusStatus, enabled: false))
        }

        if let identity {
            items.append(.item(identity.instance.origin.host ?? "", role: .instanceInfo, enabled: false))
            items.append(.item(identity.accountEmail, role: .instanceInfo, enabled: false))
        }

        items.append(.separator)
        items.append(.item(primaryActionTitle(for: state), role: .primaryAction))
        if focusOn, let focus {
            items.append(.item(focus.isPaused ? "Resume Focus" : "Pause Focus", role: .pauseResume))
            if focus.hasLastJudgment {
                items.append(.item("Last Judgment…", role: .lastJudgment))
            }
        }
        items.append(.item("Open Moss", role: .openMoss, enabled: identity != nil))
        items.append(.item("Settings…", role: .settings))

        if identity != nil {
            items.append(.separator)
            items.append(.item("Log Out…", role: .logOut, destructive: true))
        }

        items.append(.separator)
        items.append(.item("Quit Trail Marker", role: .quit))

        return items
    }

    /// How the card lays the same items out: state and goal in the header, one primary button,
    /// then the rows below it. The card draws exactly this and adds nothing of its own.
    struct Card: Equatable {
        var statusTitle: String
        var focusLine: String?
        var primaryTitle: String?
        var rows: [String]
    }

    static func card(state: ConnectionState, identity: LinkedIdentity?, focus: FocusMenuInfo?) -> Card {
        let all = items(state: state, identity: identity, focus: focus)
        let text = all.filter { $0.kind == .text }
        let header: Set<MenuItemDescriptor.Role> = [.status, .focusStatus, .instanceInfo, .primaryAction]
        return Card(
            statusTitle: text.first { $0.role == .status }?.title ?? "",
            focusLine: text.first { $0.role == .focusStatus }?.title,
            primaryTitle: text.first { $0.role == .primaryAction }?.title,
            rows: text.filter { !header.contains($0.role) }.map(\.title)
        )
    }
}
