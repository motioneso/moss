import AppKit
import Foundation
import XCTest
@testable import TrailMarker

/// Runs the actual host task/control loop through a synthetic URLProtocol. No source reader,
/// microphone permission API, actual Keychain item, hardware or real network is used.
@MainActor
final class MeetingHostLifecycleTests: XCTestCase {
    func testStopDuringPermissionWaitRejectsLateGrantAndAllowsNextStart() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "OS permission requested by explicit Start")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            let granted = await withCheckedContinuation { permission = $0 }
            fixture.permission = .granted
            return granted
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let authority = try await fixture.claimWithLostResponseRetry()
        try host.acceptStart(fixture.server.command, claim: authority, credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        XCTAssertEqual(fixture.device.starts, 0)
        XCTAssertTrue(host.canStop)
        host.stopFromUserClick()
        try await waitUntil { fixture.server.stopCount == 1 }
        permission?.resume(returning: true)
        permission = nil
        try await waitUntil(timeout: 4) { fixture.server.finalized && host.phase == .stopped }
        XCTAssertEqual(fixture.device.starts, 0, "Late permission must not open either source")
        XCTAssertEqual(fixture.server.claimHashes.count, 2)
        XCTAssertEqual(Set(fixture.server.claimHashes).count, 1, "Lost claim response retries exact local authority")

        // A second explicit Start can use the same host/connection after finalization.
        let next = FixtureServer()
        HostLifecycleProtocol.register(next)
        defer { HostLifecycleProtocol.remove(next.grantId) }
        let nextPending = MeetingPendingStart(command: next.command, connectionId: "connection", deviceId: next.deviceId, secret: String(repeating: "n", count: 43))
        let claim = try await fixture.client.claim(nextPending.body(verifier: String(repeating: "v", count: 43)),
            companionCredential: "tm1_synthetic", recordingProof: String(repeating: "p", count: 43))
        try host.acceptStart(next.command, claim: claim, credential: nextPending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        XCTAssertEqual(fixture.device.starts, 1)
        host.stopFromUserClick()
        try await waitUntil(timeout: 6) { next.finalized }
    }

    func testExpiredStartDuringPermissionWaitOnlyStopsAndFinalizes() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "Permission wait")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            return await withCheckedContinuation { permission = $0 }
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        fixture.wall = fixture.wall.addingTimeInterval(61)
        // Isolate the Start's wall-clock deadline from the independent monotonic lease.
        // A separate test below expires that lease while the same permission is pending.
        fixture.monotonic += 1_000_000_000
        permission?.resume(returning: true)
        permission = nil
        try await waitUntil(timeout: 4) { fixture.server.finalized && host.phase == .stopped }
        XCTAssertEqual(fixture.server.stopCount, 1)
        XCTAssertEqual(fixture.device.starts, 0)
    }

    func testConnectionTeardownDuringPermissionWaitCannotRestartOldSession() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "Permission wait")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            return await withCheckedContinuation { permission = $0 }
        }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        XCTAssertTrue(host.shutdown(reason: "Connection ended"))
        permission?.resume(returning: true)
        permission = nil
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(fixture.device.starts, 0)
        XCTAssertEqual(host.phase, .stopped)
        XCTAssertFalse(host.canStop)
    }

    func testPausedClaimWaitsForExplicitResumeWithoutUsingExpiredInitialStart() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.server.browserState("paused", generation: 2)
        var permissionRequests = 0
        let host = fixture.host {
            permissionRequests += 1
            fixture.permission = .granted
            return true
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .paused }
        XCTAssertEqual(permissionRequests, 0)
        XCTAssertEqual(fixture.device.starts, 0)
        fixture.wall = fixture.wall.addingTimeInterval(61)
        fixture.server.browserState("recording", generation: 3)
        try await waitUntil(timeout: 4) { host.phase == .recording }
        XCTAssertEqual(permissionRequests, 1)
        XCTAssertEqual(fixture.device.starts, 1)
    }

    func testRecoveredStoppedClaimNeverRequestsPermissionOrOpensHardware() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.server.browserState("stopped", generation: 2)
        let host = fixture.host { XCTFail("Stopped authority cannot request microphone permission"); return true }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let claim = try await fixture.claim()
        try host.acceptStart(fixture.server.command, claim: claim, credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil(timeout: 4) { fixture.server.finalized && host.phase == .stopped }
        XCTAssertEqual(fixture.device.starts, 0)
    }

    func testAcceptedStartShowsPillAndDotThroughPauseThenStopClearsBoth() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { XCTFail("No new Mac confirmation"); return false }
        defer { host.shutdown(reason: "Synthetic test finished") }
        let pill = MeetingRecordingPillController(host: host)
        let status = MeetingCaptureStatusItem(host: host, showControls: {})
        XCTAssertFalse(pill.panel.isVisible)
        XCTAssertFalse(host.recordingPresentation.showsPill, "Linking alone never presents recording")
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        XCTAssertTrue(host.recordingPresentation.showsPill)
        XCTAssertTrue(pill.panel.isVisible, "The actual panel follows accepted Start")
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        host.hideRecordingPill()
        XCTAssertFalse(pill.panel.isVisible, "Hide orders out only the panel")
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        try await waitUntil { host.phase == .recording }
        host.pauseFromUserClick()
        XCTAssertEqual(host.phase, .paused)
        host.open(URL(string: "moss-meeting://invalid")!)
        XCTAssertEqual(host.phase, .paused, "An invalid activation must not hide the current session's Stop control")
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        try await waitUntil { status.item.button?.attributedTitle.string == "● Meeting" }
        XCTAssertEqual(status.item.button?.attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, .systemRed)
        XCTAssertTrue(status.item.menu?.items.first(where: { $0.title == "Stop recording" })?.isEnabled == true)
        XCTAssertTrue(host.canStop)
        host.stopFromUserClick()
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        try await waitUntil { status.item.button?.attributedTitle.string == "Meeting" }
    }

    func testEveryIdentityStopPathClearsSurfacesAndDiscardsUnsentAudio() async throws {
        let another = LinkedIdentity(instance: try InstanceURL.parse("https://moss.example").get(),
            deviceId: "another-device", accountName: "Fixture", accountEmail: "another@example.invalid")
        let events: [ConnectionEvent] = [.userLogout, .userDisconnect, .userQuit,
            .heartbeatFailed(.credentialInvalid, generation: 0),
            .heartbeatFailed(.accountBlocked(code: "account_deactivated"), generation: 0),
            .linkCompleted(another, credential: "tm1_synthetic", generation: 0)]
        for event in events {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let host = fixture.host { false }
            defer { host.shutdown(reason: "Synthetic test finished") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
            buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
            XCTAssertNotNil(buffer.peek())
            XCTAssertTrue(host.beforeConnectionEvent(event))
            XCTAssertFalse(host.recordingPresentation.showsPill)
            XCTAssertFalse(host.recordingPresentation.showsRedDot)
            XCTAssertNil(buffer.peek(), "Terminal identity path must discard unsent audio")
        }
    }

    func testLeaseExpiryClearsPausedSessionAndDropsItsRetainedAudio() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
        host.pauseFromUserClick()
        XCTAssertTrue(host.recordingPresentation.showsRedDot)
        fixture.monotonic += 30_000_000_000
        host.service()
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        XCTAssertNil(buffer.peek())
        XCTAssertEqual(host.phase, .stopped)
    }

    func testBrowserRevocationStopsPillDotAndActualCapture() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let host = fixture.host { false }
        defer { host.shutdown(reason: "Synthetic test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
        buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
        fixture.server.browserState("revoked", generation: 2)
        try await waitUntil(timeout: 4) { host.phase == .stopped }
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        XCTAssertNil(buffer.peek())
    }

    func testLeaseExpiryDuringPermissionWaitCannotStartAfterLateGrant() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let entered = expectation(description: "Permission wait")
        var permission: CheckedContinuation<Bool, Never>?
        let host = fixture.host {
            entered.fulfill()
            return await withCheckedContinuation { permission = $0 }
        }
        defer { host.shutdown(reason: "Synthetic test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        await fulfillment(of: [entered], timeout: 2)
        fixture.monotonic += 30_000_000_000
        host.service()
        permission?.resume(returning: true)
        permission = nil
        await Task.yield()
        XCTAssertEqual(host.phase, .stopped)
        XCTAssertFalse(host.recordingPresentation.showsPill)
        XCTAssertFalse(host.recordingPresentation.showsRedDot)
        XCTAssertEqual(fixture.device.starts, 0, "A late OS permission cannot renew an expired lease")
    }

    func testHardExpiryAndCleanupFailureClearBothSurfacesAndDiscardAudio() async throws {
        for cleanupFailure in [false, true] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let host = fixture.host { false }
            defer { fixture.device.failStop = false; host.shutdown(reason: "Synthetic test finished") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            let buffer = try XCTUnwrap(fixture.device.receiver as? MeetingAudioBuffer)
            buffer.receive(hostTimeNanoseconds: fixture.monotonic, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
            if cleanupFailure {
                fixture.device.failStop = true
                XCTAssertTrue(host.beforeConnectionEvent(.userLogout), "A retained driver handle cannot prevent server Unlink")
                XCTAssertTrue(host.cleanupBlocked)
            } else {
                fixture.wall = fixture.wall.addingTimeInterval(7201)
                host.service()
                XCTAssertEqual(host.phase, .stopped)
            }
            XCTAssertFalse(host.recordingPresentation.showsPill)
            XCTAssertFalse(host.recordingPresentation.showsRedDot)
            XCTAssertNil(buffer.peek())
            buffer.receive(hostTimeNanoseconds: fixture.monotonic + 100_000_000, sampleRate: 8000, frameCount: 800, sampleAt: { _ in 0.5 })
            XCTAssertNil(buffer.peek(), "Closed callbacks cannot refill after a terminal path")
        }
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(condition(), "Synthetic host did not reach the expected lifecycle state")
    }

    private final class Device: MeetingAudioCapturing {
        var starts = 0
        var failStop = false
        var receiver: MeetingAudioReceiving?
        func start(into receiver: MeetingAudioReceiving) throws { starts += 1; self.receiver = receiver }
        func stop() throws { if failStop { throw MeetingAudioFailure.cleanupFailed } }
    }

    @MainActor
    private final class Fixture {
        let server = FixtureServer()
        let device = Device()
        let client: MeetingCaptureClient
        let pending: MeetingPendingStart
        let instance: InstanceURL
        let defaultsName = "com.moss.meeting-host-tests." + UUID().uuidString
        var wall = FixtureServer.baseTime
        var monotonic: UInt64 = 10_000_000_000
        var permission: MeetingCapturePermission = .unknown

        init() throws {
            instance = try InstanceURL.parse("https://moss.example").get()
            client = Self.client(instance)
            pending = MeetingPendingStart(command: server.command, connectionId: "connection", deviceId: server.deviceId, secret: String(repeating: "s", count: 43))
            HostLifecycleProtocol.register(server)
        }
        nonisolated static func client(_ instance: InstanceURL) -> MeetingCaptureClient {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [HostLifecycleProtocol.self]
            return MeetingCaptureClient(instance: instance, configuration: configuration)
        }
        func claim() async throws -> MeetingRecordingClaimReply {
            try await client.claim(pending.body(verifier: String(repeating: "v", count: 43)),
                companionCredential: "tm1_synthetic", recordingProof: String(repeating: "p", count: 43))
        }
        func claimWithLostResponseRetry() async throws -> MeetingRecordingClaimReply {
            server.loseFirstClaim = true
            do { _ = try await claim(); XCTFail("Synthetic first reply must be lost") }
            catch { XCTAssertEqual(error as? MeetingHostError, .network) }
            return try await claim()
        }
        func host(permissionRequest: @escaping () async -> Bool) -> MeetingCaptureHost {
            let identity = LinkedIdentity(instance: instance, deviceId: server.deviceId, accountName: "Fixture", accountEmail: "fixture@example.invalid")
            let inventory = MeetingCaptureInventory(microphones: [.init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic")],
                applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
                microphonePermission: .unknown, systemAudioPermission: .unknown)
            let snapshot = MeetingInventorySnapshot(wire: inventory, microphones: ["mic-uid": 42], applications: [:],
                processes: [], audioObjects: [:], excluded: [])
            let ports = MeetingCaptureHostPorts(identity: { identity }, connectionAvailable: { true }, readInventory: { snapshot },
                microphonePermission: { self.permission }, requestMicrophone: permissionRequest,
                makeClient: Self.client, now: { self.monotonic }, wallNow: { self.wall })
            let defaults = UserDefaults(suiteName: defaultsName)!
            let connection = ConnectionRuntime(keychain: KeychainStore(service: defaultsName), preferences: PreferencesStore(defaults: defaults))
            return MeetingCaptureHost(connection: connection, ports: ports, factory: { _ in [.microphone: self.device] })
        }
        func close() {
            client.close()
            HostLifecycleProtocol.remove(server.grantId)
            UserDefaults.standard.removePersistentDomain(forName: defaultsName)
        }
    }
}

private final class FixtureServer {
    static let baseTime = Date(timeIntervalSince1970: 1_791_259_200)
    let grantId = UUID().uuidString.lowercased()
    let meetingId = UUID().uuidString.lowercased()
    let ownerId = UUID().uuidString.lowercased()
    let deviceId = "37c0998f-b3cc-46f8-93de-3d938375b09e"
    private let lock = NSLock()
    private var desired = "recording"
    private var generation = 1
    private var hashes: [String] = []
    private var stops = 0
    private var finished = false
    var loseFirstClaim = false
    var stopCount: Int { lock.lock(); defer { lock.unlock() }; return stops }
    var finalized: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    var claimHashes: [String] { lock.lock(); defer { lock.unlock() }; return hashes }
    var command: MeetingRecordingCommand {
        .init(meetingId: meetingId, grantId: grantId, ownerUserId: ownerId,
            expiresAt: ServerTime.format(Self.baseTime.addingTimeInterval(60)),
            selection: .init(mode: "microphone-only", microphone: .init(deviceId: "mic-uid", sourceId: "mic"),
                outputSourceId: nil, appProcessTreeId: nil, scope: nil), capabilityRevision: 1)
    }
    func browserState(_ state: String, generation: Int) {
        lock.lock(); desired = state; self.generation = generation; lock.unlock()
    }
    func reply(path: String, body: [String: Any]) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        if path.hasSuffix("/claim") {
            guard let hash = body["credentialHash"] as? String, hashes.first.map({ $0 == hash }) ?? true else {
                throw URLError(.badServerResponse)
            }
            hashes.append(hash)
            if loseFirstClaim, hashes.count == 1 { throw URLError(.timedOut) }
        }
        if path.hasSuffix("/control"), body["command"] as? String == "stop" {
            desired = "stopped"; generation = 2; stops += 1
        }
        if path.hasSuffix("/status"), body["finalized"] as? Bool == true { finished = true }
        let selection = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command.selection))
        var capture: [String: Any] = ["grantId": grantId, "deviceId": deviceId, "deviceName": "Synthetic Mac",
            "generation": generation, "epoch": 1, "desired": desired, "selection": selection,
            "epochStartMs": 0, "expiresAt": ServerTime.format(Self.baseTime.addingTimeInterval(7200)),
            "serverTime": ServerTime.format(Self.baseTime), "elapsedMs": 1000, "leaseMs": 30000,
            "gaps": [], "gapLimitReached": false, "finalization": desired == "stopped" ? (finished ? "complete" : "pending") : "none"]
        if desired == "stopped" { capture["stopCutoffMs"] = 1000; capture["epochEndMs"] = 1000 }
        var reply: [String: Any] = ["capture": capture]
        if path.hasSuffix("/claim") {
            reply["meetingId"] = meetingId; reply["grantId"] = grantId
            reply["expiresAt"] = ServerTime.format(Self.baseTime.addingTimeInterval(7200))
        }
        return try JSONSerialization.data(withJSONObject: reply)
    }
}

private final class HostLifecycleProtocol: URLProtocol {
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
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
