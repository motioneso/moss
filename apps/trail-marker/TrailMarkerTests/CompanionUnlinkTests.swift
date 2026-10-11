import Foundation
import XCTest
@testable import TrailMarker

/// T13 executes ConnectionRuntime, canonical request construction and its real effect ordering.
/// The credential store and transport are memory-only; no Keychain, permission or server is used.
@MainActor
final class CompanionUnlinkTests: XCTestCase {
    func testLogoutMustSucceedBeforeEitherCredentialIsDeleted() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let keys = fixture.keys, identity = fixture.identity
        fixture.transport.onLogout = {
            XCTAssertNotNil(keys.read(for: identity))
            XCTAssertNotNil(keys.readRecordingProof(for: identity))
            keys.note("logout-confirmed")
        }
        fixture.connection.send(.userLogout)
        XCTAssertEqual(fixture.connection.state, .unlinking)
        XCTAssertNil(fixture.connection.requestClient(), "Saved credentials are logout-only while pending")
        try await waitUntil { fixture.connection.state == .notLinked }
        XCTAssertEqual(fixture.transport.paths, ["/api/companion/logout"])
        XCTAssertEqual(Array(fixture.keys.events.prefix(3)), ["logout-confirmed", "delete-proof", "delete-companion"])
        XCTAssertNil(fixture.keys.read(for: fixture.identity))
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertFalse(fixture.preferences.unlinkPending)
    }

    func testFailedLogoutRetainsBothCredentialsAndCanRetry() async throws {
        for status in [500, 401] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.transport.status = status
            fixture.connection.send(.userLogout)
            try await waitUntil { fixture.connection.lastDiagnostic != nil }
            XCTAssertEqual(fixture.connection.state, .unlinking)
            XCTAssertTrue(fixture.preferences.unlinkPending)
            XCTAssertNotNil(fixture.keys.read(for: fixture.identity))
            XCTAssertNotNil(fixture.keys.readRecordingProof(for: fixture.identity))
            XCTAssertTrue(fixture.keys.events.isEmpty, "No local deletion on any failed logout, including 401")
            XCTAssertTrue(fixture.connection.lastDiagnostic?.contains("Not unlinked yet") == true)
            XCTAssertNil(fixture.connection.requestClient())
            fixture.connection.send(.userConnect)
            XCTAssertEqual(fixture.connection.state, .unlinking)
            fixture.transport.status = 204
            fixture.connection.send(.userRetry)
            try await waitUntil { fixture.connection.state == .notLinked }
            XCTAssertEqual(fixture.transport.paths.count, 2)
            XCTAssertNil(fixture.keys.read(for: fixture.identity))
            XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        }
    }

    func testRestartKeepsPendingUnlinkAndNeverSendsHeartbeatOrStartsCapture() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.transport.status = 503
        fixture.connection.send(.userLogout)
        try await waitUntil { fixture.connection.lastDiagnostic != nil }
        fixture.connection.send(.userQuit)
        let restarted = ConnectionRuntime(keychain: fixture.keys, preferences: fixture.preferences,
            transportFactory: { _ in fixture.transport })
        defer { restarted.send(.userQuit) }
        restarted.start()
        try await waitUntil { restarted.lastDiagnostic != nil }
        XCTAssertEqual(restarted.state, .unlinking)
        XCTAssertNil(restarted.requestClient())
        XCTAssertTrue(fixture.transport.paths.allSatisfy { $0 == "/api/companion/logout" })
        XCTAssertNotNil(fixture.keys.read(for: fixture.identity))
        XCTAssertNotNil(fixture.keys.readRecordingProof(for: fixture.identity))
        restarted.send(.linkCompleted(fixture.identity, credential: "tm1_new-synthetic", generation: restarted.currentGeneration))
        XCTAssertEqual(restarted.state, .unlinking, "A stale onboarding flow cannot replace pending logout")
    }

    func testConfirmedLogoutRetriesDeniedLocalCleanupWithoutCallingLogoutAgain() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.keys.allowDeletion = false
        fixture.connection.send(.userLogout)
        try await waitUntil { fixture.connection.lastDiagnostic != nil }
        XCTAssertEqual(fixture.connection.state, .unlinking)
        XCTAssertTrue(fixture.preferences.unlinkConfirmed)
        fixture.keys.allowDeletion = true
        fixture.connection.send(.userRetry)
        try await waitUntil { fixture.connection.state == .notLinked }
        XCTAssertEqual(fixture.transport.paths.count, 1, "Keep server confirmation when local cleanup needs retry")
        XCTAssertNil(fixture.keys.read(for: fixture.identity))
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
    }

    func testLogoutBackoffIsBoundedAndStaleCallbacksCannotClearCredentials() {
        var machine = ConnectionMachine(state: .disconnected)
        _ = machine.handle(.userLogout, now: Date())
        let generation = machine.generation
        for _ in 0..<20 {
            let effects = machine.handle(.logoutFailed(generation: generation), now: Date())
            guard case .scheduleRevoke(let delay, _) = effects.last else { return XCTFail("Missing retry") }
            XCTAssertGreaterThanOrEqual(delay, 5)
            XCTAssertLessThanOrEqual(delay, 300)
            XCTAssertFalse(effects.contains(.clearCredential))
        }
        _ = machine.handle(.userRetry, now: Date())
        XCTAssertEqual(machine.handle(.logoutSucceeded(generation: generation), now: Date()), [])
        XCTAssertEqual(machine.state, .unlinking)
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(condition(), "Unlink did not reach expected synthetic state")
    }

    @MainActor
    private final class Fixture {
        let name = "com.moss.unlink-tests." + UUID().uuidString
        let keys = MemoryCredentials()
        let transport = LogoutTransport()
        let identity: LinkedIdentity
        let preferences: PreferencesStore
        let connection: ConnectionRuntime
        init() throws {
            identity = .init(instance: try InstanceURL.parse("https://moss.example").get(), deviceId: "fixture-device",
                accountName: "Fixture", accountEmail: "fixture@example.invalid")
            preferences = PreferencesStore(defaults: UserDefaults(suiteName: name)!)
            let transport = self.transport
            connection = ConnectionRuntime(keychain: keys, preferences: preferences, transportFactory: { _ in transport })
            connection.send(.linkCompleted(identity, credential: "tm1_synthetic", generation: connection.currentGeneration))
            try keys.storeRecordingProof(String(repeating: "p", count: 43), for: identity)
        }
        func close() {
            connection.send(.userQuit)
            UserDefaults.standard.removePersistentDomain(forName: name)
        }
    }
}

private final class MemoryCredentials: CompanionCredentialStore {
    private let lock = NSLock()
    private var companion: String?
    private var proof: String?
    private var journal: [String] = []
    var allowDeletion = true
    var events: [String] { lock.lock(); defer { lock.unlock() }; return journal }
    func note(_ event: String) { lock.lock(); journal.append(event); lock.unlock() }
    func read(for identity: LinkedIdentity) -> String? { lock.lock(); defer { lock.unlock() }; return companion }
    func readRecordingProof(for identity: LinkedIdentity) -> String? { lock.lock(); defer { lock.unlock() }; return proof }
    func store(credential: String, for identity: LinkedIdentity) throws { lock.lock(); companion = credential; lock.unlock() }
    func storeRecordingProof(_ value: String, for identity: LinkedIdentity) throws { lock.lock(); proof = value; lock.unlock() }
    @discardableResult func delete(for identity: LinkedIdentity) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard allowDeletion else { return false }
        journal.append("delete-companion"); companion = nil; return true
    }
    @discardableResult func deleteRecordingProof(for identity: LinkedIdentity) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard allowDeletion else { return false }
        journal.append("delete-proof"); proof = nil; return true
    }
    func readPendingRecordingProof(for identity: LinkedIdentity) -> PendingRecordingProof? { nil }
    func storePendingRecordingProof(_ value: PendingRecordingProof, for identity: LinkedIdentity) throws {}
    func deletePendingRecordingProof(for identity: LinkedIdentity) {}
}

private final class LogoutTransport: CompanionTransport {
    private let lock = NSLock()
    private var requests: [String] = []
    var status = 204
    var onLogout: (() -> Void)?
    var paths: [String] { lock.lock(); defer { lock.unlock() }; return requests }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { try response(request) }
    private func response(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        guard let url = request.url, url.path == "/api/companion/logout" else { throw URLError(.unsupportedURL) }
        lock.lock(); requests.append(url.path); lock.unlock()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.timeoutInterval, 15)
        onLogout?()
        return (Data(), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
