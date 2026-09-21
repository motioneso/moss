import XCTest
@testable import TrailMarker

final class LinkAttemptTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private let identity = LinkedIdentity(
        instance: try! InstanceURL.parse("https://moss.example.com").get(),
        deviceId: "device-1",
        accountName: "Ben",
        accountEmail: "ben@example.com"
    )

    func testLinkCompletedWithAStaleGenerationDoesNotStoreACredential() {
        var machine = ConnectionMachine(state: .notLinked, generation: 1)

        let effects = machine.handle(
            .linkCompleted(identity, credential: "tm1_secret", generation: 0),
            now: now
        )

        XCTAssertEqual(effects, [])
        XCTAssertEqual(machine.state, .notLinked)
    }

    func testLinkCompletedWithTheCurrentGenerationStoresTheCredential() {
        var machine = ConnectionMachine(state: .notLinked, generation: 0)

        let effects = machine.handle(
            .linkCompleted(identity, credential: "tm1_secret", generation: 0),
            now: now
        )

        XCTAssertEqual(machine.state, .connected(lastContact: now))
        XCTAssertTrue(effects.contains(.storeCredential("tm1_secret", identity)))
    }

    func testVerifierIsFortyThreeBase64URLCharacters() {
        let attempt = LinkAttempt()
        XCTAssertEqual(attempt.verifier.count, 43)
        XCTAssertTrue(attempt.verifier.allSatisfy {
            $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_"
        })
    }

    func testVerifierHashMatchesTheServerRule() {
        // Test vector: sha256Base64url from packages/auth/src/companion-crypto.ts, verified
        // against Node's crypto.createHash("sha256").update("hello", "utf8").digest("base64url").
        XCTAssertEqual(
            LinkAttempt.hash("hello"),
            "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
        )
    }
}
