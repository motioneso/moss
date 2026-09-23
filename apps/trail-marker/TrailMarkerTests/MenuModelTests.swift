import XCTest
@testable import TrailMarker

final class MenuModelTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private var identity: LinkedIdentity {
        guard case .success(let instance) = InstanceURL.parse("https://moss.example.com") else {
            fatalError("expected a valid instance URL")
        }
        return LinkedIdentity(
            instance: instance, deviceId: "device-1", accountName: "Ben", accountEmail: "ben@example.com"
        )
    }

    private func titles(_ state: ConnectionState, identity: LinkedIdentity?) -> [String] {
        MenuModel.items(state: state, identity: identity).filter { $0.kind == .text }.map(\.title)
    }

    func testNotLinkedMenu() {
        XCTAssertEqual(
            titles(.notLinked, identity: nil),
            ["Not linked", "Set Up Trail Marker", "Open Moss", "Settings…", "Quit Trail Marker"]
        )
    }

    func testConnectedMenu() {
        XCTAssertEqual(
            titles(.connected(lastContact: now), identity: identity),
            [
                "Connected", "moss.example.com", "ben@example.com", "Pause All", "Open Moss",
                "Settings…", "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testPausedMenuOffersResume() {
        XCTAssertEqual(
            titles(.disconnected, identity: identity),
            [
                "Paused", "moss.example.com", "ben@example.com", "Resume All", "Open Moss",
                "Settings…", "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testReconnectingMenu() {
        XCTAssertEqual(
            titles(.reconnecting(attempt: 2, lastContact: nil), identity: identity),
            [
                "Reconnecting", "moss.example.com", "ben@example.com", "Retry Now", "Open Moss",
                "Settings…", "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testSignInRequiredMenu() {
        XCTAssertEqual(
            titles(.signInRequired(reason: .revoked), identity: identity),
            [
                "Sign-in required", "moss.example.com", "ben@example.com", "Sign In", "Open Moss",
                "Settings…", "Log Out…", "Quit Trail Marker"
            ]
        )
    }

    func testLogOutIsAbsentWhenNotLinked() {
        let items = MenuModel.items(state: .notLinked, identity: nil)
        XCTAssertFalse(items.contains { $0.title == "Log Out…" })
    }

    func testPauseIsNeverDestructiveAndLogOutAlwaysIs() {
        let connectedItems = MenuModel.items(state: .connected(lastContact: now), identity: identity)
        let pause = connectedItems.first { $0.title == "Pause All" }
        let logOut = connectedItems.first { $0.title == "Log Out…" }

        XCTAssertEqual(pause?.isDestructive, false)
        XCTAssertEqual(logOut?.isDestructive, true)
    }
}
