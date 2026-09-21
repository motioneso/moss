import AppKit

/// The two Privacy & Security panes the Permissions settings pane recovers through, per the
/// design guide (§7, §11): "Open System Settings…" for a permission that must be granted or
/// re-granted outside the app.
enum SystemSettingsLinks {
    static func openAccessibility() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    static func openScreenRecording() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    static func openNotifications() {
        open("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
    }

    private static func open(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }
}
