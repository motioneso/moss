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
        let store = KeychainStore()
        store.delete(for: identity())
        store.delete(for: identity(host: "other.example.com"))
        super.tearDown()
    }

    func testStoreReadDeleteRoundTrip() throws {
        let store = KeychainStore()
        let id = identity()

        try store.store(credential: "tm1_test_credential", for: id)
        XCTAssertEqual(store.read(for: id), "tm1_test_credential")

        XCTAssertTrue(store.delete(for: id))
        XCTAssertNil(store.read(for: id))
    }

    func testReadingWithADifferentIdentityReturnsNil() throws {
        let store = KeychainStore()
        let id = identity()
        let otherId = identity(host: "other.example.com")

        try store.store(credential: "tm1_test_credential", for: id)
        defer { store.delete(for: id) }

        XCTAssertNil(store.read(for: otherId))
    }
}
