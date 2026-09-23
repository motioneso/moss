import Foundation

/// What Trail Marker says about observation, worded for what is actually true for this build and
/// this setting. Both permission screens use it, so the copy cannot stay "not observing" while
/// the app is in fact reporting the app in front.
enum ObservationStatement {
    static func current(focusEnabled: Bool, watchEntireDesktop: Bool = false) -> String {
        guard focusEnabled else {
            return "These permissions prepare future capabilities. Trail Marker is not observing your activity."
        }
        let scope = watchEntireDesktop ? "for the entire desktop" : "for the apps you have allowed"
        return "While a Moss calendar block is on, Trail Marker tells Moss the name of the app in front "
            + "and a shortened window title, \(scope). Moss passes them on to the "
            + "AI model your administrator chose, which may be run by another company, to judge them. "
            + "It sends no screenshots, no typing and no page contents."
    }

    /// The Accessibility row's one line. It is no longer about future shortcuts. Deliberately
    /// stays general about scope ("the apps you allow, or the entire desktop") rather than
    /// switching wording with the current setting: this permission is requested well before Focus
    /// is configured, in onboarding, where there is no setting yet to be specific about.
    static let accessibilityScope =
        "Lets Trail Marker read the title of the window in front, for the apps you allow (or the entire "
            + "desktop, if you choose that), while a Moss block is on."
}
