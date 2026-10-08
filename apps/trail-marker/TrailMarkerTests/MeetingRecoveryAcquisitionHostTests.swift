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
        lock.lock(); stops += 1; let fail = refusesCleanup; lock.unlock()
        if fail { throw MeetingAudioFailure.cleanupFailed }
    }
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
        XCTAssertFalse(host.shutdown(reason: "Must retain the unfinished cleanup barrier"))
        blocked.failCleanup = false
        host.stopFromUserClick()
        try await waitUntil { !host.acquisitionPending && !host.cleanupBlocked }
        XCTAssertEqual(host.phase, .stopped)
        XCTAssertGreaterThan(blocked.stopCount, 1)
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
