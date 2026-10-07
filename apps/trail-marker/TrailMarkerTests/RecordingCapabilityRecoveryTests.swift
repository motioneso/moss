import Foundation
import XCTest
@testable import TrailMarker

/// Isolated synthetic Keychain namespace and fake companion transport. Never reads the
/// person's linked account, creates real approval, requests OS permission or contacts a server.
@MainActor
final class RecordingCapabilityRecoveryTests: XCTestCase {
    func testExistingApprovedProofNeedsNoRecoveryOrNewApproval() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try fixture.keys.storeRecordingProof(fixture.pending.proof, for: fixture.identity)
        let result = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(result, "approved")
        XCTAssertEqual(fixture.connection.recordingCredentials()?.proof, fixture.pending.proof)
        XCTAssertTrue(fixture.transport.statusAttempts.isEmpty)
        XCTAssertEqual(fixture.transport.createAttempts, 0)
        XCTAssertEqual(fixture.connection.recordingProofRevision, 0)
    }

    func testMissingCandidateRequiresRelinkWithoutCreatingApproval() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let result = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(result, "relink_required")
        XCTAssertTrue(fixture.transport.statusAttempts.isEmpty)
        XCTAssertEqual(fixture.transport.createAttempts, 0)
        XCTAssertNil(fixture.keys.readPendingRecordingProof(for: fixture.identity))
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertEqual(fixture.keys.read(for: fixture.identity), "tm1_synthetic")
    }

    func testCandidateWithoutAttemptIdRequiresRelinkWithoutCreatingApproval() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        var pending = fixture.pending
        pending.attemptId = nil
        try fixture.keys.storePendingRecordingProof(pending, for: fixture.identity)
        let result = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(result, "relink_required")
        XCTAssertTrue(fixture.transport.statusAttempts.isEmpty)
        XCTAssertEqual(fixture.transport.createAttempts, 0)
        let retained = try XCTUnwrap(fixture.keys.readPendingRecordingProof(for: fixture.identity))
        XCTAssertEqual(retained.proof, pending.proof)
        XCTAssertEqual(retained.requestKey, pending.requestKey)
        XCTAssertNil(retained.attemptId)
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertEqual(fixture.keys.read(for: fixture.identity), "tm1_synthetic")
    }

    func testPendingCandidateRequiresRelinkWithoutCreatingApproval() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
        fixture.transport.responseStatus = "pending"
        let result = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(result, "relink_required")
        assertCandidateRetained(fixture)
        XCTAssertEqual(fixture.transport.statusAttempts, [fixture.pending.attemptId!])
        XCTAssertEqual(fixture.transport.createAttempts, 0)
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertEqual(fixture.keys.read(for: fixture.identity), "tm1_synthetic")
        XCTAssertEqual(fixture.connection.recordingProofRevision, 0)
    }

    func testLostApprovalResponseThenOfflineBeyondAttemptDeadlineRecoversSameProof() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let pending = fixture.pending
        try fixture.keys.storePendingRecordingProof(pending, for: fixture.identity)
        let result = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(result, "approved")
        XCTAssertEqual(fixture.connection.recordingCredentials()?.proof, pending.proof)
        XCTAssertNil(fixture.keys.readPendingRecordingProof(for: fixture.identity))
        XCTAssertEqual(fixture.transport.statusAttempts, [pending.attemptId!])
        XCTAssertEqual(fixture.transport.createAttempts, 0, "An already approved proof must not need another consent request")
        XCTAssertEqual(fixture.connection.recordingProofRevision, 1)
        let repeated = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(repeated, "approved")
        XCTAssertEqual(fixture.transport.statusAttempts.count, 1, "Recovery is not repeated after storing the approved proof")
        XCTAssertEqual(fixture.connection.recordingProofRevision, 1)
    }

    func testUncertainExpiredAttemptStatusKeepsProofAndRequestKeyForRetry() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
        fixture.transport.failStatus = true
        do { _ = try await fixture.connection.refreshRecordingCapability(); XCTFail("Synthetic response must fail") }
        catch { /* No affirmative status was received. */ }
        assertCandidateRetained(fixture)
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertEqual(fixture.transport.createAttempts, 0)
        fixture.transport.failStatus = false
        let recovered = try await fixture.connection.refreshRecordingCapability()
        XCTAssertEqual(recovered, "approved")
        XCTAssertEqual(fixture.keys.readRecordingProof(for: fixture.identity), fixture.pending.proof)
        XCTAssertEqual(fixture.transport.statusAttempts, [fixture.pending.attemptId!, fixture.pending.attemptId!])
        XCTAssertEqual(fixture.transport.createAttempts, 0)
    }

    func testServerConfirmedExpiredOrDeniedAttemptDiscardsOnlyPendingProof() async throws {
        for status in ["expired", "denied"] {
            let fixture = try Fixture()
            defer { fixture.close() }
            try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
            fixture.transport.responseStatus = status
            let result = try await fixture.connection.refreshRecordingCapability()
            XCTAssertEqual(result, "relink_required", status)
            XCTAssertEqual(fixture.transport.statusAttempts, [fixture.pending.attemptId!])
            XCTAssertEqual(fixture.transport.createAttempts, 0)
            XCTAssertNil(fixture.keys.readPendingRecordingProof(for: fixture.identity))
            XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
            XCTAssertEqual(fixture.keys.read(for: fixture.identity), "tm1_synthetic", "Companion/Backtrack connection is independent")
            XCTAssertEqual(fixture.connection.recordingProofRevision, 0)
            let repeated = try await fixture.connection.refreshRecordingCapability()
            XCTAssertEqual(repeated, "relink_required")
            XCTAssertEqual(fixture.transport.statusAttempts.count, 1)
            XCTAssertEqual(fixture.transport.createAttempts, 0, "An explicit relink is still required after clearing a candidate")
        }
    }

    func testApprovedStatusRejectsInvalidPolicyOrRevisionWithoutReplacingCandidate() async throws {
        let invalidApprovals: [(policy: Int, revision: Int?)] = [(0, 7), (2, 7), (1, nil), (1, 0), (1, -1)]
        for invalid in invalidApprovals {
            let fixture = try Fixture()
            defer { fixture.close() }
            try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
            fixture.transport.responsePolicyVersion = invalid.policy
            fixture.transport.responseRevision = invalid.revision
            var rejected = false
            do { _ = try await fixture.connection.refreshRecordingCapability() }
            catch { rejected = (error as? MeetingHostError) == .invalidResponse }
            XCTAssertTrue(rejected, "Approval requires policy 1 and a positive server revision")
            assertCandidateRetained(fixture)
            XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
            XCTAssertEqual(fixture.keys.read(for: fixture.identity), "tm1_synthetic")
            XCTAssertEqual(fixture.transport.statusAttempts, [fixture.pending.attemptId!])
            XCTAssertEqual(fixture.transport.createAttempts, 0)
            XCTAssertEqual(fixture.connection.recordingProofRevision, 0)
        }
    }

    func testIdentitySwapIgnoresLateApprovalAndKeepsNewIdentityCandidate() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
        fixture.transport.holdStatusResponse()
        let recovery = Task { try await fixture.connection.refreshRecordingCapability() }
        defer { recovery.cancel(); fixture.transport.releaseStatusResponse() }
        try await waitForStatusRequest(fixture.transport)
        let replacement = LinkedIdentity(instance: fixture.identity.instance,
            deviceId: UUID().uuidString.lowercased(), accountName: "Another fixture", accountEmail: "other@example.invalid")
        fixture.connection.send(.linkCompleted(replacement, credential: "tm1_replacement", generation: fixture.connection.currentGeneration))
        let newCandidate = PendingRecordingProof(requestKey: UUID().uuidString.lowercased(), proof: String(repeating: "n", count: 43))
        try fixture.keys.storePendingRecordingProof(newCandidate, for: replacement)
        fixture.transport.releaseStatusResponse()
        let result = try await recovery.value
        XCTAssertEqual(result, "cancelled")
        XCTAssertEqual(fixture.connection.identity, replacement)
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertNil(fixture.keys.readPendingRecordingProof(for: fixture.identity))
        XCTAssertNil(fixture.keys.readRecordingProof(for: replacement))
        XCTAssertEqual(fixture.keys.readPendingRecordingProof(for: replacement)?.proof, newCandidate.proof)
        XCTAssertEqual(fixture.keys.read(for: replacement), "tm1_replacement")
        XCTAssertEqual(fixture.transport.createAttempts, 0)
        XCTAssertEqual(fixture.connection.recordingProofRevision, 0)
    }

    func testCancelledRecoveryIgnoresLateApprovalOrExpiry() async throws {
        for status in ["approved", "expired"] {
            let fixture = try Fixture()
            defer { fixture.close() }
            try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
            fixture.transport.responseStatus = status
            fixture.transport.holdStatusResponse()
            let recovery = Task { try await fixture.connection.refreshRecordingCapability() }
            defer { recovery.cancel(); fixture.transport.releaseStatusResponse() }
            try await waitForStatusRequest(fixture.transport)
            recovery.cancel()
            fixture.transport.releaseStatusResponse()
            let result = try await recovery.value
            XCTAssertEqual(result, "cancelled")
            assertCandidateRetained(fixture)
            XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
            XCTAssertEqual(fixture.transport.createAttempts, 0)
            XCTAssertEqual(fixture.connection.recordingProofRevision, 0)
        }
    }

    func testDisconnectedRuntimeIgnoresLateApproval() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try fixture.keys.storePendingRecordingProof(fixture.pending, for: fixture.identity)
        fixture.transport.holdStatusResponse()
        let recovery = Task { try await fixture.connection.refreshRecordingCapability() }
        defer { recovery.cancel(); fixture.transport.releaseStatusResponse() }
        try await waitForStatusRequest(fixture.transport)
        fixture.connection.send(.userDisconnect)
        fixture.transport.releaseStatusResponse()
        let result = try await recovery.value
        XCTAssertEqual(result, "cancelled")
        XCTAssertNil(fixture.connection.requestClient())
        assertCandidateRetained(fixture)
        XCTAssertNil(fixture.keys.readRecordingProof(for: fixture.identity))
        XCTAssertEqual(fixture.keys.read(for: fixture.identity), "tm1_synthetic")
        XCTAssertEqual(fixture.transport.createAttempts, 0)
        XCTAssertEqual(fixture.connection.recordingProofRevision, 0)
    }

    private func assertCandidateRetained(_ fixture: Fixture, file: StaticString = #filePath, line: UInt = #line) {
        let retained = fixture.keys.readPendingRecordingProof(for: fixture.identity)
        XCTAssertNotNil(retained, file: file, line: line)
        XCTAssertEqual(retained?.proof, fixture.pending.proof, file: file, line: line)
        XCTAssertEqual(retained?.requestKey, fixture.pending.requestKey, file: file, line: line)
        XCTAssertEqual(retained?.attemptId, fixture.pending.attemptId, file: file, line: line)
        XCTAssertEqual(retained?.expiresAt, fixture.pending.expiresAt, file: file, line: line)
    }

    private func waitForStatusRequest(_ transport: RecordingApprovalFixtureTransport) async throws {
        let deadline = Date().addingTimeInterval(2)
        while transport.statusAttempts.isEmpty, Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(transport.statusAttempts.count, 1, "Recovery did not request the persisted candidate status")
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
            connection.send(.userQuit)
            transport.releaseStatusResponse()
            if let current = connection.identity, current != identity {
                keys.delete(for: current)
                keys.deleteRecordingProof(for: current)
            }
            keys.delete(for: identity)
            keys.deleteRecordingProof(for: identity)
            UserDefaults.standard.removePersistentDomain(forName: name)
        }
    }
}

private final class RecordingApprovalFixtureTransport: CompanionTransport {
    private let lock = NSLock()
    private var storedStatus = "approved"
    private var storedPolicyVersion = 1
    private var storedRevision: Int? = 7
    private var storedFailure = false
    private var attempts: [String] = []
    private var creations = 0
    private var holdingStatus = false
    private var statusContinuation: CheckedContinuation<Void, Never>?
    var responseStatus: String {
        get { lock.lock(); defer { lock.unlock() }; return storedStatus }
        set { lock.lock(); storedStatus = newValue; lock.unlock() }
    }
    var responsePolicyVersion: Int {
        get { lock.lock(); defer { lock.unlock() }; return storedPolicyVersion }
        set { lock.lock(); storedPolicyVersion = newValue; lock.unlock() }
    }
    var responseRevision: Int? {
        get { lock.lock(); defer { lock.unlock() }; return storedRevision }
        set { lock.lock(); storedRevision = newValue; lock.unlock() }
    }
    var failStatus: Bool {
        get { lock.lock(); defer { lock.unlock() }; return storedFailure }
        set { lock.lock(); storedFailure = newValue; lock.unlock() }
    }
    var statusAttempts: [String] { lock.lock(); defer { lock.unlock() }; return attempts }
    var createAttempts: Int { lock.lock(); defer { lock.unlock() }; return creations }
    func holdStatusResponse() { lock.lock(); holdingStatus = true; lock.unlock() }
    func releaseStatusResponse() {
        lock.lock()
        holdingStatus = false
        let continuation = statusContinuation
        statusContinuation = nil
        lock.unlock()
        continuation?.resume()
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result = try response(request)
        if request.url?.path.hasSuffix("recording-capability/status") == true {
            // Deliberately return even after task cancellation, as a late transport response can.
            await withCheckedContinuation { continuation in
                lock.lock()
                if holdingStatus { statusContinuation = continuation; lock.unlock() }
                else { lock.unlock(); continuation.resume() }
            }
        }
        return result
    }
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
            var status: [String: Any] = ["status": storedStatus, "policyVersion": storedPolicyVersion]
            if let revision = storedRevision { status["revision"] = revision }
            body = status
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
