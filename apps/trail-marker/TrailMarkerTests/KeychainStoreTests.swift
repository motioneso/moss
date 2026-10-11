import XCTest
@testable import TrailMarker

final class KeychainStoreTests: XCTestCase {
    private func identity(deviceId: String = "device-1", host: String = "moss.example.com") -> LinkedIdentity {
        guard case .success(let instance) = InstanceURL.parse("https://\(host)") else {
            fatalError("expected a valid instance URL")
        }
        return LinkedIdentity(instance: instance, deviceId: deviceId, accountName: "Ben", accountEmail: "ben@example.com")
    }

    override func tearDown() {
        let store = KeychainStore(service: "com.moss.trailmarker.tests")
        store.delete(for: identity())
        store.deleteRecordingProof(for: identity())
        store.delete(for: identity(host: "other.example.com"))
        store.deleteRecordingProof(for: identity(host: "other.example.com"))
        super.tearDown()
    }

    func testStoreReadDeleteRoundTrip() throws {
        let store = KeychainStore(service: "com.moss.trailmarker.tests")
        let id = identity()

        try store.store(credential: "tm1_test_credential", for: id)
        XCTAssertEqual(store.read(for: id), "tm1_test_credential")

        XCTAssertTrue(store.delete(for: id))
        XCTAssertNil(store.read(for: id))
    }

    func testReadingWithADifferentIdentityReturnsNil() throws {
        let store = KeychainStore(service: "com.moss.trailmarker.tests")
        let id = identity()
        let otherId = identity(host: "other.example.com")

        try store.store(credential: "tm1_test_credential", for: id)
        defer { store.delete(for: id) }

        XCTAssertNil(store.read(for: otherId))
    }
    func testRecordingProofIsIndependentOfLegacyCredentialAndBoundToIdentity() throws {
        let store = KeychainStore(service: "com.moss.trailmarker.tests")
        let id = identity()
        try store.store(credential: "tm1_synthetic", for: id)
        XCTAssertNil(store.readRecordingProof(for: id))
        let proof = String(repeating: "r", count: 43)
        try store.storeRecordingProof(proof, for: id)
        XCTAssertEqual(store.readRecordingProof(for: id), proof)
        XCTAssertNil(store.readRecordingProof(for: identity(host: "other.example.com")))
        try store.store(credential: "tm1_replacement", for: id)
        XCTAssertEqual(store.readRecordingProof(for: id), proof)
        XCTAssertTrue(store.deleteRecordingProof(for: id))
        XCTAssertNil(store.readRecordingProof(for: id))
        XCTAssertEqual(store.read(for: id), "tm1_replacement")
    }

    func testPendingApprovalRetainsSameProofAndRequestKeyAcrossReread() throws {
        let store = KeychainStore(service: "com.moss.trailmarker.tests")
        let pending = PendingRecordingProof(requestKey: "synthetic-request", proof: String(repeating: "p", count: 43))
        try store.storePendingRecordingProof(pending, for: identity())
        let restored = try XCTUnwrap(store.readPendingRecordingProof(for: identity()))
        XCTAssertEqual(restored.proof, pending.proof)
        XCTAssertEqual(restored.requestKey, pending.requestKey)
        XCTAssertNil(store.readRecordingProof(for: identity()), "A pending request is not recording authority")
        store.deleteRecordingProof(for: identity())
        XCTAssertNil(store.readPendingRecordingProof(for: identity()))
    }

    func testRecordingAndPendingProofsBindCanonicalOriginIncludingPort() throws {
        let store = KeychainStore(service: "com.moss.trailmarker.tests")
        let first = identity(host: "moss.example.com")
        let second = identity(host: "moss.example.com:8443")
        let explicitDefault = identity(host: "MOSS.EXAMPLE.COM:443")
        defer { store.deleteRecordingProof(for: first); store.deleteRecordingProof(for: second) }
        try store.storeRecordingProof("first-proof", for: first)
        try store.storeRecordingProof("second-proof", for: second)
        try store.storePendingRecordingProof(.init(requestKey: "first-request", proof: "first-pending"), for: first)
        try store.storePendingRecordingProof(.init(requestKey: "second-request", proof: "second-pending"), for: second)
        XCTAssertEqual(store.readRecordingProof(for: first), "first-proof")
        XCTAssertEqual(store.readRecordingProof(for: explicitDefault), "first-proof")
        XCTAssertEqual(store.readRecordingProof(for: second), "second-proof")
        XCTAssertEqual(store.readPendingRecordingProof(for: first)?.proof, "first-pending")
        XCTAssertEqual(store.readPendingRecordingProof(for: second)?.proof, "second-pending")
        store.deleteRecordingProof(for: first)
        XCTAssertNil(store.readRecordingProof(for: first))
        XCTAssertNil(store.readPendingRecordingProof(for: first))
        XCTAssertEqual(store.readRecordingProof(for: second), "second-proof")
        XCTAssertEqual(store.readPendingRecordingProof(for: second)?.proof, "second-pending")
    }

    func testRecordingProofOriginIncludesSchemeEvenOnTheSameHostAndPort() throws {
        let store = KeychainStore(service: "com.moss.trailmarker.tests")
        let http = LinkedIdentity(instance: try InstanceURL.parse("http://localhost:8443").get(),
            deviceId: "same-device", accountName: "Fixture", accountEmail: "fixture@example.invalid")
        let https = LinkedIdentity(instance: try InstanceURL.parse("https://localhost:8443").get(),
            deviceId: "same-device", accountName: "Fixture", accountEmail: "fixture@example.invalid")
        defer { store.deleteRecordingProof(for: http); store.deleteRecordingProof(for: https) }
        try store.storeRecordingProof("http-proof", for: http)
        XCTAssertNil(store.readRecordingProof(for: https))
        try store.storeRecordingProof("https-proof", for: https)
        XCTAssertEqual(store.readRecordingProof(for: http), "http-proof")
        XCTAssertEqual(store.readRecordingProof(for: https), "https-proof")
    }

}
