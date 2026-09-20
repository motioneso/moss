import XCTest
@testable import TrailMarker

final class DiagnosticsRedactionTests: XCTestCase {
    private let credential = "tm1_super_secret_credential"
    private let verifier = String(repeating: "v", count: 43)

    func testServerErrorDescriptionNeverIncludesASecret() {
        let text = Diagnostics.describe(.server(status: 500))

        XCTAssertFalse(text.contains(credential))
        XCTAssertFalse(text.contains(verifier))
        XCTAssertFalse(text.lowercased().contains("bearer"))
    }

    func testHeartbeatFailureDiagnosticsRedactTheAuthorizationHeader() {
        var request = URLRequest(url: URL(string: "https://moss.example.com/api/companion/heartbeat")!)
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")

        let text = Diagnostics.describeHeartbeatFailure(
            .credentialInvalid, request: request, at: Date(timeIntervalSince1970: 0)
        )

        XCTAssertFalse(text.contains(credential))
        XCTAssertFalse(text.contains(verifier))
        XCTAssertFalse(text.lowercased().contains("authorization"))
        XCTAssertFalse(text.lowercased().contains("bearer"))
    }
}
