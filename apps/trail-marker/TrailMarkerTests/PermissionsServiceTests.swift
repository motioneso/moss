import XCTest
@testable import TrailMarker

final class PermissionsServiceTests: XCTestCase {
    private final class FakeAdaptor: PermissionsOSAdaptor {
        private(set) var accessibilityCalls: [Bool] = []
        private(set) var screenRecordingCalls: [Bool] = []
        var accessibilityResult = false
        var screenRecordingResult = false

        func accessibilityTrusted(prompting: Bool) -> Bool {
            accessibilityCalls.append(prompting)
            return accessibilityResult
        }

        func screenRecordingGranted(prompting: Bool) -> Bool {
            screenRecordingCalls.append(prompting)
            return screenRecordingResult
        }
    }

    private final class FakeNotifications: NotificationsOSAdaptor {
        private(set) var statusCalls = 0
        private(set) var requestCalls = 0
        var current: NotificationPermissionState = .notAsked
        /// What asking leaves the answer as; a refused person stays refused.
        var afterRequest: NotificationPermissionState = .allowed

        func status() async -> NotificationPermissionState {
            statusCalls += 1
            return current
        }

        func request() async -> NotificationPermissionState {
            requestCalls += 1
            if current == .notAsked { current = afterRequest }
            return current
        }
    }

    @MainActor
    func testRefreshNeverPrompts() {
        let adaptor = FakeAdaptor()
        let service = PermissionsService(adaptor: adaptor)

        service.refresh()

        XCTAssertEqual(adaptor.accessibilityCalls, [false])
        XCTAssertEqual(adaptor.screenRecordingCalls, [false])
    }

    @MainActor
    func testRequestAccessibilityPromptsExactlyOnce() {
        let adaptor = FakeAdaptor()
        adaptor.accessibilityResult = true
        let service = PermissionsService(adaptor: adaptor)

        service.requestAccessibility()

        XCTAssertEqual(adaptor.accessibilityCalls, [true])
        XCTAssertEqual(service.accessibility, .granted)
    }

    @MainActor
    func testRequestScreenRecordingPromptsExactlyOnce() {
        let adaptor = FakeAdaptor()
        adaptor.screenRecordingResult = false
        let service = PermissionsService(adaptor: adaptor)

        service.requestScreenRecording()

        XCTAssertEqual(adaptor.screenRecordingCalls, [true])
        XCTAssertEqual(service.screenRecording, .notGranted)
    }
    @MainActor
    func testRefreshingNotificationsReportsTheAnswerAndNeverAsks() async {
        let notifications = FakeNotifications()
        notifications.current = .denied
        let service = PermissionsService(adaptor: FakeAdaptor(), notificationsAdaptor: notifications)

        await service.refreshNotifications()

        XCTAssertEqual(service.notifications, .denied)
        XCTAssertEqual(notifications.requestCalls, 0)
    }

    @MainActor
    func testRequestingNotificationsAsksAndKeepsTheAnswer() async {
        let notifications = FakeNotifications()
        let service = PermissionsService(adaptor: FakeAdaptor(), notificationsAdaptor: notifications)
        XCTAssertEqual(service.notifications, .notAsked)

        await service.requestNotifications()

        XCTAssertEqual(notifications.requestCalls, 1)
        XCTAssertEqual(service.notifications, .allowed)
    }

    @MainActor
    func testARefusedPersonStaysRefusedWhenAskedAgain() async {
        let notifications = FakeNotifications()
        notifications.current = .denied
        let service = PermissionsService(adaptor: FakeAdaptor(), notificationsAdaptor: notifications)

        await service.requestNotifications()

        XCTAssertEqual(service.notifications, .denied)
    }
}
