import CryptoKit
import Foundation

/// A dedicated ephemeral transport: no cookies, redirects, disk cache, or provider credentials.
/// Identity bootstrap also requires the independent recording proof; capture uses per-Start mm1.
final class MeetingCaptureClient: NSObject, URLSessionDataDelegate {
    static let maximumResponseBytes = 262144
    static let requestDeadline: TimeInterval = 12
    private struct PendingResponse {
        var bytes = Data()
        var response: URLResponse?
        var failure: Error?
        let complete: (Data?, URLResponse?, Error?) -> Void
        let deadline: DispatchWorkItem
    }
    private let lock = NSLock()
    private var pending: [Int: PendingResponse] = [:]
    private var closed = false
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
        config.timeoutIntervalForRequest = Self.requestDeadline
        config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        lock.unlock()
        session.invalidateAndCancel()
    }

    static func verifierHash(_ verifier: String) -> String {
        SHA256.hash(data: Data(verifier.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func register(_ body: MeetingRecordingConnectionBody, companionCredential: String,
                  recordingProof: String) async throws -> MeetingRecordingConnectionReply {
        try checkBootstrap(companionCredential, proof: recordingProof)
        return try await post("connection", body: body, credential: companionCredential, proof: recordingProof)
    }

    func commands(_ body: MeetingRecordingCommandsBody, companionCredential: String,
                  recordingProof: String) async throws -> MeetingRecordingCommandsReply {
        try checkBootstrap(companionCredential, proof: recordingProof)
        return try await post("commands", body: body, credential: companionCredential, proof: recordingProof)
    }

    func claim(_ body: MeetingRecordingClaimBody, companionCredential: String,
               recordingProof: String) async throws -> MeetingRecordingClaimReply {
        try checkBootstrap(companionCredential, proof: recordingProof)
        return try await post("claim", body: body, credential: companionCredential, proof: recordingProof)
    }

    private func checkBootstrap(_ credential: String, proof: String) throws {
        guard credential.hasPrefix("tm1_"), proof.count == 43,
              proof.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            throw MeetingHostError.authorizationExpired
        }
    }

    func status(_ body: MeetingCaptureStatusBody, credential: String,
                timeout: TimeInterval = MeetingCaptureClient.requestDeadline) async throws -> MeetingCaptureReply {
        try checkMeetingCredential(credential)
        return try await post("status", body: body, credential: credential, timeout: timeout)
    }

    func control(_ body: MeetingCaptureControlBody, credential: String,
                 timeout: TimeInterval = MeetingCaptureClient.requestDeadline) async throws -> MeetingCaptureReply {
        try checkMeetingCredential(credential)
        return try await post("control", body: body, credential: credential, timeout: timeout)
    }

    /// Initiates the HTTP request before returning. The runtime's serial admission boundary
    /// therefore orders a new audio send against Pause, rather than queuing a later async task.
    func beginAudio(_ body: MeetingCaptureAudioBody, credential: String,
                    completion: @escaping (Result<MeetingCaptureReceipt, Error>) -> Void) throws -> URLSessionDataTask {
        try checkMeetingCredential(credential)
        let request = try makeRequest("audio", body: body, credential: credential, timeout: 25)
        return try begin(request) { data, response, error in
            completion(Self.decode(data: data, response: response, error: error))
        }
    }

    private func checkMeetingCredential(_ credential: String) throws {
        guard credential.hasPrefix("mm1_") else { throw MeetingHostError.authorizationExpired }
    }

    private func post<Body: Encodable, Reply: Decodable>(_ path: String, body: Body, credential: String,
                                                       proof: String? = nil,
                                                       timeout: TimeInterval = MeetingCaptureClient.requestDeadline) async throws -> Reply {
        guard timeout.isFinite, timeout > 0, !Task.isCancelled else { throw MeetingHostError.network }
        let request = try makeRequest(path, body: body, credential: credential,
            timeout: min(timeout, Self.requestDeadline), proof: proof)
        let cancellation = MeetingCaptureRequestCancellation()
        do {
            return try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { continuation in
                    do {
                        let task = try begin(request) { data, response, error in
                            let result: Result<Reply, Error> = Self.decode(data: data, response: response, error: error)
                            continuation.resume(with: result)
                        }
                        cancellation.register(task)
                    } catch { continuation.resume(throwing: error) }
                }
            }, onCancel: { cancellation.cancel() })
        } catch let error as MeetingHostError { throw error }
        catch { throw MeetingHostError.network }
    }

    private func makeRequest<Body: Encodable>(_ path: String, body: Body, credential: String,
                                               timeout: TimeInterval = MeetingCaptureClient.requestDeadline, proof: String? = nil) throws -> URLRequest {
        var request = URLRequest(url: instance.endpoint("/api/meetings/capture/\(path)"))
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        if let proof { request.setValue(proof, forHTTPHeaderField: "X-Moss-Recording-Proof") }
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    private static func decode<Reply: Decodable>(data: Data?, response: URLResponse?, error: Error?) -> Result<Reply, Error> {
        if let error = error as? MeetingHostError { return .failure(error) }
        if error != nil { return .failure(MeetingHostError.network) }
        guard let response = response as? HTTPURLResponse else { return .failure(MeetingHostError.invalidResponse) }
        if response.statusCode == 401 || response.statusCode == 403 { return .failure(MeetingHostError.authorizationExpired) }
        if response.statusCode == 429 || (500...599).contains(response.statusCode) {
            return .failure(MeetingHostError.retryAfter(milliseconds: Self.retryDelay(response)))
        }
        guard (200...299).contains(response.statusCode) else { return .failure(MeetingHostError.rejected) }
        guard let data, data.count <= maximumResponseBytes, let reply = try? JSONDecoder().decode(Reply.self, from: data) else {
            return .failure(MeetingHostError.invalidResponse)
        }
        return .success(reply)
    }

    static func retryDelay(_ response: HTTPURLResponse, now: Date = Date()) -> UInt64 {
        let value = response.value(forHTTPHeaderField: "Retry-After") ?? ""
        let seconds: Double
        if let number = Double(value), number.isFinite { seconds = number }
        else {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            seconds = formatter.date(from: value)?.timeIntervalSince(now) ?? 2
        }
        return UInt64(min(86400, max(1, seconds)) * 1000)
    }

    private func begin(_ request: URLRequest,
                       complete: @escaping (Data?, URLResponse?, Error?) -> Void) throws -> URLSessionDataTask {
        // URLSession raises an Objective-C exception for task creation after invalidation.
        // Serialize creation/registration with close, including nonisolated async callers
        // that passed a host generation check before hopping off the main actor.
        lock.lock()
        guard !closed else { lock.unlock(); throw MeetingHostError.authorizationExpired }
        let task = session.dataTask(with: request)
        // URLSession's request timeout is an idle-data timeout. Enforce an absolute bound too,
        // so a trickling response cannot hold control beyond the finite capture lease.
        let deadline = DispatchWorkItem { [weak task] in task?.cancel() }
        pending[task.taskIdentifier] = PendingResponse(complete: complete, deadline: deadline)
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + request.timeoutInterval, execute: deadline)
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
        entry?.deadline.cancel()
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

/// Cancellation can arrive before URLSession creates the task. Register and cancel share
/// one lock, so neither a late registration nor a trickling response outlives the operation.
private final class MeetingCaptureRequestCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false
    func register(_ task: URLSessionDataTask) {
        lock.lock()
        self.task = task
        let cancel = cancelled
        lock.unlock()
        if cancel { task.cancel() }
    }
    func cancel() {
        lock.lock()
        cancelled = true
        let task = self.task
        lock.unlock()
        task?.cancel()
    }
}
