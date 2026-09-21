import Foundation
import UserNotifications

/// The words of a nudge. A fixed template filled from the calendar block, never model output
/// (plan §3: every message the person sees comes from a record or a template).
enum NudgeText {
    static let title = "Trail Marker"
    static let testBody = "This is a test nudge. If you can read it, real nudges will reach you."

    static func body(blockTitle: String) -> String {
        let cleaned = String(
            String.UnicodeScalarView(
                blockTitle.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }
            )
        )
        .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        let shortened = cleaned.count > 80 ? String(cleaned.prefix(79)) + "…" : cleaned
        return "Your block “\(shortened)” is on. Ready to get back to it?"
    }
}

/// Delivers a nudge as an ordinary macOS notification. The permission is asked for only when the
/// person first turns Focus on, never at setup.
@MainActor
final class NudgeService: NSObject, NudgeDelivering, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        center.delegate = self
    }

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func showNudge(blockTitle: String) {
        post(body: NudgeText.body(blockTitle: blockTitle))
    }

    func showTestNudge() {
        post(body: NudgeText.testBody)
    }

    private func post(body: String) {
        let content = UNMutableNotificationContent()
        content.title = NudgeText.title
        content.body = body
        content.sound = .default
        center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    // A menu-bar app is rarely "in front", but if it is, still show the banner.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
