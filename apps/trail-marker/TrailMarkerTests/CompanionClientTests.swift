import XCTest
@testable import TrailMarker

final class CompanionClientTests: XCTestCase {
    private final class FakeTransport: CompanionTransport {
        var statusCode: Int = 200
        var body: Data = Data()
        var headers: [String: String] = [:]
        private(set) var lastRequest: URLRequest?

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            lastRequest = request
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            return (body, response)
        }
    }

    private func makeClient(_ transport: FakeTransport) -> CompanionClient {
        guard case .success(let instance) = InstanceURL.parse("https://moss.example.com") else {
            fatalError("expected a valid instance URL")
        }
        return CompanionClient(instance: instance, transport: transport)
    }

    private func jsonData(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    func testRedirectIsReportedAsRedirectedOffOrigin() async {
        let transport = FakeTransport()
        transport.statusCode = 302
        let client = makeClient(transport)

        do {
            _ = try await client.protocolVersion()
            XCTFail("expected redirectedOffOrigin")
        } catch {
            XCTAssertEqual(error as? CompanionError, .redirectedOffOrigin)
        }
    }

    func testInvalidCredentialMapsTo401Code() async {
        let transport = FakeTransport()
        transport.statusCode = 401
        transport.body = jsonData(["error": "nope", "code": "companion_credential_invalid"])
        let client = makeClient(transport)

        do {
            _ = try await client.heartbeat(credential: "tm1_x", app: "1.0", os: "14.0")
            XCTFail("expected credentialInvalid")
        } catch {
            XCTAssertEqual(error as? CompanionError, .credentialInvalid)
        }
    }

    func testAccountDeactivatedMapsToAccountBlocked() async {
        let transport = FakeTransport()
        transport.statusCode = 403
        transport.body = jsonData(["error": "nope", "code": "account_deactivated"])
        let client = makeClient(transport)

        do {
            _ = try await client.heartbeat(credential: "tm1_x", app: "1.0", os: "14.0")
            XCTFail("expected accountBlocked")
        } catch {
            XCTAssertEqual(error as? CompanionError, .accountBlocked(code: "account_deactivated"))
        }
    }

    func testRateLimitMapsToRateLimited() async {
        let transport = FakeTransport()
        transport.statusCode = 429
        transport.body = jsonData(["error": "slow down"])
        let client = makeClient(transport)

        do {
            _ = try await client.createPairAttempt(
                CreatePairAttemptRequest(
                    deviceName: "Ben's Mac", platform: "macos", appVersion: "1.0", osVersion: "14.0",
                    verifierHash: String(repeating: "a", count: 43)
                )
            )
            XCTFail("expected rateLimited")
        } catch {
            XCTAssertEqual(error as? CompanionError, .rateLimited)
        }
    }

    func testRedeemPendingIs202() async throws {
        let transport = FakeTransport()
        transport.statusCode = 202
        transport.body = jsonData(["status": "pending"])
        let client = makeClient(transport)

        let outcome = try await client.redeem(attemptId: "attempt-1", verifier: "verifier")
        XCTAssertEqual(outcome, .pending)
    }

    func testRedeemIssuedDecodesCredential() async throws {
        let transport = FakeTransport()
        transport.statusCode = 200
        transport.body = jsonData([
            "credential": "tm1_secret",
            "device": ["id": "device-1", "displayName": "Ben's Mac"],
            "account": ["name": "Ben", "email": "ben@example.com"],
            "expiresAt": "2026-12-01T00:00:00.000Z"
        ])
        let client = makeClient(transport)

        let outcome = try await client.redeem(attemptId: "attempt-1", verifier: "verifier")
        guard case .issued(let response) = outcome else {
            return XCTFail("expected .issued")
        }
        XCTAssertEqual(response.credential, "tm1_secret")
        XCTAssertEqual(response.device.displayName, "Ben's Mac")
    }

    func testUnauthenticatedRequestsCarryNoAuthorizationHeader() async throws {
        let transport = FakeTransport()
        transport.statusCode = 200
        transport.body = jsonData(["product": "moss", "companionProtocol": 1])
        let client = makeClient(transport)

        _ = try await client.protocolVersion()
        XCTAssertNil(transport.lastRequest?.value(forHTTPHeaderField: "Authorization"))
    }

    func testAuthenticatedRequestsCarryBearerCredential() async throws {
        let transport = FakeTransport()
        transport.statusCode = 200
        transport.body = jsonData([
            "device": ["id": "device-1", "displayName": "Ben's Mac"],
            "account": ["name": "Ben", "email": "ben@example.com"],
            "serverTime": "2026-12-01T00:00:00.000Z",
            "expiresAt": "2026-12-01T00:00:00.000Z"
        ])
        let client = makeClient(transport)

        _ = try await client.heartbeat(credential: "tm1_secret", app: "1.0", os: "14.0")

        XCTAssertEqual(
            transport.lastRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer tm1_secret"
        )
    }

    func testCredentialNeverAppearsInTheRequestURL() async throws {
        let transport = FakeTransport()
        transport.statusCode = 200
        transport.body = jsonData([
            "device": ["id": "device-1", "displayName": "Ben's Mac"],
            "account": ["name": "Ben", "email": "ben@example.com"],
            "serverTime": "2026-12-01T00:00:00.000Z",
            "expiresAt": "2026-12-01T00:00:00.000Z"
        ])
        let client = makeClient(transport)

        _ = try await client.heartbeat(credential: "tm1_super_secret", app: "1.0", os: "14.0")

        let request = try XCTUnwrap(transport.lastRequest)
        XCTAssertFalse(request.url!.absoluteString.contains("tm1_super_secret"))
        XCTAssertFalse(request.description.contains("tm1_super_secret"))
    }
}
