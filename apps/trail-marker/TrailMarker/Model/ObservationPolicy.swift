import Foundation

/// What the frontmost app looked like at one moment. `windowTitle` is empty when Accessibility is
/// not granted or the app has no focused window.
struct Observation: Equatable {
    let appName: String
    let bundleId: String
    let windowTitle: String
}

extension Observation {
    /// Same app and the same title once symbols are ignored, so a terminal title that animates a
    /// spinner (◐, ✳) is not a new window every frame.
    func isSameWindow(as other: Observation?) -> Bool {
        guard let other, bundleId == other.bundleId else { return false }
        return Self.words(windowTitle) == Self.words(other.windowTitle)
    }

    private static func words(_ title: String) -> String {
        let kept = title.unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0) || CharacterSet.whitespaces.contains($0)
        }
        return String(String.UnicodeScalarView(kept)).split(separator: " ").joined(separator: " ")
    }
}

/// Decides whether an observation may leave this Mac at all. The person's allowlist starts empty,
/// so nothing is observed until they choose an app, or choose the whole desktop instead — getting
/// distracted rarely stays inside one app, so watching everything is a real choice, not a fallback
/// for someone too lazy to pick apps. Either way the denylist is fixed and always wins, so
/// allowing (or watching) a password manager by mistake still sends nothing.
struct ObservationPolicy: Equatable {
    var allowedBundleIds: Set<String>
    /// When true, every app not on the denylist is observed and `allowedBundleIds` is ignored for
    /// the purpose of `allows(_:)` (still kept around as what the person picked before, in case
    /// they switch back). Off by default: an empty allowlist still means nothing is observed.
    var watchEntireDesktop: Bool = false

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
        if watchEntireDesktop { return true }
        return allowedBundleIds.contains(observation.bundleId)
    }
}
