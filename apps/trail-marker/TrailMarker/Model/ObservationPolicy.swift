import CoreGraphics
import Foundation

/// The window a capture is allowed to take, as Accessibility reported it: the focused window's
/// frame (screen points, top-left origin, the same space `SCWindow.frame` uses) and its title.
/// Only ever built when both reads succeeded, so a title that could not be read is never mistaken
/// for a window that truly has no title (#2643). There is no public API that turns an AX window
/// into a `CGWindowID`, so this is matched to an on-screen window by process, frame and title.
struct WindowIdentity: Equatable {
    let frame: CGRect
    let title: String

    /// Within a point either way: AX and ScreenCaptureKit round the same window's frame
    /// independently.
    static let frameTolerance: CGFloat = 1

    private func sameFrame(_ other: CGRect) -> Bool {
        abs(frame.minX - other.minX) <= Self.frameTolerance
            && abs(frame.minY - other.minY) <= Self.frameTolerance
            && abs(frame.width - other.width) <= Self.frameTolerance
            && abs(frame.height - other.height) <= Self.frameTolerance
    }

    /// Accessibility against Accessibility (the post-capture re-check): the title must be equal.
    func matches(_ other: WindowIdentity) -> Bool { other.title == title && sameFrame(other.frame) }

    /// Accessibility against a ScreenCaptureKit window: the frame, and only the frame. The caller
    /// takes a window only when exactly one of the app's on-screen windows has it, and the identity
    /// is a fresh Accessibility read, read again after the picture and required to be identical
    /// (#2643).
    ///
    /// The capture title is deliberately not compared. Measured on Ben's Mac for one Chrome window
    /// with the same frame (2026-09-23):
    /// - ScreenCaptureKit drops the tail Accessibility adds ("- High memory usage - 908 MB -
    ///   Google Chrome");
    /// - it also shortens long titles in the middle ("TEKsystems Trivia & Networkin… - … - Gmail").
    /// So no title rule is reliable. Private windows are refused by the policy, which reads the full
    /// Accessibility title. Two windows of the app at the same frame are ambiguous, so neither is
    /// taken.
    func matchesCaptureWindow(frame other: CGRect) -> Bool { sameFrame(other) }
}

/// What the frontmost app looked like at one moment. `windowTitle` is empty when Accessibility is
/// not granted or the app has no focused window. `window` is nil unless Accessibility named the
/// focused window and read its title; a screen capture needs it (`allowsCapture`).
struct Observation: Equatable {
    let appName: String
    let bundleId: String
    let windowTitle: String
    var pid: pid_t = 0
    var window: WindowIdentity?
}

extension Observation {
    /// The same app with its window replaced by a fresh Accessibility read. The title follows the
    /// fresh window, so the private-window check runs on what is on screen now. A failed read
    /// leaves no window, and so no capture.
    func refreshed(window fresh: WindowIdentity?) -> Observation {
        Observation(
            appName: appName, bundleId: bundleId, windowTitle: fresh?.title ?? windowTitle, pid: pid, window: fresh
        )
    }
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
/// allowing (or watching) a password manager by mistake still sends nothing. The person can add
/// their own apps to that denylist (`excludedBundleIds`, #2633) — a finance app, say — and those
/// win the same way: nothing about them leaves the Mac, not the picture, the title or the name.
struct ObservationPolicy: Equatable {
    var allowedBundleIds: Set<String>
    /// When true, every app not on the denylist is observed and `allowedBundleIds` is ignored for
    /// the purpose of `allows(_:)` (still kept around as what the person picked before, in case
    /// they switch back). Off by default: an empty allowlist still means nothing is observed.
    var watchEntireDesktop: Bool = false
    /// Apps the person chose never to have watched. Checked with the fixed denylist, before the
    /// allowlist or entire-desktop choice, so it wins in both modes.
    var excludedBundleIds: Set<String> = []

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
        if neverWatches(observation) { return false }
        if watchEntireDesktop { return true }
        return allowedBundleIds.contains(observation.bundleId)
    }

    /// Whether a picture of this window may be taken for a judgment. Stricter than `allows`: the
    /// focused window must have been identified, which means Accessibility is granted and its
    /// title was actually read, so the private-window check above really ran on it. Without that
    /// nothing is captured; judging by app name alone is unaffected (#2643).
    func allowsCapture(_ observation: Observation) -> Bool {
        allows(observation) && observation.window != nil
    }

    /// Settings' Test vision takes its picture outside any judgment, so it is not limited to the
    /// chosen apps, but it obeys never-watch and needs the same identified window.
    func allowsTestCapture(_ observation: Observation) -> Bool {
        !neverWatches(observation) && observation.window != nil
    }

    /// The denylist, the person's exclusions and private windows: never observed, whatever else
    /// is chosen. Also what Settings' "Test vision" checks, since it captures outside a judgment.
    func neverWatches(_ observation: Observation) -> Bool { neverWatchReason(observation) != nil }

    enum NeverWatchReason: Equatable { case builtIn, excluded, privateWindow }

    /// Which rule refuses the observation, so the person is told the truth: a private window is
    /// refused on its own, not because the whole app is.
    func neverWatchReason(_ observation: Observation) -> NeverWatchReason? {
        if Self.deniedBundleIds.contains(observation.bundleId) { return .builtIn }
        if excludedBundleIds.contains(observation.bundleId) { return .excluded }
        let title = observation.windowTitle.lowercased()
        return Self.deniedTitleMarkers.contains(where: { title.contains($0) }) ? .privateWindow : nil
    }
}
