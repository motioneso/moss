import Foundation

/// What Trail Marker says about observation, worded for what is actually true for this build and
/// this setting. Both permission screens use it, so the copy cannot stay "not observing" while
/// the app is in fact reporting the app in front.
enum ObservationStatement {
    static func current(focusEnabled: Bool, paused: Bool) -> String {
        guard focusEnabled else {
            return "These permissions prepare future capabilities. Trail Marker is not observing your activity."
        }
        if paused {
            return "Focus is paused, so nothing is being sent to Moss until you resume."
        }
        return "While a Moss calendar block is on, Trail Marker tells Moss the name of the app in front "
            + "and a shortened window title, for the apps you have allowed. Moss passes them on to the "
            + "AI model your administrator chose, which may be run by another company, to judge them. "
            + "It sends no screenshots, no typing and no page contents."
    }

    /// The Accessibility row's one line. It is no longer about future shortcuts.
    static let accessibilityScope =
        "Lets Trail Marker read the title of the window in front, for apps you allow, while a Moss block is on."
}
