#if DEBUG
import AppKit
import SwiftUI

/// Debug builds only: `-TMHostCardInWindow YES` hosts the menu-bar card in an ordinary window, so
/// the XCUITest target can drive it (XCUITest can't open a status item's popover). Nothing here
/// touches the person's real link: preferences live in their own suite, the credential in its own
/// Keychain service, and every request is answered locally without the network.
@MainActor
final class CardHarness {
    static var isRequested: Bool { UserDefaults.standard.bool(forKey: "TMHostCardInWindow") }

    private static let suite = "com.moss.trailmarker.cardharness"

    private let connection: ConnectionRuntime
    private let focus: FocusRuntime
    private let backtrack: BacktrackRuntime
    private var windows: [NSWindow] = []

    init() {
        UserDefaults().removePersistentDomain(forName: Self.suite)
        let defaults = UserDefaults(suiteName: Self.suite) ?? .standard
        let preferences = PreferencesStore(defaults: defaults)
        // Every launch starts linked, running, with Focus on and switched on (#2646).
        // `removePersistentDomain` alone isn't enough: a value the previous launch wrote (a test
        // that ended paused) can still be read back, which made each UI test depend on the one
        // before it. Reset through the same instance the runtimes read.
        preferences.clearAll()
        preferences.connectionEnabled = true
        preferences.focusSwitchedOff = false
        preferences.focusConsent = true
        let keychain = KeychainStore(service: Self.suite)
        if let identity = Self.identity { _ = keychain.delete(for: identity) }
        let transport = LocalTransport()
        connection = ConnectionRuntime(keychain: keychain, preferences: preferences, transportFactory: { _ in transport })
        focus = FocusRuntime(
            connection: connection, permissions: PermissionsService(), nudges: NudgeService(),
            preferences: preferences, keychain: keychain, transportFactory: { _ in transport },
            freshWindowIdentity: { _ in nil }
        )
        backtrack = BacktrackRuntime(
            connection: connection, permissions: PermissionsService(), focus: focus, preferences: preferences,
            sink: BacktrackDebugRing(), services: .inert()
        )
    }

    private static var identity: LinkedIdentity? {
        guard case .success(let instance) = InstanceURL.parse("https://moss.example.com") else { return nil }
        return LinkedIdentity(
            instance: instance, deviceId: "harness", accountName: "Harness", accountEmail: "harness@example.com"
        )
    }

    func show() {
        focus.start()
        backtrack.start()
        if let identity = Self.identity {
            connection.send(.linkCompleted(identity, credential: "tm1_harness", generation: connection.currentGeneration))
        }

        let card = StatusCardView(
            connection: connection, focus: focus, feature: backtrack.menuState,
            perform: { [weak self] role in self?.perform(role) }, dismiss: {}
        )
        let window = NSWindow(contentViewController: NSHostingController(rootView: card))
        window.title = "Trail Marker card (test harness)"
        window.makeKeyAndOrderFront(nil)
        windows.append(window)
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func perform(_ role: MenuItemDescriptor.Role) {
        switch role {
        case .primaryAction:
            connection.send(connection.state == .disconnected ? .userConnect : .userDisconnect)
        case .settings:
            let settings = SettingsWindow(
                connection: connection, permissions: PermissionsService(), focus: focus,
                updater: UpdaterService(), loginItem: LoginItemService(), onSetUp: {}, backtrack: backtrack
            )
            let window = NSWindow(contentViewController: NSHostingController(rootView: settings))
            window.title = "Settings"
            window.makeKeyAndOrderFront(nil)
            windows.append(window)
        default:
            break
        }
    }

    /// Answers every companion request locally: a healthy heartbeat, and no calendar block.
    private final class LocalTransport: CompanionTransport, @unchecked Sendable {
        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let path = request.url?.path ?? ""
            let json: String
            switch path {
            case "/api/companion/heartbeat":
                json = #"{"device":{"id":"harness","displayName":"Harness Mac"},"account":{"name":"Harness","email":"harness@example.com"},"serverTime":"2026-01-01T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z"}"#
            case "/api/companion/focus/context":
                json = #"{"block":null,"judgmentReady":true}"#
            default:
                json = "{}"
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data(json.utf8), response)
        }
    }
}
#endif
