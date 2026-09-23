import ApplicationServices
import CoreGraphics
import Foundation
import UserNotifications

enum PermissionState: Equatable {
    case granted
    case notGranted
}

/// Notifications have a third answer the other two permissions lack: macOS only lets an app ask
/// once, so "never asked" (we can still ask) and "refused" (only System Settings can change it)
/// need different actions.
enum NotificationPermissionState: Equatable {
    case notAsked
    case allowed
    case denied
}

protocol NotificationsOSAdaptor {
    /// Reports the current answer. Never prompts.
    func status() async -> NotificationPermissionState
    /// Asks. macOS shows the prompt only while the answer is still `notAsked`; after that this just
    /// returns the standing answer.
    func request() async -> NotificationPermissionState
}

struct SystemNotificationsAdaptor: NotificationsOSAdaptor {
    func status() async -> NotificationPermissionState {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: return .notAsked
        case .denied: return .denied
        default: return .allowed
        }
    }

    func request() async -> NotificationPermissionState {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        return await status()
    }
}

/// Talks to the two system permission APIs. Kept behind a protocol so tests can assert
/// `refresh()` never prompts (§17: "Do not request Accessibility or Screen Recording on every
/// launch") while `requestAccessibility()` / `requestScreenRecording()` do, exactly once.
protocol PermissionsOSAdaptor {
    func accessibilityTrusted(prompting: Bool) -> Bool
    func screenRecordingGranted(prompting: Bool) -> Bool
}

struct SystemPermissionsAdaptor: PermissionsOSAdaptor {
    func accessibilityTrusted(prompting: Bool) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: prompting] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    func screenRecordingGranted(prompting: Bool) -> Bool {
        prompting ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    }
}

/// Permissions are informational in v1 (§17): they never gate account linking, and the app
/// never re-prompts on its own — only an explicit button press prompts.
@MainActor
final class PermissionsService: ObservableObject {
    @Published private(set) var accessibility: PermissionState = .notGranted
    @Published private(set) var screenRecording: PermissionState = .notGranted
    @Published private(set) var notifications: NotificationPermissionState = .notAsked

    private let adaptor: PermissionsOSAdaptor
    private let notificationsAdaptor: NotificationsOSAdaptor

    init(
        adaptor: PermissionsOSAdaptor = SystemPermissionsAdaptor(),
        notificationsAdaptor: NotificationsOSAdaptor = SystemNotificationsAdaptor()
    ) {
        self.adaptor = adaptor
        self.notificationsAdaptor = notificationsAdaptor
    }

    /// Safe to call on every launch and whenever Settings appears: never prompts.
    func refresh() {
        accessibility = adaptor.accessibilityTrusted(prompting: false) ? .granted : .notGranted
        screenRecording = adaptor.screenRecordingGranted(prompting: false) ? .granted : .notGranted
    }

    func requestAccessibility() {
        accessibility = adaptor.accessibilityTrusted(prompting: true) ? .granted : .notGranted
    }

    func requestScreenRecording() {
        screenRecording = adaptor.screenRecordingGranted(prompting: true) ? .granted : .notGranted
    }

    /// Safe whenever a screen appears or the app comes back to the front: never prompts.
    func refreshNotifications() async {
        notifications = await notificationsAdaptor.status()
    }

    func requestNotifications() async {
        notifications = await notificationsAdaptor.request()
    }
}
