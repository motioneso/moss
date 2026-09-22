import Foundation

// MARK: - Wire contracts
//
// Mirrors packages/shared/src/companion-api.ts field-for-field. JSON keys are already
// camelCase, so default Codable synthesis needs no CodingKeys.

/// The protocol version this build of Trail Marker speaks. `protocolVersion()` reports what an
/// instance answers; comparing it to this is the caller's job (onboarding refuses to link when
/// they don't match).
let COMPANION_PROTOCOL_VERSION_SUPPORTED = 1

struct CreatePairAttemptRequest: Encodable {
    let deviceName: String
    let platform: String
    let appVersion: String
    let osVersion: String
    let verifierHash: String
}

struct CreatePairAttemptResponse: Decodable, Equatable {
    let attemptId: String
    let approvalPath: String
    let pollIntervalSeconds: Int
    let expiresAt: String
}

struct CompanionDeviceSummary: Decodable, Equatable {
    let id: String
    let displayName: String
}

struct CompanionAccountSummary: Decodable, Equatable {
    let name: String
    let email: String
}

struct RedeemPairAttemptRequest: Encodable {
    let attemptId: String
    let verifier: String
}

struct RedeemPairAttemptResponse: Decodable, Equatable {
    let credential: String
    let device: CompanionDeviceSummary
    let account: CompanionAccountSummary
    let expiresAt: String
}

enum RedeemOutcome: Equatable {
    case issued(RedeemPairAttemptResponse)
    case pending
    case denied
    case expired
    case redeemed
    case unknown
}

struct CompanionHeartbeatRequest: Encodable {
    let appVersion: String
    let osVersion: String
}

struct CompanionHeartbeatResponse: Decodable, Equatable {
    let device: CompanionDeviceSummary
    let account: CompanionAccountSummary
    let serverTime: String
    let expiresAt: String
}

struct RenameCompanionDeviceRequest: Encodable {
    let displayName: String
}

// MARK: - Focus wire contracts (mirror packages/shared/src/companion-api.ts, plan Task 1)

enum FocusLabel: String, Codable, Equatable {
    case focused
    case necessaryDetour = "necessary_detour"
    case distracted
    case insufficientEvidence = "insufficient_evidence"
}

enum FocusVerdict: String, Codable, Equatable {
    case right
    case wrong
}

struct FocusBlock: Decodable, Equatable {
    let id: String
    let title: String
    let startsAt: String
    let endsAt: String
}

struct FocusContext: Decodable, Equatable {
    let block: FocusBlock?
    let judgmentReady: Bool
}

struct FocusJudgeRequest: Encodable, Equatable {
    let blockId: String
    let appName: String
    let windowTitle: String
    /// Rung 3 (#2570 slice 2): a vision description, sent only when rung 1 alone answered
    /// insufficient_evidence and a capture was allowed and taken. Omitted, not null, when absent —
    /// the server schema types this field as a plain string, so a JSON `null` would fail it.
    var description: String? = nil
    let observedAt: String

    private enum CodingKeys: String, CodingKey {
        case blockId, appName, windowTitle, description, observedAt
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(blockId, forKey: .blockId)
        try container.encode(appName, forKey: .appName)
        try container.encode(windowTitle, forKey: .windowTitle)
        try container.encodeIfPresent(description, forKey: .description)
        try container.encode(observedAt, forKey: .observedAt)
    }
}

struct FocusJudgment: Decodable, Equatable {
    let judgmentId: String
    let label: FocusLabel
    let reason: String
    let nudge: Bool
}

private struct FocusCorrectRequest: Encodable {
    let judgmentId: String
    let verdict: FocusVerdict
}

private struct CompanionErrorBody: Decodable {
    let error: String
    let code: String?
}

// MARK: - Errors

enum CompanionError: Error, Equatable {
    case unreachable
    case tls
    case incompatible(protocolVersion: Int?)
    case credentialInvalid
    case accountBlocked(code: String)
    case rateLimited
    case server(status: Int)
    case redirectedOffOrigin
    case decoding
    /// The focus module is off for this person, or no judgment model is bound (409).
    case focusNotReady
    /// The block named in an observation is not the person's current Moss block (409).
    case noBlock
}

// MARK: - Transport

/// One method so tests can fake the network entirely. The real implementation never follows
/// redirects: a redirect is a condition the person sees, not something silently absorbed.
protocol CompanionTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

final class URLSessionTransport: NSObject, CompanionTransport, URLSessionTaskDelegate {
    private let session: URLSession

    override init() {
        session = URLSession(configuration: .ephemeral)
        super.init()
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request, delegate: self)
        guard let http = response as? HTTPURLResponse else {
            throw CompanionError.decoding
        }
        return (data, http)
    }

    // Returning nil here means "do not follow" — the caller sees the 3xx response itself.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}

// MARK: - Client

struct CompanionClient {
    let instance: InstanceURL
    let transport: CompanionTransport

    init(instance: InstanceURL, transport: CompanionTransport) {
        self.instance = instance
        self.transport = transport
    }

    func protocolVersion() async throws -> Int {
        struct Body: Decodable { let companionProtocol: Int }
        let request = plainRequest(path: "/api/companion/protocol", method: "POST")
        let (data, _) = try await sendChecked(request)
        return try decode(Body.self, from: data).companionProtocol
    }

    func createPairAttempt(
        _ body: CreatePairAttemptRequest
    ) async throws -> CreatePairAttemptResponse {
        let request = try jsonRequest(path: "/api/companion/pair", method: "POST", body: body)
        let (data, _) = try await sendChecked(request)
        return try decode(CreatePairAttemptResponse.self, from: data)
    }

    func redeem(attemptId: String, verifier: String) async throws -> RedeemOutcome {
        let body = RedeemPairAttemptRequest(attemptId: attemptId, verifier: verifier)
        let request = try jsonRequest(path: "/api/companion/pair/redeem", method: "POST", body: body)
        let (data, response) = try await send(request)
        switch response.statusCode {
        case 200:
            return .issued(try decode(RedeemPairAttemptResponse.self, from: data))
        case 202:
            return .pending
        case 403:
            return .denied
        case 404:
            return .unknown
        case 409:
            return .redeemed
        case 410:
            return .expired
        default:
            throw makeError(status: response.statusCode, data: data)
        }
    }

    func cancel(attemptId: String, verifier: String) async throws {
        let body = RedeemPairAttemptRequest(attemptId: attemptId, verifier: verifier)
        let request = try jsonRequest(path: "/api/companion/pair/cancel", method: "POST", body: body)
        _ = try await sendChecked(request, okStatuses: [204])
    }

    func heartbeat(credential: String, app: String, os: String) async throws -> CompanionHeartbeatResponse {
        let body = CompanionHeartbeatRequest(appVersion: app, osVersion: os)
        let request = try jsonRequest(
            path: "/api/companion/heartbeat", method: "POST", body: body, credential: credential
        )
        let (data, _) = try await sendChecked(request)
        return try decode(CompanionHeartbeatResponse.self, from: data)
    }

    func rename(credential: String, displayName: String) async throws {
        let body = RenameCompanionDeviceRequest(displayName: displayName)
        let request = try jsonRequest(
            path: "/api/companion/device", method: "PATCH", body: body, credential: credential
        )
        _ = try await sendChecked(request)
    }

    func logout(credential: String) async throws {
        let request = plainRequest(path: "/api/companion/logout", method: "POST", credential: credential)
        _ = try await sendChecked(request, okStatuses: [204])
    }

    // MARK: Focus

    /// The server answers a judgment inside the request, up to its own 20 second limit; the
    /// extra five seconds are slack so a slow answer is not mistaken for a dead network.
    static let focusJudgeTimeout: TimeInterval = 25

    func focusContext(credential: String) async throws -> FocusContext {
        let request = plainRequest(path: "/api/companion/focus/context", method: "POST", credential: credential)
        let (data, _) = try await sendChecked(request)
        return try decode(FocusContext.self, from: data)
    }

    func focusJudge(credential: String, _ body: FocusJudgeRequest) async throws -> FocusJudgment {
        var request = try jsonRequest(
            path: "/api/companion/focus/judge", method: "POST", body: body, credential: credential
        )
        request.timeoutInterval = Self.focusJudgeTimeout
        let (data, _) = try await sendChecked(request)
        return try decode(FocusJudgment.self, from: data)
    }

    func focusCorrect(credential: String, judgmentId: String, verdict: FocusVerdict) async throws {
        let body = FocusCorrectRequest(judgmentId: judgmentId, verdict: verdict)
        let request = try jsonRequest(
            path: "/api/companion/focus/correct", method: "POST", body: body, credential: credential
        )
        _ = try await sendChecked(request, okStatuses: [204])
    }

    // MARK: Request building

    private func plainRequest(path: String, method: String, credential: String? = nil) -> URLRequest {
        var request = URLRequest(url: instance.endpoint(path))
        request.httpMethod = method
        if let credential {
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func jsonRequest<Body: Encodable>(
        path: String,
        method: String,
        body: Body,
        credential: String? = nil
    ) throws -> URLRequest {
        var request = plainRequest(path: path, method: method, credential: credential)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    // MARK: Sending and error mapping

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let result: (Data, HTTPURLResponse)
        do {
            result = try await transport.send(request)
        } catch let error as CompanionError {
            throw error
        } catch {
            throw Self.mapTransportError(error)
        }
        if (300...399).contains(result.1.statusCode) {
            throw CompanionError.redirectedOffOrigin
        }
        return result
    }

    private func sendChecked(
        _ request: URLRequest,
        okStatuses: Set<Int> = [200]
    ) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await send(request)
        if okStatuses.contains(response.statusCode) {
            return (data, response)
        }
        throw makeError(status: response.statusCode, data: data)
    }

    private func makeError(status: Int, data: Data) -> CompanionError {
        let body = try? JSONDecoder().decode(CompanionErrorBody.self, from: data)
        switch status {
        case 401:
            if body?.code == "companion_credential_invalid" { return .credentialInvalid }
            return .server(status: status)
        case 403:
            if let code = body?.code, code == "account_pending_approval" || code == "account_deactivated" {
                return .accountBlocked(code: code)
            }
            return .server(status: status)
        case 409:
            switch body?.code {
            case "focus_not_ready": return .focusNotReady
            case "focus_no_block": return .noBlock
            default: return .server(status: status)
            }
        case 429:
            return .rateLimited
        default:
            return .server(status: status)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        guard let value = try? JSONDecoder().decode(T.self, from: data) else {
            throw CompanionError.decoding
        }
        return value
    }

    private static func mapTransportError(_ error: Error) -> CompanionError {
        guard let urlError = error as? URLError else { return .unreachable }
        switch urlError.code {
        case .serverCertificateUntrusted, .secureConnectionFailed, .serverCertificateHasBadDate,
            .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
            .clientCertificateRequired:
            return .tls
        default:
            return .unreachable
        }
    }
}
