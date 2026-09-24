import SwiftUI

/// The menu-bar card from the approved board: the mark with a status badge, the state in plain
/// words with one sentence of explanation, one primary action, and the everyday items below.
/// Content and order come from `MenuModel`; this only draws them.
struct StatusCardView: View {
    @ObservedObject var connection: ConnectionRuntime
    @ObservedObject var focus: FocusRuntime
    /// A second feature's switch (Backtrack in Debug builds); empty otherwise.
    @ObservedObject var feature: FeatureSwitchState = FeatureSwitchState()
    let perform: (MenuItemDescriptor.Role) -> Void
    let dismiss: () -> Void

    private var focusInfo: FocusMenuInfo {
        FocusMenuInfo(state: focus.state, goalLine: focus.goalLine, hasLastJudgment: focus.lastJudgment != nil)
    }

    private var items: [MenuItemDescriptor] {
        MenuModel.items(state: connection.state, identity: connection.identity, focus: focusInfo, feature: feature.row)
    }

    /// The Focus state line (goal, "No block right now", ...), when Focus is on.
    private var focusLine: String? {
        MenuModel.card(state: connection.state, identity: connection.identity, focus: focusInfo).focusLine
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TrailMarkerTokens.Spacing.group) {
            header

            if let primary = items.first(where: { $0.role == .primaryAction }) {
                primaryButton(primary.title)
            }

            Divider()

            if !toggles.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(toggles, id: \.role) { row in
                        SwitchRow(title: row.title, isOn: row.isOn) { on in setSwitch(row.role, on: on) }
                            .disabled(!row.isEnabled)
                    }
                }
                Divider()
            }

            VStack(alignment: .leading, spacing: 2) {
                ForEach(rows, id: \.role) { row in
                    CardRow(title: row.title, shortcut: shortcut(for: row.role), destructive: row.isDestructive) {
                        run(row.role)
                    }
                    .disabled(!row.isEnabled)
                }
            }
        }
        .padding(TrailMarkerTokens.Spacing.group)
        .frame(width: TrailMarkerTokens.Layout.menuPopoverWidth)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: TrailMarkerTokens.Spacing.row) {
            ZStack(alignment: .bottomTrailing) {
                Image("MossMarkColor")
                    .resizable()
                    .frame(width: 40, height: 40)
                    .accessibilityHidden(true)
                Image(systemName: badge.symbol)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white, badge.color)
                    .symbolRenderingMode(.palette)
                    .offset(x: 6, y: 6)
                    .accessibilityHidden(true)
            }
            .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 2) {
                Text(MenuModel.statusTitle(for: connection.state))
                    .font(.headline)
                Text(explanation)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let focusLine {
                    Text(focusLine)
                        .font(.callout.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Everything after the primary action, in the guide's order, minus what the header shows.
    /// The feature switches (Focus now; Backtrack later), in `MenuModel`'s order.
    private var toggles: [MenuItemDescriptor] { items.filter { $0.kind == .toggle } }

    /// A switch changes one feature and leaves the card open, unlike a row, which acts and closes.
    private func setSwitch(_ role: MenuItemDescriptor.Role, on: Bool) {
        switch role {
        case .focusSwitch: focus.setFocusSwitch(on: on)
        case .featureSwitch: feature.onToggle?(on)
        default: break
        }
    }

    private var rows: [MenuItemDescriptor] {
        items.filter { $0.kind == .text && ![.status, .focusStatus, .instanceInfo, .primaryAction].contains($0.role) }
    }

    /// Pause All and Resume All look different, not just read differently (Ben, 2026-09-23):
    /// running, pausing is the quieter outlined choice; paused, Resume All is the loudest thing on
    /// the card, so the paused state is obvious at a glance. Every other state (Retry, Sign In,
    /// Set Up) keeps the prominent button.
    @ViewBuilder
    private func primaryButton(_ title: String) -> some View {
        switch connection.state {
        case .connected:
            Button { run(.primaryAction) } label: {
                Label(title, systemImage: "pause.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        case .disconnected:
            Button { run(.primaryAction) } label: {
                Label(title, systemImage: "play.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        default:
            Button { run(.primaryAction) } label: {
                Text(title).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }

    private func run(_ role: MenuItemDescriptor.Role) {
        dismiss()
        perform(role)
    }

    private func shortcut(for role: MenuItemDescriptor.Role) -> String? {
        switch role {
        case .settings: return "⌘,"
        case .quit: return "⌘Q"
        default: return nil
        }
    }

    private var explanation: String {
        switch connection.state {
        case .connected:
            let host = connection.identity?.instance.origin.host ?? "Moss"
            return "Linked to \(host)."
        case .disconnected:
            return "Paused. Nothing is being sent to Moss."
        case .reconnecting:
            return "Moss is temporarily unreachable."
        case .signInRequired(let reason):
            if case .revoked = reason { return "Your Trail Marker access was revoked from Moss." }
            return "Your session has expired. Please sign in to continue."
        case .notLinked:
            return "Connect this Mac to your Moss account."
        }
    }

    private var badge: (symbol: String, color: Color) {
        switch connection.state {
        case .connected: return ("checkmark.circle.fill", Color(nsColor: .systemGreen))
        case .disconnected: return ("pause.circle.fill", Color(nsColor: .secondaryLabelColor))
        case .reconnecting: return ("exclamationmark.circle.fill", Color(nsColor: .systemOrange))
        case .signInRequired: return ("exclamationmark.circle.fill", Color(nsColor: .systemRed))
        case .notLinked: return ("link.circle.fill", Color(nsColor: .tertiaryLabelColor))
        }
    }
}

private struct CardRow: View {
    let title: String
    let shortcut: String?
    let destructive: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                if let shortcut {
                    Text(shortcut).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 5).fill(hovering ? Color.primary.opacity(0.08) : .clear)
            )
        }
        .buttonStyle(.plain)
        // Opening the card gives keyboard focus to the first row, and macOS drew its focus ring
        // around Open Moss as if it were selected (Ben, 2026-09-23). Rows are menu items, which
        // show hover, not a focus ring.
        .focusEffectDisabled()
        .foregroundStyle(destructive ? Color(nsColor: .systemRed) : .primary)
        .onHover { hovering = $0 }
    }
}

/// A feature switch row from mockup A: the feature's name, then a small switch. Greyed and
/// unchangeable while Pause All is on, keeping its position.
private struct SwitchRow: View {
    let title: String
    let isOn: Bool
    let onChange: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { isOn }, set: { onChange($0) })) {
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .accessibilityIdentifier("switch.\(title)")
    }
}
