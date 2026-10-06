import Foundation
import XCTest
@testable import TrailMarker

/// Isolated synthetic Keychain namespace and fake companion transport. Never reads the
/// person's linked account, creates real approval, requests OS permission or contacts a server.
@MainActor
final class RecordingCapabilityRecoveryTests: XCTestCase {
    func testLostApprovalResponseThenOfflineBeyondAttemptDeadlineRecoversSameProof() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let pending = fixture.pending
        try fixture.keys.storePendingRecordingProof(pending, for: fixture.identity)
        fixture.transport.responseStatus = "approved"
        let result = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(result, "approved")
        XCTAssertEqual(fixture.keys.readRecordingProof(for: fixture.identity), pending.proof)
        XCTAssertNil(fixture.keys.readPendingRecordingProof(for: fixture.identity))
        XCTAssertEqual(fixture.transport.statusAttempts, [pending.attemptId!])
        XCTAssertEqual(fixture.transport.createAttempts, 0, "An already approved proof must not need another consent request")
    }

    func testUncertainExpiredAttemptStatusKeepsProofAndRequestKeyForRetry() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
        fixture.transport.failStatus = true
        do { _ = try await fixture.connection.refreshRecordingCapability(); XCTFail("Synthetic response must fail") }
        catch { /* No affirmative status was received. */ }
        let retained = try XCTUnwrap(fixture.keys.readPendingRecordingProof(for: fixture.identity))
        XCTAssertEqual(retained.proof, fixture.pending.proof)
        XCTAssertEqual(retained.requestKey, fixture.pending.requestKey)
        XCTAssertEqual(retained.attemptId, fixture.pending.attemptId)
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        fixture.transport.failStatus = false
        let recovered = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(recovered, "approved")
        XCTAssertEqual(fixture.keys.readRecordingProof(for: fixture.identity), fixture.pending.proof)
    }

    func testServerConfirmedExpiredAttemptDiscardsOnlyPendingProof() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
        fixture.transport.responseStatus = "expired"
        let result = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(result, "expired")
        XCTAssertEqual(fixture.transport.statusAttempts.count, 1)
        XCTAssertNil(fixture.keys.readPendingRecordingProof(for: fixture.identity))
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertNotNil(fixture.keys.read(for: fixture.identity), "Companion/Backtrack connection is independent")
    }

    @MainActor
    private final class Fixture {
        let name = "com.moss.recording-recovery-tests." + UUID().uuidString
        let identity: LinkedIdentity
        let keys: KeychainStore
        let transport = RecordingApprovalFixtureTransport()
        let connection: ConnectionRuntime
        let pending = PendingRecordingProof(requestKey: UUID().uuidString.lowercased(), proof: String(repeating: "p", count: 43),
            attemptId: UUID().uuidString.lowercased(), expiresAt: ServerTime.format(Date().addingTimeInterval(-660)))
        init() throws {
            identity = LinkedIdentity(instance: try InstanceURL.parse("https://moss.example").get(),
                deviceId: "5372c777-bb4e-4d83-a42e-4df01b9f4144", accountName: "Fixture", accountEmail: "fixture@example.invalid")
            keys = KeychainStore(service: name)
            let transport = self.transport
            connection = ConnectionRuntime(keychain: keys,
                preferences: PreferencesStore(defaults: UserDefaults(suiteName: name)!), transportFactory: { _ in transport })
            connection.send(.linkCompleted(identity, credential: "tm1_synthetic", generation: connection.currentGeneration))
        }
        func close() {
            connection.send(.userDisconnect)
            keys.delete(for: identity)
            keys.deleteRecordingProof(for: identity)
            UserDefaults.standard.removePersistentDomain(forName: name)
        }
    }
}

private final class RecordingApprovalFixtureTransport: CompanionTransport {
    private let lock = NSLock()
    private var storedStatus = "approved"
    private var storedFailure = false
    private var attempts: [String] = []
    private var creations = 0
    var responseStatus: String {
        get { lock.lock(); defer { lock.unlock() }; return storedStatus }
        set { lock.lock(); storedStatus = newValue; lock.unlock() }
    }
    var failStatus: Bool {
        get { lock.lock(); defer { lock.unlock() }; return storedFailure }
        set { lock.lock(); storedFailure = newValue; lock.unlock() }
    }
    var statusAttempts: [String] { lock.lock(); defer { lock.unlock() }; return attempts }
    var createAttempts: Int { lock.lock(); defer { lock.unlock() }; return creations }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { try response(request) }
    private func response(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        lock.lock(); defer { lock.unlock() }
        guard let url = request.url else { throw URLError(.badURL) }
        let body: [String: Any]
        if url.path.hasSuffix("recording-capability/status") {
            guard let data = request.httpBody,
                  let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let attempt = input["attemptId"] as? String else { throw URLError(.badServerResponse) }
            attempts.append(attempt)
            if storedFailure { throw URLError(.timedOut) }
            body = ["status": storedStatus, "policyVersion": 1, "revision": 7]
        } else if url.path.hasSuffix("recording-capability/attempt") {
            creations += 1
            throw URLError(.badServerResponse)
        } else if url.path.hasSuffix("heartbeat") {
            body = ["device": ["id": "5372c777-bb4e-4d83-a42e-4df01b9f4144", "displayName": "Synthetic Mac"],
                "account": ["name": "Fixture", "email": "fixture@example.invalid"],
                "serverTime": ServerTime.format(Date()), "expiresAt": ServerTime.format(Date().addingTimeInterval(3600))]
        } else { throw URLError(.unsupportedURL) }
        return (try JSONSerialization.data(withJSONObject: body),
            HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
}
