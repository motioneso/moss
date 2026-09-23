import XCTest
@testable import TrailMarker

final class CompanionClientTests: XCTestCase {
    private final class FakeTransport: CompanionTransport {
        var statusCode: Int = 200
        var body: Data = Data()
        var headers: [String: String] = [:]
        var errorToThrow: Error?
        private(set) var lastRequest: URLRequest?

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            lastRequest = request
            if let errorToThrow { throw errorToThrow }
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

    // MARK: - Focus calls (plan Task 8)

    private let contextBody: [String: Any] = [
        "block": [
            "id": "3b1f0c1e-6c1a-4f5e-9d3a-0a1b2c3d4e5f", "title": "Study AI",
            "startsAt": "2026-12-01T09:00:00.000Z", "endsAt": "2026-12-01T11:00:00.000Z"
        ],
        "judgmentReady": true
    ]

    private let judgmentBody: [String: Any] = [
        "judgmentId": "6f1f0c1e-6c1a-4f5e-9d3a-0a1b2c3d4e5f", "label": "distracted",
        "reason": "Reading an unrelated news site.", "nudge": true
    ]

    private func judgeRequest() -> FocusJudgeRequest {
        FocusJudgeRequest(
            blockId: "3b1f0c1e-6c1a-4f5e-9d3a-0a1b2c3d4e5f", appName: "Safari", windowTitle: "Some page",
            observedAt: "2026-12-01T09:30:00.000Z"
        )
    }

    func testFocusContextDecodesBlockAndReadiness() async throws {
        let transport = FakeTransport()
        transport.body = jsonData(contextBody)

        let context = try await makeClient(transport).focusContext(credential: "tm1_x")

        XCTAssertEqual(context.block?.title, "Study AI")
        XCTAssertTrue(context.judgmentReady)
        XCTAssertEqual(transport.lastRequest?.url?.path, "/api/companion/focus/context")
    }

    func testFocusContextWithNoBlockDecodesToNil() async throws {
        let transport = FakeTransport()
        transport.body = jsonData(["block": NSNull(), "judgmentReady": false])

        let context = try await makeClient(transport).focusContext(credential: "tm1_x")

        XCTAssertNil(context.block)
        XCTAssertFalse(context.judgmentReady)
    }

    func testFocusJudgeSendsExactlyTheDeclaredFieldsAndAllowsTwentyFiveSeconds() async throws {
        let transport = FakeTransport()
        transport.body = jsonData(judgmentBody)

        let judgment = try await makeClient(transport).focusJudge(credential: "tm1_x", judgeRequest())

        XCTAssertEqual(judgment.label, .distracted)
        XCTAssertTrue(judgment.nudge)
        let request = try XCTUnwrap(transport.lastRequest)
        XCTAssertEqual(request.timeoutInterval, 25)
        let sent = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any]
        XCTAssertEqual(Set(sent?.keys.map { $0 } ?? []), ["blockId", "appName", "windowTitle", "observedAt"])
    }

    func testFocusCorrectSendsVerdictAndAccepts204() async throws {
        let transport = FakeTransport()
        transport.statusCode = 204

        try await makeClient(transport).focusCorrect(
            credential: "tm1_x", judgmentId: "6f1f0c1e-6c1a-4f5e-9d3a-0a1b2c3d4e5f", verdict: .wrong
        )

        let request = try XCTUnwrap(transport.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/companion/focus/correct")
        let sent = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any]
        XCTAssertEqual(sent?["verdict"] as? String, "wrong")
    }

    func testFocusCredentialIsOnlyEverInTheAuthorizationHeader() async throws {
        for call in 0..<3 {
            let transport = FakeTransport()
            let client = makeClient(transport)
            switch call {
            case 0:
                transport.body = jsonData(contextBody)
                _ = try await client.focusContext(credential: "tm1_super_secret")
            case 1:
                transport.body = jsonData(judgmentBody)
                _ = try await client.focusJudge(credential: "tm1_super_secret", judgeRequest())
            default:
                transport.statusCode = 204
                try await client.focusCorrect(credential: "tm1_super_secret", judgmentId: "id", verdict: .right)
            }
            let request = try XCTUnwrap(transport.lastRequest)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tm1_super_secret")
            XCTAssertFalse(request.url!.absoluteString.contains("tm1_super_secret"), "call \(call)")
            XCTAssertFalse(request.description.contains("tm1_super_secret"), "call \(call)")
            if let body = request.httpBody {
                XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("tm1_super_secret"), "call \(call)")
            }
        }
    }

    func testFocusRevokedCredentialMapsToCredentialInvalid() async {
        let transport = FakeTransport()
        transport.statusCode = 401
        transport.body = jsonData(["error": "no", "code": "companion_credential_invalid"])
        await assertThrows(.credentialInvalid) {
            _ = try await self.makeClient(transport).focusContext(credential: "tm1_x")
        }
    }

    func testFocusConflictCodesMapToTheirCases() async {
        let notReady = FakeTransport()
        notReady.statusCode = 409
        notReady.body = jsonData(["error": "no", "code": "focus_not_ready"])
        await assertThrows(.focusNotReady) {
            _ = try await self.makeClient(notReady).focusJudge(credential: "tm1_x", self.judgeRequest())
        }

        let noBlock = FakeTransport()
        noBlock.statusCode = 409
        noBlock.body = jsonData(["error": "no", "code": "focus_no_block"])
        await assertThrows(.noBlock) {
            _ = try await self.makeClient(noBlock).focusJudge(credential: "tm1_x", self.judgeRequest())
        }
    }

    func testFocusFailuresNeverDecodeToAJudgment() async {
        // A 403, a 500 and a transport timeout must each throw. If any returned a default
        // judgment, a server outage could look like "focused" or, worse, produce a nudge.
        let forbidden = FakeTransport()
        forbidden.statusCode = 403
        forbidden.body = jsonData(judgmentBody)
        await assertThrows(.server(status: 403)) {
            _ = try await self.makeClient(forbidden).focusJudge(credential: "tm1_x", self.judgeRequest())
        }

        let broken = FakeTransport()
        broken.statusCode = 500
        broken.body = jsonData(judgmentBody)
        await assertThrows(.server(status: 500)) {
            _ = try await self.makeClient(broken).focusJudge(credential: "tm1_x", self.judgeRequest())
        }

        let timedOut = FakeTransport()
        timedOut.errorToThrow = URLError(.timedOut)
        await assertThrows(.unreachable) {
            _ = try await self.makeClient(timedOut).focusJudge(credential: "tm1_x", self.judgeRequest())
        }
    }

    func testAnUnknownLabelIsADecodingErrorNotAGuess() async {
        let transport = FakeTransport()
        var body = judgmentBody
        body["label"] = "productive"
        transport.body = jsonData(body)
        await assertThrows(.decoding) {
            _ = try await self.makeClient(transport).focusJudge(credential: "tm1_x", self.judgeRequest())
        }
    }

    private func assertThrows(
        _ expected: CompanionError, file: StaticString = #filePath, line: UInt = #line,
        _ work: () async throws -> Void
    ) async {
        do {
            try await work()
            XCTFail("expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? CompanionError, expected, file: file, line: line)
        }
    }
}
