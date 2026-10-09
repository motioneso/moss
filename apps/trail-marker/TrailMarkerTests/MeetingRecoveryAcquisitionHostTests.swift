import Foundation
import XCTest
@testable import TrailMarker

/// The synthetic device holds the same synchronous start boundary as Core Audio, with
/// a safety timeout so a regression produces assertions instead of hanging the runner.
private final class BlockingRecoveryDevice: MeetingAudioCapturing {
    private let lock = NSLock()
    private let release = DispatchSemaphore(value: 0)
    let entered: XCTestExpectation
    private var didReturn = false
    private var stops = 0
    private var refusesCleanup = false
    private var heldStop: XCTestExpectation?
    private let releaseStop = DispatchSemaphore(value: 0)
    init(entered: XCTestExpectation) { self.entered = entered }
    var returned: Bool { lock.lock(); defer { lock.unlock() }; return didReturn }
    var stopCount: Int { lock.lock(); defer { lock.unlock() }; return stops }
    var failCleanup: Bool {
        get { lock.lock(); defer { lock.unlock() }; return refusesCleanup }
        set { lock.lock(); refusesCleanup = newValue; lock.unlock() }
    }
    func start(into receiver: MeetingAudioReceiving) throws {
        receiver.receive(sampleTime: 0, hostTimeNanoseconds: 10_000_000_000,
            sampleRate: 8000, frameCount: 800,
            sampleAt: { _ in XCTFail("Staged acquisition must not read PCM before commitment"); return 1 })
        entered.fulfill()
        _ = release.wait(timeout: .now() + 8)
        receiver.receive(sampleTime: 800, hostTimeNanoseconds: 10_100_000_000,
            sampleRate: 8000, frameCount: 800,
            sampleAt: { _ in XCTFail("Cancelled or uncommitted acquisition must not read PCM"); return 1 })
        lock.lock(); didReturn = true; lock.unlock()
    }
    func stop() throws {
        lock.lock()
        stops += 1
        let fail = refusesCleanup
        let held = heldStop
        heldStop = nil
        lock.unlock()
        if let held {
            held.fulfill()
            _ = releaseStop.wait(timeout: .now() + 8)
        }
        if fail { throw MeetingAudioFailure.cleanupFailed }
    }
    func holdNextStop(_ expectation: XCTestExpectation) {
        lock.lock(); heldStop = expectation; lock.unlock()
    }
    func unblockStop() { releaseStop.signal() }
    func unblock() { release.signal() }
}

private final class RecoveryDeviceFactory {
    private let lock = NSLock()
    private var calls = 0
    let initial: MeetingAudioCapturing
    let replacement: MeetingAudioCapturing
    let resumed: MeetingAudioCapturing?
    init(initial: MeetingAudioCapturing, replacement: MeetingAudioCapturing, resumed: MeetingAudioCapturing? = nil) {
        self.initial = initial; self.replacement = replacement; self.resumed = resumed
    }
    func make(_ selection: MeetingNativeSelection) -> [MeetingAudioSource: MeetingAudioCapturing] {
        lock.lock(); calls += 1
        let device = calls == 1 ? initial : (calls == 2 ? replacement : resumed ?? replacement)
        lock.unlock()
        return [.microphone: device]
    }
}

@MainActor
final class MeetingRecoveryAcquisitionHostTests: XCTestCase {
    private typealias Fixture = MeetingHostLifecycleTests.Fixture
    private func waitUntil(timeout: TimeInterval = 6, _ condition: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(condition(), "Condition did not become true")
    }

    func testRecoveryPermissionFlipBetweenConsecutiveReadsNeverRequestsPermission() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        let inventory = MeetingCaptureInventory(microphones: [
            .init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic")],
            applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
            microphonePermission: .granted, systemAudioPermission: .unknown)
        let snapshot = MeetingInventorySnapshot(wire: inventory, microphones: ["mic-uid": 42],
            applications: [:], processes: [], audioObjects: [:], excluded: [])
        var checkRecovery = false
        var readsSinceInventory = 0
        var permissionRequests = 0
        let host = fixture.host(readInventory: {
            readsSinceInventory = 0
            return snapshot
        }, microphonePermission: {
            guard checkRecovery else { return .granted }
            readsSinceInventory += 1
            // Reproduce permission reset between a separate recovery guard and the
            // permission-request branch, without depending on asynchronous poll counts.
            return readsSinceInventory == 1 ? .granted : .unknown
        }) {
            permissionRequests += 1
            return false
        }
        defer { host.shutdown(reason: "Recovery permission race test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
            credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        checkRecovery = true
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        try await waitUntil { permissionRequests > 0 || (fixture.device.starts == 2 && host.phase == .recording) }
        XCTAssertEqual(permissionRequests, 0, "Automatic recovery must never request microphone permission after a permission-read race")
        XCTAssertEqual(fixture.device.starts, 2)
        XCTAssertEqual(host.phase, .recording)
    }

    func testLateAcquisitionDeadlinePausesWithoutExpiringRecordingAuthorization() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.holdRecordingStatusReplies(forGeneration: 2)
        let initial = fixture.monotonic
        let wire = MeetingCaptureInventory(microphones: [
            .init(deviceId: "mic-uid", sourceId: "mic", label: "Synthetic mic")],
            applications: [], computerAudio: .init(available: false, excludedProcessTreeIds: []),
            microphonePermission: .granted, systemAudioPermission: .unknown)
        let snapshot = MeetingInventorySnapshot(wire: wire, microphones: ["mic-uid": 42],
            applications: [:], processes: [], audioObjects: [:], excluded: [])
        var delayed = false
        let host = fixture.host(readInventory: {
            if fixture.device.starts == 2, !delayed {
                delayed = true
                fixture.monotonic = initial + 11_500_000_000
                fixture.server.advanceElapsed(to: 12500)
            }
            return snapshot
        }) { false }
        defer {
            host.shutdown(reason: "Independent recovery deadline test")
            fixture.server.releaseRecordingStatusReplies()
        }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
            credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        try await waitUntil { fixture.device.starts == 2 && host.phase == .recording }
        let receiver = try XCTUnwrap(fixture.device.receiver as? MeetingCaptureAcquisitionReceiver)
        // Starts before the episode deadline and ends after it, but well inside the real lease.
        receiver.receive(sampleTime: 0, hostTimeNanoseconds: fixture.monotonic,
            sampleRate: 8000, frameCount: 8000, sampleAt: { _ in 0.25 })
        XCTAssertNil(receiver.buffer.failure, "Recovery deadline must not become the recording authorization lease")
        guard receiver.buffer.failure == nil else { return } // A mutated lease must fail above without waiting for Resume.
        host.service()
        XCTAssertEqual(host.phase, .recording, "A callback crossing only the recovery deadline must not terminate the recording")
        XCTAssertEqual(fixture.server.audioCount, 0, "Recording observation is still unacknowledged")
        fixture.monotonic = initial + 12_100_000_000
        fixture.server.advanceElapsed(to: 13100)
        host.service()
        XCTAssertEqual(host.phase, .paused, "Recovery acknowledgment timeout must remain a resumable pause")
        XCTAssertEqual(host.message, MeetingHostError.recoveryExhausted.message,
            "Delayed recovery acknowledgment must not be reported as Moss being unreachable")
        XCTAssertNil(host.connectivityMessage)
        fixture.server.releaseRecordingStatusReplies()
        try await waitUntil { host.canResumeFromUserClick }
        host.resumeFromUserClick()
        try await waitUntil { fixture.device.starts == 3 && host.phase == .recording }
        XCTAssertEqual(fixture.server.claimHashes.count, 1, "Resume must reuse the live recording grant without a fresh Start")
        // Real authorization expiry remains terminal even after a successful explicit Resume.
        fixture.monotonic += 31_000_000_000
        host.service()
        XCTAssertEqual(host.phase, .stopped)
        XCTAssertFalse(host.canResumeFromUserClick)
    }

    func testLocalPauseReachesServerWhileAcquisitionRemainsBlocked() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let blocked = BlockingRecoveryDevice(entered: expectation(description: "Replacement start entered"))
        defer { blocked.unblock() }
        let factory = RecoveryDeviceFactory(initial: fixture.device, replacement: blocked)
        let host = fixture.host(factory: factory.make) { false }
        defer { host.shutdown(reason: "Blocked acquisition test finished") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        await fulfillment(of: [blocked.entered], timeout: 5)
        let before = Date()
        host.pauseFromUserClick()
        host.service()
        _ = fixture.runtime.snapshot
        XCTAssertLessThan(Date().timeIntervalSince(before), 0.5,
            "Pause, service and snapshots must not synchronize with blocked acquisition")
        try await waitUntil(timeout: 2) { fixture.server.controlCount >= 2 }
        XCTAssertFalse(blocked.returned, "Pause must reach Moss before the device call returns")
        XCTAssertEqual(host.phase, .paused)
        XCTAssertTrue(host.acquisitionPending)
        XCTAssertFalse(host.canResumeFromUserClick)
        blocked.unblock()
        try await waitUntil { !host.acquisitionPending }
        XCTAssertEqual(blocked.stopCount, 1)
        XCTAssertNotEqual(host.phase, .recording)
        XCTAssertEqual(fixture.server.audioCount, 0)
    }

    func testBrowserStopAndRevocationAreObservedDuringBlockedAcquisition() async throws {
        for desired in ["stopped", "revoked"] {
            let fixture = try Fixture()
            defer { fixture.close() }
            fixture.permission = .granted
            let blocked = BlockingRecoveryDevice(entered: expectation(description: "Start entered for \(desired)"))
            defer { blocked.unblock() }
            let factory = RecoveryDeviceFactory(initial: fixture.device, replacement: blocked)
            let host = fixture.host(factory: factory.make) { false }
            defer { host.shutdown(reason: "Remote cancellation test") }
            try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
            try await waitUntil { host.phase == .recording }
            fixture.device.receiver?.fail(.sourceReconfigured)
            host.service()
            await fulfillment(of: [blocked.entered], timeout: 5)
            let oldEpoch = fixture.runtime.snapshot.epoch
            fixture.server.browserState(desired, generation: 3)
            try await waitUntil(timeout: 4) { host.phase != .recovering }
            XCTAssertFalse(blocked.returned, "Polling must observe browser control without awaiting acquisition")
            XCTAssertTrue(host.acquisitionPending)
            blocked.unblock()
            try await waitUntil { !host.acquisitionPending }
            XCTAssertEqual(fixture.runtime.snapshot.epoch, oldEpoch, "Late completion cannot advance the timeline")
            XCTAssertNotEqual(host.phase, .recording)
            XCTAssertEqual(fixture.server.audioCount, 0)
        }
    }

    func testRecoveryDeadlineCancelsBlockedAcquisitionWithoutWaitingForHardware() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let blocked = BlockingRecoveryDevice(entered: expectation(description: "Start entered before deadline"))
        defer { blocked.unblock() }
        let factory = RecoveryDeviceFactory(initial: fixture.device, replacement: blocked)
        let host = fixture.host(factory: factory.make) { false }
        defer { host.shutdown(reason: "Deadline cancellation test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        await fulfillment(of: [blocked.entered], timeout: 5)
        fixture.monotonic += 12_000_000_000
        host.service()
        XCTAssertFalse(blocked.returned)
        XCTAssertEqual(host.phase, .paused)
        XCTAssertEqual(host.message, "Audio recovery could not finish. Capture is paused. Press Resume in Moss to try again.",
            "A slow native or permission answer must pause with a recovery-specific explanation")
        XCTAssertNotNil(host.interruptionWarning)
        blocked.unblock()
        try await waitUntil { !host.acquisitionPending }
        XCTAssertNotEqual(host.phase, .recording)
        XCTAssertEqual(fixture.server.audioCount, 0)
    }

    func testCancelledAcquisitionRetainsFailedCleanupUntilStopRetriesIt() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let blocked = BlockingRecoveryDevice(entered: expectation(description: "Start entered before failed cleanup"))
        defer { blocked.unblock() }
        blocked.failCleanup = true
        let factory = RecoveryDeviceFactory(initial: fixture.device, replacement: blocked)
        let host = fixture.host(factory: factory.make) { false }
        defer { host.shutdown(reason: "Cleanup ownership test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        await fulfillment(of: [blocked.entered], timeout: 5)
        host.pauseFromUserClick()
        blocked.unblock()
        try await waitUntil { host.cleanupBlocked }
        XCTAssertTrue(host.acquisitionPending)
        XCTAssertTrue(host.canStop)
        XCTAssertFalse(host.canResumeFromUserClick)
        let retryEntered = expectation(description: "Shutdown retry sampled its failing stop result")
        blocked.holdNextStop(retryEntered)
        defer { blocked.unblockStop() }
        XCTAssertFalse(host.shutdown(reason: "Must retain the unfinished cleanup barrier"))
        await fulfillment(of: [retryEntered], timeout: 2)
        let failedAttemptCount = blocked.stopCount
        blocked.failCleanup = false
        // Every click happens while the shutdown retry still owns the device and will fail.
        // They must coalesce into one newer retry, not disappear behind cleanupScheduled.
        host.stopFromUserClick()
        host.stopFromUserClick()
        host.stopFromUserClick()
        blocked.unblockStop()
        try await waitUntil { !host.acquisitionPending && !host.cleanupBlocked }
        XCTAssertEqual(host.phase, .stopped, "Stop retry must survive an overlapping failed disposal")
        XCTAssertEqual(blocked.stopCount, failedAttemptCount + 1,
            "Overlapping Stop requests must coalesce into one retained-handle retry")
    }
    func testOverlappingFailedCleanupRetryDoesNotSpinWithoutAnotherStop() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        let blocked = BlockingRecoveryDevice(entered: expectation(description: "Start entered before retry failure"))
        defer { blocked.unblock(); blocked.unblockStop() }
        blocked.failCleanup = true
        let factory = RecoveryDeviceFactory(initial: fixture.device, replacement: blocked)
        let host = fixture.host(factory: factory.make) { false }
        defer { host.shutdown(reason: "No automatic cleanup retry test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(),
            credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        await fulfillment(of: [blocked.entered], timeout: 5)
        host.pauseFromUserClick()
        blocked.unblock()
        try await waitUntil { host.cleanupBlocked }
        let retryEntered = expectation(description: "Shutdown cleanup retry held with a failing result")
        blocked.holdNextStop(retryEntered)
        XCTAssertFalse(host.shutdown(reason: "No timer or polling may retry disposal"))
        await fulfillment(of: [retryEntered], timeout: 2)
        let failedAttemptCount = blocked.stopCount
        host.stopFromUserClick()
        host.stopFromUserClick()
        blocked.unblockStop()
        try await waitUntil { host.cleanupBlocked && blocked.stopCount >= failedAttemptCount + 1 }
        // Shutdown removed the service timer. A failed coalesced retry must remain owned
        // and visibly blocked until another explicit request; it cannot schedule itself.
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(blocked.stopCount, failedAttemptCount + 1,
            "A failed coalesced cleanup retry must not retry itself without another Stop")
        XCTAssertEqual(host.phase, .error)
        XCTAssertTrue(host.acquisitionPending)
        XCTAssertTrue(host.canStop)
        XCTAssertFalse(host.canResumeFromUserClick)
        blocked.failCleanup = false
        host.stopFromUserClick()
        try await waitUntil { !host.acquisitionPending && !host.cleanupBlocked }
        XCTAssertEqual(blocked.stopCount, failedAttemptCount + 2)
        XCTAssertEqual(host.phase, .stopped)
    }

    func testStagedPermissionLossKeepsGapEpochThroughExplicitResume() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.permission = .granted
        fixture.server.validateGapBoundsStrictly()
        let blocked = BlockingRecoveryDevice(entered: expectation(description: "Start entered before permission loss"))
        defer { blocked.unblock() }
        let resumed = MeetingHostFixtureDevice()
        let factory = RecoveryDeviceFactory(initial: fixture.device, replacement: blocked, resumed: resumed)
        let host = fixture.host(factory: factory.make) { XCTFail("Granted permission must not prompt"); return false }
        defer { host.shutdown(reason: "Gap epoch test") }
        try host.acceptStart(fixture.server.command, claim: await fixture.claim(), credential: fixture.pending.credential, origin: 9_000_000_000)
        try await waitUntil { host.phase == .recording }
        fixture.monotonic += 1_000_000_000
        fixture.server.advanceElapsed(to: 2000)
        fixture.device.receiver?.fail(.sourceReconfigured)
        host.service()
        await fulfillment(of: [blocked.entered], timeout: 5)
        fixture.monotonic += 1_000_000_000
        fixture.server.advanceElapsed(to: 3000)
        fixture.permission = .denied
        host.service()
        XCTAssertEqual(host.phase, .paused)
        XCTAssertEqual(host.diagnostics.filter { $0.contains("capture-paused:") }.count, 1,
            "A recovery source failure must publish one interruption")
        blocked.unblock()
        try await waitUntil { !host.acquisitionPending }
        fixture.permission = .granted
        try await waitUntil { host.canResumeFromUserClick }
        fixture.monotonic += 1_000_000_000
        fixture.server.advanceElapsed(to: 4000)
        host.resumeFromUserClick()
        try await waitUntil { host.phase == .recording && resumed.starts == 1 }
        try await waitUntil { fixture.server.lastObservation?.generation == 4 && fixture.server.lastObservation?.phase == "recording" }
        XCTAssertEqual(fixture.server.rejectedGapCount, 0, "A cancelled acquisition cannot relabel epoch-2 interruption as epoch 1")
        XCTAssertTrue(fixture.server.reportedGaps.contains { $0.epoch == 2 && $0.startMs == 2000 && $0.endMs == 3000 })
        XCTAssertTrue(fixture.server.reportedGaps.contains { $0.epoch == 2 && $0.startMs == 3000 && $0.endMs == 4000 })
        XCTAssertFalse(fixture.server.reportedGaps.contains { $0.epoch == 1 && $0.endMs > 2000 })
    }

}
