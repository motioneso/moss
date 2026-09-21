import Foundation

/// What the frontmost app looked like at one moment. `windowTitle` is empty when Accessibility is
/// not granted or the app has no focused window.
struct Observation: Equatable {
    let appName: String
    let bundleId: String
    let windowTitle: String
}

/// Decides whether an observation may leave this Mac at all. The person's allowlist starts empty,
/// so nothing is observed until they choose an app; the denylist is fixed and always wins, so
/// allowing a password manager by mistake still sends nothing.
struct ObservationPolicy {
    var allowedBundleIds: Set<String>

    /// Password managers and the system keychain. Not exhaustive and not a promise about every
    /// sensitive app: the allowlist is the real boundary, this is a backstop.
    static let deniedBundleIds: Set<String> = [
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.agilebits.onepassword-osx",
        "com.bitwarden.desktop",
        "com.lastpass.LastPass",
        "org.keepassxc.keepassxc",
        "com.dashlane.dashlanephonefinal",
        "com.apple.keychainaccess",
        "com.apple.Passwords"
    ]

    /// A window title carrying one of these is a private-browsing window in an otherwise
    /// allowed browser. Compared without regard to case.
    static let deniedTitleMarkers: [String] = ["incognito", "private browsing", "inprivate", "private window"]

    func allows(_ observation: Observation) -> Bool {
        if Self.deniedBundleIds.contains(observation.bundleId) { return false }
        let title = observation.windowTitle.lowercased()
        if Self.deniedTitleMarkers.contains(where: { title.contains($0) }) { return false }
        return allowedBundleIds.contains(observation.bundleId)
    }
}
