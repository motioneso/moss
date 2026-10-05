import CryptoKit
import Foundation

/// A dedicated ephemeral transport: no cookies, redirects, disk cache, or provider credentials.
/// tm1 is accepted only by the two identity bootstrap methods, never capture methods.
final class MeetingCaptureClient: NSObject, URLSessionDataDelegate {
    static let maximumResponseBytes = 262144
    private struct PendingResponse {
        var bytes = Data()
        var response: URLResponse?
        var failure: Error?
        let complete: (Data?, URLResponse?, Error?) -> Void
    }
    private let lock = NSLock()
    private var pending: [Int: PendingResponse] = [:]
    private var responseHighWater = 0
    var largestBufferedResponseBytes: Int {
        lock.lock(); defer { lock.unlock() }
        return responseHighWater
    }
    private let instance: InstanceURL
    private var session: URLSession!

    init(instance: InstanceURL, configuration: URLSessionConfiguration = .ephemeral) {
        self.instance = instance
        super.init()
        let config = configuration
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 50
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func close() { session.invalidateAndCancel() }

    static func verifierHash(_ verifier: String) -> String {
        SHA256.hash(data: Data(verifier.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func link(meetingId: String, verifier: String, companionCredential: String) async throws -> MeetingCaptureLink {
        struct Body: Encodable { let meetingId: String; let verifierHash: String }
        guard companionCredential.hasPrefix("tm1_") else { throw MeetingHostError.authorizationExpired }
        return try await post("link", body: Body(meetingId: meetingId, verifierHash: Self.verifierHash(verifier)), credential: companionCredential)
    }

    func redeem(meetingId: String, challengeId: String, verifier: String,
                companionCredential: String) async throws -> MeetingCaptureRedemption {
        struct Body: Encodable { let meetingId: String; let challengeId: String; let verifier: String }
        guard companionCredential.hasPrefix("tm1_") else { throw MeetingHostError.authorizationExpired }
        return try await post("redeem", body: Body(meetingId: meetingId, challengeId: challengeId, verifier: verifier), credential: companionCredential)
    }

    func status(_ body: MeetingCaptureStatusBody, credential: String) async throws -> MeetingCaptureReply {
        try checkMeetingCredential(credential)
        return try await post("status", body: body, credential: credential)
    }

    func control(_ body: MeetingCaptureControlBody, credential: String) async throws -> MeetingCaptureReply {
        try checkMeetingCredential(credential)
        return try await post("control", body: body, credential: credential)
    }

    /// Initiates the HTTP request before returning. The runtime's serial admission boundary
    /// therefore orders a new audio send against Pause, rather than queuing a later async task.
    func beginAudio(_ body: MeetingCaptureAudioBody, credential: String,
                    completion: @escaping (Result<MeetingCaptureReceipt, Error>) -> Void) throws -> URLSessionDataTask {
        try checkMeetingCredential(credential)
        let request = try makeRequest("audio", body: body, credential: credential, timeout: 45)
        return begin(request) { data, response, error in
            completion(Self.decode(data: data, response: response, error: error))
        }
    }

    private func checkMeetingCredential(_ credential: String) throws {
        guard credential.hasPrefix("mm1_") else { throw MeetingHostError.authorizationExpired }
    }

    private func post<Body: Encodable, Reply: Decodable>(_ path: String, body: Body, credential: String) async throws -> Reply {
        let request = try makeRequest(path, body: body, credential: credential)
        do {
            return try await withCheckedThrowingContinuation { continuation in
                _ = begin(request) { data, response, error in
                    let result: Result<Reply, Error> = Self.decode(data: data, response: response, error: error)
                    continuation.resume(with: result)
                }
            }
        } catch let error as MeetingHostError { throw error }
        catch { throw MeetingHostError.network }
    }

    private func makeRequest<Body: Encodable>(_ path: String, body: Body, credential: String,
                                               timeout: TimeInterval = 8) throws -> URLRequest {
        var request = URLRequest(url: instance.endpoint("/api/meetings/capture/\(path)"))
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    private static func decode<Reply: Decodable>(data: Data?, response: URLResponse?, error: Error?) -> Result<Reply, Error> {
        if let error = error as? MeetingHostError { return .failure(error) }
        if error != nil { return .failure(MeetingHostError.network) }
        guard let response = response as? HTTPURLResponse else { return .failure(MeetingHostError.invalidResponse) }
        if response.statusCode == 401 || response.statusCode == 403 { return .failure(MeetingHostError.authorizationExpired) }
        guard (200...299).contains(response.statusCode) else { return .failure(MeetingHostError.rejected) }
        guard let data, data.count <= maximumResponseBytes, let reply = try? JSONDecoder().decode(Reply.self, from: data) else {
            return .failure(MeetingHostError.invalidResponse)
        }
        return .success(reply)
    }

    private func begin(_ request: URLRequest,
                       complete: @escaping (Data?, URLResponse?, Error?) -> Void) -> URLSessionDataTask {
        let task = session.dataTask(with: request)
        lock.lock()
        pending[task.taskIdentifier] = PendingResponse(complete: complete)
        lock.unlock()
        task.resume()
        return task
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        let oversized = response.expectedContentLength > Int64(Self.maximumResponseBytes)
        pending[dataTask.taskIdentifier]?.response = response
        if oversized { pending[dataTask.taskIdentifier]?.failure = MeetingHostError.invalidResponse }
        lock.unlock()
        completionHandler(oversized ? .cancel : .allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        var cancel = false
        if var entry = pending[dataTask.taskIdentifier] {
            if entry.failure != nil || data.count > Self.maximumResponseBytes - entry.bytes.count {
                entry.failure = MeetingHostError.invalidResponse
                cancel = true
            } else {
                entry.bytes.append(data)
                responseHighWater = max(responseHighWater, entry.bytes.count)
            }
            pending[dataTask.taskIdentifier] = entry
        }
        lock.unlock()
        if cancel { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let entry = pending.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        entry?.complete(entry?.bytes, entry?.response, entry?.failure ?? error)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum MeetingPCMEncoder {
    static func encode(_ samples: [Float]) throws -> String {
        guard !samples.isEmpty, samples.count <= 1_920_000 else { throw MeetingHostError.invalidResponse }
        var bytes = Data(capacity: samples.count * 2)
        for sample in samples {
            guard sample.isFinite else { throw MeetingHostError.invalidResponse }
            let bounded = min(1, max(-1, sample))
            let signed = Int16((Double(bounded) * (bounded < 0 ? 32768 : 32767)).rounded())
            let bits = UInt16(bitPattern: signed)
            bytes.append(UInt8(truncatingIfNeeded: bits))
            bytes.append(UInt8(truncatingIfNeeded: bits >> 8))
        }
        return bytes.base64EncodedString()
    }
}
