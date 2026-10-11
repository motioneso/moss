import AppKit
import SwiftUI
import XCTest
@testable import TrailMarker

final class ThisMacPaneTests: XCTestCase {
    @MainActor
    func testHostedPaneRefreshesActualLoginItemStatusOnAppActivationWithoutRegistration() async throws {
        let defaultsName = "com.moss.this-mac-tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: defaultsName)!
        let connection = ConnectionRuntime(
            keychain: KeychainStore(service: defaultsName),
            preferences: PreferencesStore(defaults: defaults)
        )
        let service = FakeLoginItemService(status: .requiresApproval)
        let controller = NSHostingController(rootView: ThisMacPane(connection: connection, loginItem: service))
        // Match AppDelegate's manually hosted settings window: no SwiftUI App/Scene lifecycle.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = controller
        defer {
            window.orderOut(nil)
            window.contentViewController = nil
            window.close()
            defaults.removePersistentDomain(forName: defaultsName)
        }
        window.makeKeyAndOrderFront(nil)
        try await waitUntil { !service.readStatuses.isEmpty }
        XCTAssertEqual(service.readStatuses.last, .requiresApproval)
        XCTAssertEqual(service.requests, [])

        var previousReads = service.readStatuses.count
        service.currentStatus = .enabled
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        try await waitUntil { service.readStatuses.count > previousReads }
        XCTAssertEqual(service.readStatuses.last, .enabled)
        XCTAssertEqual(service.requests, [])

        previousReads = service.readStatuses.count
        service.currentStatus = .notRegistered
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        try await waitUntil { service.readStatuses.count > previousReads }
        XCTAssertEqual(service.readStatuses.last, .notRegistered)
        XCTAssertEqual(service.requests, [], "Appearance and activation must never register or unregister")
        XCTAssertEqual(service.systemSettingsOpens, 0)
    }

    @MainActor
    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition(), "The hosted pane did not read the changed login-item status")
    }

    private final class FakeLoginItemService: LoginItemManaging {
        var currentStatus: LoginItemStatus
        private(set) var readStatuses: [LoginItemStatus] = []
        private(set) var requests: [Bool] = []
        private(set) var systemSettingsOpens = 0

        init(status: LoginItemStatus) { currentStatus = status }

        var status: LoginItemStatus {
            readStatuses.append(currentStatus)
            return currentStatus
        }

        func setEnabled(_ enabled: Bool) throws { requests.append(enabled) }
        func openSystemSettings() { systemSettingsOpens += 1 }
    }
}
