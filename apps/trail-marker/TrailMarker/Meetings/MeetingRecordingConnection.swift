import Combine
import Foundation

/// One app-lifetime command connection. Register/reconnect advertises readiness only. The only
/// path to a per-meeting credential is a fresh owner Start for this ephemeral native verifier.
@MainActor
final class MeetingRecordingConnection {
    private let connection: ConnectionRuntime
    private let reader = MeetingCaptureInventoryReader()
    private let activate: (MeetingRecordingCommand, MeetingRecordingClaimReply, String, UInt64) async throws -> Void
    private let report: (String) -> Void
    private var cancellables = Set<AnyCancellable>()
    private var task: Task<Void, Never>?
    private var client: MeetingCaptureClient?
    private var identity: LinkedIdentity?
    private var generation = 0
    private var proofRevision = -1

    init(connection: ConnectionRuntime,
         activate: @escaping (MeetingRecordingCommand, MeetingRecordingClaimReply, String, UInt64) async throws -> Void,
         report: @escaping (String) -> Void) {
        self.connection = connection
        self.activate = activate
        self.report = report
    }

    func start() {
        guard cancellables.isEmpty else { return }
        connection.$state.combineLatest(connection.$recordingProofRevision)
            .receive(on: DispatchQueue.main).sink { [weak self] _, _ in self?.reconcile() }
            .store(in: &cancellables)
    }

    private func reconcile() {
        guard let linkedIdentity = connection.identity, connection.requestClient() != nil else {
            stop()
            return
        }
        guard task == nil || identity != linkedIdentity || proofRevision != connection.recordingProofRevision else { return }
        stop()
        identity = linkedIdentity
        proofRevision = connection.recordingProofRevision
        let current = generation
        var connectionId = UUID().uuidString.lowercased()
        var verifier = LinkAttempt.makeVerifier()
        let client = MeetingCaptureClient(instance: linkedIdentity.instance)
        self.client = client
        task = Task { [weak self] in
            guard let self else { return }
            var revision: String?
            var registered = false
            var inventoryAt = Date.distantPast
            var pending: MeetingPendingStart?
            var activatedGrant: String?
            var delay: UInt64 = 0
            while !Task.isCancelled, current == self.generation {
                if delay > 0 { try? await Task.sleep(nanoseconds: delay * 1_000_000) }
                guard !Task.isCancelled, current == self.generation,
                      self.connection.identity == linkedIdentity, self.connection.requestClient() != nil else { return }
                do {
                    guard let auth = self.connection.recordingCredentials() else {
                        let approval = try await self.connection.refreshRecordingCapability()
                        guard approval == "approved" else {
                            self.report("To use Meetings, sign this Mac out in Settings → Active sessions, then connect again from Trail Marker.")
                            return
                        }
                        delay = 0
                        continue
                    }
                    if !registered || Date().timeIntervalSince(inventoryAt) >= 10 {
                        let reply = try await client.register(.init(connectionId: connectionId,
                            verifierHash: MeetingCaptureClient.verifierHash(verifier), inventory: try self.reader.read().wire),
                            companionCredential: auth.companion, recordingProof: auth.proof)
                        guard reply.connectionId == connectionId, reply.leaseMs > 0, reply.leaseMs <= 30000,
                              ServerTime.parse(reply.expiresAt).map({ $0 > Date() }) == true else { throw MeetingHostError.invalidResponse }
                        registered = true
                        inventoryAt = Date()
                    }
                    let reply = try await client.commands(.init(connectionId: connectionId, verifier: verifier,
                        revision: revision, waitMs: 10000), companionCredential: auth.companion, recordingProof: auth.proof)
                    guard !Task.isCancelled, current == self.generation else { return }
                    revision = reply.revision
                    delay = min(10000, max(1000, reply.retryAfterMs))
                    // A lost claim response may remove the command from the queue. Keep its
                    // exact local secret through bounded reconciliation, even after the Start deadline.
                    if let refreshed = reply.command, var existing = pending,
                       refreshed.grantId == existing.command.grantId {
                        try existing.refresh(refreshed, connectionId: connectionId, deviceId: auth.identity.deviceId)
                        pending = existing
                    }
                    let offered = pending?.command ?? reply.command
                    guard let command = offered, command.grantId != activatedGrant else { continue }
                    guard let deadline = ServerTime.parse(command.expiresAt) else { throw MeetingHostError.invalidResponse }
                    if deadline <= Date(), pending == nil { continue }
                    if deadline.addingTimeInterval(60) <= Date() {
                        // We still hold the attempted claim's secret, but reconciliation itself
                        // is bounded. A new connection retires any stranded old grant and fences
                        // its command, without ever opening hardware for the expired Start.
                        registered = false
                        connectionId = UUID().uuidString.lowercased()
                        verifier = LinkAttempt.makeVerifier()
                        revision = nil
                        pending = nil
                        activatedGrant = nil
                        delay = 1000
                        continue
                    }
                    guard command.generation > 0, command.generation <= 9_007_199_254_740_991,
                          UUID(uuidString: command.meetingId) != nil, UUID(uuidString: command.grantId) != nil,
                          UUID(uuidString: command.ownerUserId) != nil else { throw MeetingHostError.invalidResponse }
                    if pending == nil {
                        pending = MeetingPendingStart(command: command, connectionId: connectionId, deviceId: auth.identity.deviceId)
                    }
                    guard let claim = pending else { continue }
                    let claimSent = MeetingCaptureClock.now()
                    let authority = try await client.claim(claim.body(verifier: verifier),
                        companionCredential: auth.companion, recordingProof: auth.proof)
                    guard !Task.isCancelled, current == self.generation,
                          authority.meetingId == command.meetingId, authority.grantId == command.grantId,
                          authority.capture.deviceId == auth.identity.deviceId else { continue }
                    let clock = try MeetingCaptureClock(requestSent: claimSent, responseReceived: MeetingCaptureClock.now(),
                        elapsedMilliseconds: authority.capture.elapsedMs)
                    try await self.activate(command, authority, claim.credential, clock.originNanoseconds)
                    activatedGrant = command.grantId
                    pending = nil
                } catch {
                    guard !Task.isCancelled, current == self.generation else { return }
                    if (error as? MeetingHostError) == .authorizationExpired {
                        if registered {
                            // A connection lease may have ended while capability remains valid.
                            // Re-register a fresh verifier; it fences every old unclaimed Start.
                            registered = false
                            connectionId = UUID().uuidString.lowercased()
                            verifier = LinkAttempt.makeVerifier()
                            revision = nil
                            pending = nil
                            activatedGrant = nil
                            delay = 1000
                            continue
                        }
                        self.connection.discardRejectedRecordingProof()
                        self.report("To use Meetings, sign this Mac out in Settings → Active sessions, then connect again from Trail Marker.")
                        // A revoked capability must never be automatically re-approved.
                        return
                    }
                    if let milliseconds = (error as? MeetingHostError)?.retryDelayMilliseconds {
                        delay = min(86400000, max(1000, milliseconds))
                    } else { delay = 2000 }
                    self.report("Recording connection is reconnecting. Capture requires an explicit Start in Moss.")
                }
            }
        }
    }

    func stop() {
        generation += 1
        task?.cancel(); task = nil
        client?.close(); client = nil
        identity = nil
    }
}
