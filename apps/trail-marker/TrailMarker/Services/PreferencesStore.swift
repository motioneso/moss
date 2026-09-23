import Foundation

/// Everything Trail Marker remembers outside the Keychain. Lives in `UserDefaults` under the
/// app's own bundle identifier, so it survives a reinstall of the .app bundle but not
/// `defaults delete com.moss.trailmarker` (see the README's "clearing local state" section).
final class PreferencesStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private enum Key {
        static let linkedIdentity = "linkedIdentity"
        static let connectionEnabled = "connectionEnabled"
        static let displayName = "displayName"
        static let pendingDisplayName = "pendingDisplayName"
        static let startAtLogin = "startAtLogin"
        static let autoCheckUpdates = "autoCheckUpdates"
        static let permissionsPromptShown = "permissionsPromptShown"
        static let focusConsent = "focusConsent"
        static let focusPaused = "focusPaused"
        static let focusAllowedBundleIds = "focusAllowedBundleIds"
        static let focusExcludedBundleIds = "focusExcludedBundleIds"
        static let focusWatchEntireDesktop = "focusWatchEntireDesktop"
        static let focusRung3Enabled = "focusRung3Enabled"
        static let focusVisionSource = "focusVisionSource"
        static let focusVisionBaseURL = "focusVisionBaseURL"
        static let focusVisionModel = "focusVisionModel"
    }

    var linkedIdentity: LinkedIdentity? {
        get {
            guard let data = defaults.data(forKey: Key.linkedIdentity) else { return nil }
            return try? JSONDecoder().decode(LinkedIdentity.self, from: data)
        }
        set {
            guard let newValue else {
                defaults.removeObject(forKey: Key.linkedIdentity)
                return
            }
            defaults.set(try? JSONEncoder().encode(newValue), forKey: Key.linkedIdentity)
        }
    }

    /// Default true: once linked, the connection is on until the person turns it off.
    var connectionEnabled: Bool {
        get { defaults.object(forKey: Key.connectionEnabled) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.connectionEnabled) }
    }

    var displayName: String? {
        get { defaults.string(forKey: Key.displayName) }
        set { defaults.set(newValue, forKey: Key.displayName) }
    }

    /// A rename made while disconnected, applied to the server on the next successful contact.
    var pendingDisplayName: String? {
        get { defaults.string(forKey: Key.pendingDisplayName) }
        set { defaults.set(newValue, forKey: Key.pendingDisplayName) }
    }

    var startAtLogin: Bool {
        get { defaults.object(forKey: Key.startAtLogin) as? Bool ?? false }
        set { defaults.set(newValue, forKey: Key.startAtLogin) }
    }

    var autoCheckUpdates: Bool {
        get { defaults.object(forKey: Key.autoCheckUpdates) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.autoCheckUpdates) }
    }

    var permissionsPromptShown: Bool {
        get { defaults.bool(forKey: Key.permissionsPromptShown) }
        set { defaults.set(newValue, forKey: Key.permissionsPromptShown) }
    }

    /// Focus observation is off until the person turns it on (plan: default off, spec §6).
    var focusConsent: Bool {
        get { defaults.bool(forKey: Key.focusConsent) }
        set { defaults.set(newValue, forKey: Key.focusConsent) }
    }

    /// A Pause survives quitting and restarting, like Disconnect.
    var focusPaused: Bool {
        get { defaults.bool(forKey: Key.focusPaused) }
        set { defaults.set(newValue, forKey: Key.focusPaused) }
    }

    /// Apps the person allowed. Empty means nothing is ever observed, unless
    /// `focusWatchEntireDesktop` is on. Kept even while entire-desktop watching is on, so the
    /// person's app choices are still there if they switch back.
    var focusAllowedBundleIds: Set<String> {
        get { Set(defaults.stringArray(forKey: Key.focusAllowedBundleIds) ?? []) }
        set { defaults.set(newValue.sorted(), forKey: Key.focusAllowedBundleIds) }
    }

    /// Apps the person chose never to have watched (#2633). Wins over the allowlist and over
    /// entire-desktop watching, like the fixed denylist.
    var focusExcludedBundleIds: Set<String> {
        get { Set(defaults.stringArray(forKey: Key.focusExcludedBundleIds) ?? []) }
        set { defaults.set(newValue.sorted(), forKey: Key.focusExcludedBundleIds) }
    }

    /// Watch every app (still subject to the denylist) instead of only the chosen apps above.
    /// Off by default: an empty allowlist means nothing is observed, not everything.
    var focusWatchEntireDesktop: Bool {
        get { defaults.bool(forKey: Key.focusWatchEntireDesktop) }
        set { defaults.set(newValue, forKey: Key.focusWatchEntireDesktop) }
    }

    /// Rung 3 (#2570 slice 2): off until Screen Recording is granted and the person turns it on.
    var focusRung3Enabled: Bool {
        get { defaults.bool(forKey: Key.focusRung3Enabled) }
        set { defaults.set(newValue, forKey: Key.focusRung3Enabled) }
    }

    /// Which vision source describes a capture. The API key itself lives in the Keychain, not here.
    var focusVisionSource: VisionSource {
        get {
            defaults.string(forKey: Key.focusVisionSource).flatMap { VisionSource(rawValue: $0) } ?? .apiKey
        }
        set { defaults.set(newValue.rawValue, forKey: Key.focusVisionSource) }
    }

    var focusVisionBaseURL: String {
        get { defaults.string(forKey: Key.focusVisionBaseURL) ?? "" }
        set { defaults.set(newValue, forKey: Key.focusVisionBaseURL) }
    }

    var focusVisionModel: String {
        get { defaults.string(forKey: Key.focusVisionModel) ?? "" }
        set { defaults.set(newValue, forKey: Key.focusVisionModel) }
    }

    /// Used by Log Out and by the "clear state between test runs" README step.
    func clearAll() {
        for key in [
            Key.linkedIdentity, Key.connectionEnabled, Key.displayName, Key.pendingDisplayName,
            Key.startAtLogin, Key.autoCheckUpdates, Key.permissionsPromptShown,
            Key.focusConsent, Key.focusPaused, Key.focusAllowedBundleIds, Key.focusExcludedBundleIds,
            Key.focusWatchEntireDesktop,
            Key.focusRung3Enabled, Key.focusVisionSource, Key.focusVisionBaseURL, Key.focusVisionModel
        ] {
            defaults.removeObject(forKey: key)
        }
    }
}
