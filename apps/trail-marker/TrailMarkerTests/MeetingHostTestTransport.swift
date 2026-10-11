import Foundation
@testable import TrailMarker

struct ResumeFixtureRejection: Error {}

final class FixtureServer {
    static let baseTime = Date(timeIntervalSince1970: 1_791_259_200)
    let grantId = UUID().uuidString.lowercased()
    let meetingId = UUID().uuidString.lowercased()
    let ownerId = UUID().uuidString.lowercased()
    let deviceId = "37c0998f-b3cc-46f8-93de-3d938375b09e"
    private let lock = NSLock()
    private var desired = "recording"
    private var generation = 1
    private var epoch = 1
    private var holdStatus = false
    private var loseResumeReply = false
    private var rejectResumeRequest = false
    private var denyResumeRequest = false
    private var enforceObservedPause = false
    private var resumes: [String] = []
    private var acceptedResumeKeys: Set<String> = []
    private var hashes: [String] = []
    private var stops = 0
    private var controls = 0
    private var requests = 0
    private var finished = false
    private var observation: MeetingCaptureObserved?
    private var audioFailure: (code: String, reason: String, gapReason: String)?
    private var elapsedMs: UInt64 = 1000
    private var audioRequests = 0
    private var gaps: [MeetingCaptureGap] = []
    private var gapReports: [MeetingCaptureGap] = []
    private var sourceRequests: [Data] = []
    private var acceptedSourceKeys: Set<String> = []
    private var selectionOverride: MeetingCaptureChoice?
    private var loseSourceReplies = 0
    private var denySourceRequest = false
    private var sourceRequestUnavailable = false
    private var statusRequests = 0
    private var epochStartMs: UInt64 = 0
    private var nextStatusDelay: TimeInterval = 0
    private var heldRecordingGeneration: Int?
    private var heldRecordingReplies: [() -> Void] = []
    private var holdRecoveryControl = false
    private var heldRecoveryReplies: [() -> Void] = []
    private var audioRequestBodies: [[String: Any]] = []
    private var strictGapBounds = false
    private var epochStarts: [Int: UInt64] = [1: 0]
    private var epochEnds: [Int: UInt64] = [:]
    private var epochSelections: [Int: MeetingCaptureChoice] = [:]
    private var stopCutoffMs: UInt64?
    private var rejectedGaps = 0
    private var mismatchSourceControl = false
    private var mismatchSourceStatus = false
    var rejectedGapCount: Int { lock.lock(); defer { lock.unlock() }; return rejectedGaps }
    func validateGapBoundsStrictly() {
        lock.lock(); defer { lock.unlock() }
        strictGapBounds = true
        epochSelections[epoch] = selectionOverride ?? command.selection
    }
    func mismatchSourceReplies(control: Bool = false, status: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        mismatchSourceControl = control; mismatchSourceStatus = status
    }
    var sourceBodies: [Data] { lock.lock(); defer { lock.unlock() }; return sourceRequests }
    var audioBodies: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return audioRequestBodies }
    func holdRecoveryReplies() { lock.lock(); holdRecoveryControl = true; lock.unlock() }
    var heldRecoveryReplyCount: Int { lock.lock(); defer { lock.unlock() }; return heldRecoveryReplies.count }
    func holdRecoveryReply(path: String, body: [String: Any], deliver: @escaping () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard holdRecoveryControl, path.hasSuffix("/control"), body["command"] as? String == "recover-sources" else { return false }
        heldRecoveryReplies.append(deliver)
        return true
    }
    func releaseRecoveryReplies() {
        lock.lock()
        holdRecoveryControl = false
        let replies = heldRecoveryReplies
        heldRecoveryReplies.removeAll()
        lock.unlock()
        replies.forEach { $0() }
    }
    var statusCount: Int { lock.lock(); defer { lock.unlock() }; return statusRequests }
    var captureEpoch: Int { lock.lock(); defer { lock.unlock() }; return epoch }
    func setSelection(_ selection: MeetingCaptureChoice) { lock.lock(); selectionOverride = selection; lock.unlock() }
    func configureSource(loseReplies: Int = 0, deny: Bool = false, unavailable: Bool = false, holdStatus: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        loseSourceReplies = loseReplies; denySourceRequest = deny; sourceRequestUnavailable = unavailable
        self.holdStatus = holdStatus; enforceObservedPause = true
    }
    func delayNextStatus(_ interval: TimeInterval) { lock.lock(); nextStatusDelay = interval; lock.unlock() }
    func takeStatusDelay(path: String) -> TimeInterval {
        lock.lock(); defer { lock.unlock() }
        guard path.hasSuffix("/status") else { return 0 }
        let result = nextStatusDelay; nextStatusDelay = 0; return result
    }
    func holdRecordingStatusReplies(forGeneration generation: Int) {
        lock.lock(); heldRecordingGeneration = generation; lock.unlock()
    }
    var heldRecordingStatusCount: Int { lock.lock(); defer { lock.unlock() }; return heldRecordingReplies.count }
    func holdRecordingStatusReply(path: String, body: [String: Any], deliver: @escaping () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard path.hasSuffix("/status"), let generation = heldRecordingGeneration,
              let observed = body["observed"] as? [String: Any], observed["phase"] as? String == "recording",
              observed["generation"] as? Int == generation else { return false }
        heldRecordingReplies.append(deliver)
        return true
    }
    func releaseRecordingStatusReplies() {
        lock.lock()
        heldRecordingGeneration = nil
        let replies = heldRecordingReplies
        heldRecordingReplies.removeAll()
        lock.unlock()
        for reply in replies { reply() }
    }
    var loseFirstClaim = false
    var resumeKeys: [String] { lock.lock(); defer { lock.unlock() }; return resumes }
    var captureGeneration: Int { lock.lock(); defer { lock.unlock() }; return generation }
    func advanceElapsed(to value: UInt64) { lock.lock(); elapsedMs = value; lock.unlock() }
    func configureResume(holdStatus: Bool, loseReply: Bool = false, rejectRequest: Bool = false, denyRequest: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        self.holdStatus = holdStatus; loseResumeReply = loseReply; rejectResumeRequest = rejectRequest
        enforceObservedPause = true; denyResumeRequest = denyRequest
    }
    var stopCount: Int { lock.lock(); defer { lock.unlock() }; return stops }
    var controlCount: Int { lock.lock(); defer { lock.unlock() }; return controls }
    var requestCount: Int { lock.lock(); defer { lock.unlock() }; return requests }
    var finalized: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    var claimHashes: [String] { lock.lock(); defer { lock.unlock() }; return hashes }
    var lastObservation: MeetingCaptureObserved? { lock.lock(); defer { lock.unlock() }; return observation }
    var audioCount: Int { lock.lock(); defer { lock.unlock() }; return audioRequests }
    var retainedGaps: [MeetingCaptureGap] { lock.lock(); defer { lock.unlock() }; return gaps }
    var reportedGaps: [MeetingCaptureGap] { lock.lock(); defer { lock.unlock() }; return gapReports }
    var command: MeetingRecordingCommand {
        .init(meetingId: meetingId, grantId: grantId, ownerUserId: ownerId,
            expiresAt: ServerTime.format(Self.baseTime.addingTimeInterval(60)),
            selection: .init(mode: "microphone-only", microphone: .init(deviceId: "mic-uid", sourceId: "mic"),
                outputSourceId: nil, appProcessTreeId: nil, scope: nil), capabilityRevision: 1)
    }
    func browserState(_ state: String, generation: Int) {
        lock.lock(); desired = state; self.generation = generation; lock.unlock()
    }
    func failAudio(code: String, reason: String, gapReason: String, elapsedMs: UInt64) {
        lock.lock(); audioFailure = (code, reason, gapReason); self.elapsedMs = elapsedMs; lock.unlock()
    }
    func reply(path: String, body: [String: Any]) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        requests += 1
        if path.hasSuffix("/status") { statusRequests += 1 }
        if path.hasSuffix("/status"), holdStatus { throw URLError(.timedOut) }
        if path.hasSuffix("/audio"), let failure = audioFailure,
           let requestKey = body["requestKey"] as? String, let source = body["sourceId"] as? String,
           let epoch = body["epoch"] as? UInt64, let start = body["startMs"] as? UInt64,
           let end = body["endMs"] as? UInt64 {
            audioRequests += 1
            gaps.append(.init(id: requestKey, sourceId: source, epoch: epoch, startMs: start, endMs: end,
                reason: failure.gapReason))
            return try JSONSerialization.data(withJSONObject: ["requestKey": requestKey, "status": "failed", "code": failure.code,
                "reason": failure.reason, "retryable": false])
        }
        if path.hasSuffix("/status"), let reports = body["gaps"] as? [[String: Any]] {
            let decoded = try JSONDecoder().decode([MeetingCaptureGap].self, from: JSONSerialization.data(withJSONObject: reports))
            gapReports.append(contentsOf: decoded)
            for gap in decoded {
                if strictGapBounds {
                    let sourceEpoch = Int(gap.epoch)
                    let nextStart = epochStarts.filter { $0.key > sourceEpoch }.min { $0.key < $1.key }?.value
                    let upperBound = min(nextStart ?? elapsedMs, min(stopCutoffMs ?? elapsedMs, elapsedMs))
                    let selection = epochSelections[sourceEpoch]
                    let sources = [selection?.microphone?.sourceId, selection?.outputSourceId].compactMap { $0 }
                    guard let start = epochStarts[sourceEpoch], gap.startMs >= start,
                          gap.endMs > gap.startMs, gap.endMs <= upperBound, sources.contains(gap.sourceId) else {
                        rejectedGaps += 1
                        throw ResumeFixtureRejection()
                    }
                }
                if let existing = gaps.first(where: { $0.id == gap.id }) {
                    guard existing == gap else { throw URLError(.badServerResponse) }
                } else { gaps.append(gap) }
            }
        }
        if path.hasSuffix("/control") { controls += 1 }
        if path.hasSuffix("/claim") {
            guard let hash = body["credentialHash"] as? String, hashes.first.map({ $0 == hash }) ?? true else {
                throw URLError(.badServerResponse)
            }
            hashes.append(hash)
            if loseFirstClaim, hashes.count == 1 { throw URLError(.timedOut) }
        }
        if path.hasSuffix("/control"), let command = body["command"] as? String {
            if ["change-sources", "recover-sources"].contains(command), let key = body["requestKey"] as? String {
                sourceRequests.append(try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
                if sourceRequestUnavailable { throw URLError(.timedOut) }
                if denySourceRequest { throw ResumeFixtureRejection() }
                if !acceptedSourceKeys.contains(key) {
                    guard body["expectedGeneration"] as? Int == generation,
                          body["expectedEpoch"] as? Int == epoch, let selected = body["selection"] else {
                        throw ResumeFixtureRejection()
                    }
                    if command == "recover-sources" {
                        let requested = try JSONDecoder().decode(MeetingCaptureChoice.self,
                            from: JSONSerialization.data(withJSONObject: selected))
                        guard desired == "recording", requested == (selectionOverride ?? self.command.selection) else {
                            throw ResumeFixtureRejection()
                        }
                    }
                    epochSelections[epoch] = selectionOverride ?? self.command.selection
                    epochEnds[epoch] = epochEnds[epoch] ?? elapsedMs
                    selectionOverride = try JSONDecoder().decode(MeetingCaptureChoice.self,
                        from: JSONSerialization.data(withJSONObject: selected))
                    generation += 1; epoch += 1; epochStartMs = elapsedMs; acceptedSourceKeys.insert(key)
                    epochStarts[epoch] = elapsedMs; epochSelections[epoch] = selectionOverride
                    if desired == "paused" { epochEnds[epoch] = elapsedMs }
                }
                if loseSourceReplies > 0 { loseSourceReplies -= 1; throw URLError(.timedOut) }
            } else if command == "record", let key = body["requestKey"] as? String {
                resumes.append(key)
                if rejectResumeRequest { throw URLError(.timedOut) }
                if denyResumeRequest { throw ResumeFixtureRejection() }
                if !acceptedResumeKeys.contains(key) {
                    guard desired == "paused", body["expectedGeneration"] as? Int == generation,
                          body["selection"] == nil else { throw URLError(.badServerResponse) }
                    desired = "recording"; generation += 1; epoch += 1; epochStartMs = elapsedMs; acceptedResumeKeys.insert(key)
                    epochStarts[epoch] = elapsedMs; epochSelections[epoch] = selectionOverride ?? self.command.selection
                }
                if loseResumeReply { loseResumeReply = false; throw URLError(.timedOut) }
            } else if command == "pause" {
                if strictGapBounds, body["expectedGeneration"] as? Int != generation { throw ResumeFixtureRejection() }
                desired = "paused"; generation += 1
                epochEnds[epoch] = epochEnds[epoch] ?? elapsedMs
            } else if command == "stop" {
                if strictGapBounds, body["expectedGeneration"] as? Int != generation { throw ResumeFixtureRejection() }
                desired = "stopped"; generation += 1; stops += 1
                epochEnds[epoch] = epochEnds[epoch] ?? elapsedMs; stopCutoffMs = elapsedMs
            }
        }
        if path.hasSuffix("/status"), body["finalized"] as? Bool == true { finished = true }
        if path.hasSuffix("/status"), let observed = body["observed"] as? [String: Any] {
            observation = try JSONDecoder().decode(MeetingCaptureObserved.self,
                from: JSONSerialization.data(withJSONObject: observed))
            if enforceObservedPause, observation?.generation == generation,
               observation?.phase == "paused", desired == "recording" {
                desired = "paused"; generation += 1
                epochEnds[epoch] = epochEnds[epoch] ?? elapsedMs
            }
        }
        if path.hasSuffix("/audio"), let key = body["requestKey"] as? String {
            audioRequests += 1
            audioRequestBodies.append(body)
            return try JSONSerialization.data(withJSONObject: ["requestKey": key, "status": "saved", "replayed": false,
                "receipt": ["version": 1, "cursor": 1, "transcriptRevision": 1, "stopCutoffMs": NSNull()]])
        }
        let mismatch = (path.hasSuffix("/control") && body["command"] as? String == "change-sources" && mismatchSourceControl) ||
            (path.hasSuffix("/status") && mismatchSourceStatus)
        let selection = try JSONSerialization.jsonObject(with: JSONEncoder().encode(mismatch ? command.selection : selectionOverride ?? command.selection))
        var capture: [String: Any] = ["grantId": grantId, "deviceId": deviceId, "deviceName": "Synthetic Mac",
            "generation": generation, "epoch": epoch, "desired": desired, "selection": selection,
            "epochStartMs": epochStartMs, "expiresAt": ServerTime.format(Self.baseTime.addingTimeInterval(7200)),
            "serverTime": ServerTime.format(Self.baseTime), "elapsedMs": elapsedMs, "leaseMs": 30000,
            "gaps": try JSONSerialization.jsonObject(with: JSONEncoder().encode(gaps)), "gapLimitReached": false,
            "finalization": desired == "stopped" ? (finished ? "complete" : "pending") : "none"]
        if desired == "paused" { capture["epochEndMs"] = strictGapBounds ? epochEnds[epoch] ?? elapsedMs : max(1000, epochStartMs) }
        if desired == "stopped" {
            capture["stopCutoffMs"] = strictGapBounds ? stopCutoffMs ?? elapsedMs : 1000
            capture["epochEndMs"] = strictGapBounds ? epochEnds[epoch] ?? elapsedMs : 1000
        }
        var reply: [String: Any] = ["capture": capture]
        if path.hasSuffix("/claim") {
            reply["meetingId"] = meetingId; reply["grantId"] = grantId
            reply["expiresAt"] = ServerTime.format(Self.baseTime.addingTimeInterval(7200))
        }
        return try JSONSerialization.data(withJSONObject: reply)
    }
}

final class HostLifecycleProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var servers: [String: FixtureServer] = [:]
    static func register(_ server: FixtureServer) { lock.lock(); servers[server.grantId] = server; lock.unlock() }
    static func remove(_ id: String) { lock.lock(); servers[id] = nil; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "moss.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let bytes: Data
            if let data = request.httpBody { bytes = data }
            else if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    if count <= 0 { break }
                    data.append(contentsOf: buffer.prefix(count))
                }
                bytes = data
            } else { throw URLError(.badServerResponse) }
            guard let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let grantId = body["grantId"] as? String else { throw URLError(.badServerResponse) }
            Self.lock.lock(); let server = Self.servers[grantId]; Self.lock.unlock()
            guard let server else { throw URLError(.badServerResponse) }
            let data = try server.reply(path: request.url!.path, body: body)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            let deliver: () -> Void = {
                self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: data)
                self.client?.urlProtocolDidFinishLoading(self)
            }
            if server.holdRecordingStatusReply(path: request.url!.path, body: body, deliver: deliver) { return }
            if server.holdRecoveryReply(path: request.url!.path, body: body, deliver: deliver) { return }
            let delay = server.takeStatusDelay(path: request.url!.path)
            if delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: deliver) }
            else { deliver() }
        } catch is ResumeFixtureRejection {
            let response = HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
