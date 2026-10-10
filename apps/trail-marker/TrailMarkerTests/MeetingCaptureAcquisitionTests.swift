import XCTest
@testable import TrailMarker

final class MeetingCaptureAcquisitionTests: XCTestCase {
    private let origin: UInt64 = 10_000_000_000
    private let readiness = MeetingNativeReadiness(permissionsGranted: true, processingReady: true, meetingDeviceAuthorized: true)

    private final class Clock {
        private let lock = NSLock()
        private var value: UInt64
        init(_ value: UInt64) { self.value = value }
        var now: UInt64 { lock.lock(); defer { lock.unlock() }; return value }
        func advance(to value: UInt64) { lock.lock(); self.value = value; lock.unlock() }
    }

    private final class Device: MeetingAudioCapturing {
        private let lock = NSLock()
        private var target: MeetingAudioReceiving?
        private var startCount = 0
        private var stopCount = 0
        private var starting = false
        private var concurrentStop = false
        private var cleanupFailure = false
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        var blockStart = false
        var afterStart: ((MeetingAudioReceiving) -> Void)?
        var receiver: MeetingAudioReceiving? { lock.lock(); defer { lock.unlock() }; return target }
        var starts: Int { lock.lock(); defer { lock.unlock() }; return startCount }
        var stops: Int { lock.lock(); defer { lock.unlock() }; return stopCount }
        var stoppedDuringStart: Bool { lock.lock(); defer { lock.unlock() }; return concurrentStop }
        var failCleanup: Bool {
            get { lock.lock(); defer { lock.unlock() }; return cleanupFailure }
            set { lock.lock(); cleanupFailure = newValue; lock.unlock() }
        }
        func start(into receiver: MeetingAudioReceiving) throws {
            lock.lock(); target = receiver; startCount += 1; starting = true; lock.unlock()
            entered.signal()
            if blockStart { release.wait() }
            afterStart?(receiver)
            lock.lock(); starting = false; lock.unlock()
        }
        func stop() throws {
            lock.lock()
            stopCount += 1; concurrentStop = concurrentStop || starting
            let failed = cleanupFailure
            lock.unlock()
            if failed { throw MeetingAudioFailure.cleanupFailed }
        }
    }

    private final class Factory {
        let oldMicrophone = Device(), microphone = Device(), oldOutput = Device(), output = Device()
        private let lock = NSLock()
        private var count = 0
        let factoryEntered = DispatchSemaphore(value: 0)
        let releaseFactory = DispatchSemaphore(value: 0)
        var blockFactory = false
        var afterFactory: (() -> Void)?
        func make(_ selection: MeetingNativeSelection) -> [MeetingAudioSource: MeetingAudioCapturing] {
            lock.lock(); count += 1; let initial = count == 1; lock.unlock()
            if !initial {
                factoryEntered.signal()
                if blockFactory { releaseFactory.wait() }
                afterFactory?()
            }
            var devices: [MeetingAudioSource: MeetingAudioCapturing] = [.microphone: initial ? oldMicrophone : microphone]
            if selection.output != nil { devices[.output] = initial ? oldOutput : output }
            return devices
        }
    }

    private func paused(_ factory: Factory, clock: Clock, paired: Bool = true) throws -> (MeetingCaptureRuntime, MeetingNativeSelection) {
        let selection = MeetingNativeSelection(microphoneDeviceID: 42,
            output: paired ? .excludingProcesses([100]) : nil,
            defaultOutputDeviceID: paired ? 70 : nil, defaultSystemOutputDeviceID: paired ? 71 : nil)
        let runtime = MeetingCaptureRuntime(factory: factory.make, reportCaptureDiagnostic: { _ in }, monotonicNow: { clock.now })
        try runtime.prepare(selection: selection, readiness: readiness, at: origin)
        try runtime.start(readiness: readiness, at: origin)
        factory.oldMicrophone.receiver?.fail(.sourceReconfigured)
        _ = try runtime.service(at: origin + 1)
        clock.advance(to: origin + 1)
        return (runtime, selection)
    }

    private func begin(_ runtime: MeetingCaptureRuntime, selection: MeetingNativeSelection, at: UInt64,
                       onEvent: @escaping (MeetingCaptureAcquisitionEvent) -> Void) throws -> MeetingCaptureAcquisitionTicket {
        try runtime.beginRecoveryAcquisition(selection: selection, readiness: readiness, permitRetainedAudio: true,
            deadline: origin + 12_000_000_000, at: at, onEvent: onEvent)
    }

    func testReceiverQuarantineDiscardsUnknownSamplesAndClockWithoutLosingHardFaults() throws {
        let clock = Clock(origin), lease = MeetingAudioLease()
        let buffer = try MeetingAudioBuffer(source: .microphone, epoch: 2, originNanoseconds: origin,
            sampleCapacity: 80, lease: lease, monotonicNow: { clock.now })
        let receiver = MeetingCaptureAcquisitionReceiver(buffer: buffer, lease: lease, monotonicNow: { clock.now })
        receiver.receive(sampleTime: 0, hostTimeNanoseconds: origin, sampleRate: 8000, frameCount: 8,
            sampleAt: { _ in XCTAssertTrue(false, "Quarantine must never read native PCM"); return 1 })
        receiver.receive(sampleTime: .nan, hostTimeNanoseconds: 0, sampleRate: .nan, frameCount: -1,
            sampleAt: { _ in XCTAssertTrue(false, "Quarantine must never read native PCM"); return 1 })
        receiver.drop(sampleTime: .nan, hostTimeNanoseconds: 0, sampleRate: .nan, frameCount: -1)
        XCTAssertNil(buffer.failure, "Quarantine must not retain unconfirmed sample clocks or drops")
        XCTAssertEqual(buffer.diagnostics.acceptedCallbacks, 0)
        XCTAssertEqual(buffer.diagnostics.droppedCallbacks, 0)
        receiver.fail(.sourceReconfigured)
        receiver.fail(.invalidSelection)
        XCTAssertEqual(buffer.failure, .invalidSelection, "Quarantine must retain hard fault priority")
        receiver.close()
    }

    func testBlockedStartupLeavesSnapshotServicePauseAndStopResponsive() throws {
        let clock = Clock(origin), factory = Factory()
        factory.microphone.blockStart = true
        let (runtime, selection) = try paused(factory, clock: clock)
        let cleaned = expectation(description: "Cancelled acquisition disposed")
        let ticket = try begin(runtime, selection: selection, at: origin + 1) { event in
            if case .ready = event { XCTFail("A cancelled native start cannot become ready") }
            if case .cleanupComplete = event { cleaned.fulfill() }
        }
        XCTAssertEqual(factory.microphone.entered.wait(timeout: .now() + 2), .success)
        defer { factory.microphone.release.signal() }
        let responded = expectation(description: "Control plane remains responsive")
        DispatchQueue.global().async {
            XCTAssertEqual(runtime.snapshot.state, .paused)
            XCTAssertTrue(runtime.canRecoverSources)
            do { _ = try runtime.service(at: self.origin + 2) }
            catch { XCTFail("Service must remain available during acquisition: \(error)") }
            do { try runtime.pause(at: self.origin + 3) }
            catch { XCTFail("Pause must remain available during acquisition: \(error)") }
            do { try runtime.stop(at: self.origin + 4, finalizationNanoseconds: 0) }
            catch { XCTFail("Stop must remain available during acquisition: \(error)") }
            do { _ = try runtime.service(at: self.origin + 5) }
            catch { XCTFail("Finalization must keep waiting without calling a pending acquisition a cleanup failure: \(error)") }
            XCTAssertEqual(runtime.snapshot.state, .stopping)
            runtime.cancelRecoveryAcquisition(ticket)
            XCTAssertTrue(runtime.hasPendingAcquisition)
            responded.fulfill()
        }
        wait(for: [responded], timeout: 1)
        XCTAssertEqual(factory.microphone.stops, 0, "Cleanup must never call stop concurrently with start")
        factory.microphone.release.signal()
        wait(for: [cleaned], timeout: 2)
        XCTAssertFalse(runtime.hasPendingAcquisition)
        XCTAssertEqual(factory.output.starts, 0, "Cancellation must prevent acquisition of the second source")
        XCTAssertEqual(factory.microphone.stops, 1)
        XCTAssertEqual(factory.output.stops, 1)
        XCTAssertFalse(factory.microphone.stoppedDuringStart)
        XCTAssertThrowsError(try runtime.commitRecoveryAcquisition(ticket, at: origin + 6))
        XCTAssertNoThrow(try runtime.service(at: origin + 6))
        XCTAssertEqual(runtime.snapshot.state, .finished)
    }

    func testBlockedFactoryTerminationReturnsAndLateHandlesAreDisposed() throws {
        let clock = Clock(origin), factory = Factory()
        factory.blockFactory = true
        let (runtime, selection) = try paused(factory, clock: clock)
        let cleaned = expectation(description: "Late factory handles disposed")
        _ = try begin(runtime, selection: selection, at: origin + 1) { event in
            if case .ready = event { XCTFail("A terminated factory cannot become ready") }
            if case .cleanupComplete = event { cleaned.fulfill() }
        }
        XCTAssertEqual(factory.factoryEntered.wait(timeout: .now() + 2), .success)
        defer { factory.releaseFactory.signal() }
        let responded = expectation(description: "Termination does not await factory")
        DispatchQueue.global().async {
            do { try runtime.terminate(at: self.origin + 2) }
            catch { XCTFail("Termination must not await the factory: \(error)") }
            XCTAssertEqual(runtime.snapshot.state, .finished)
            XCTAssertTrue(runtime.hasPendingAcquisition)
            do {
                try runtime.reset(at: self.origin + 3)
                XCTFail("Reset must reject pending acquisition ownership")
            } catch {}
            responded.fulfill()
        }
        wait(for: [responded], timeout: 1)
        factory.releaseFactory.signal()
        wait(for: [cleaned], timeout: 2)
        XCTAssertEqual(factory.microphone.starts, 0)
        XCTAssertEqual(factory.output.starts, 0)
        XCTAssertEqual(factory.microphone.stops, 1)
        XCTAssertEqual(factory.output.stops, 1)
        XCTAssertNoThrow(try runtime.reset(at: origin + 3))
    }

    func testQuarantineIgnoresPCMAndDropClocksUntilCommitCutoff() throws {
        let clock = Clock(origin), factory = Factory()
        let (runtime, selection) = try paused(factory, clock: clock)
        let ready = expectation(description: "Devices opened in quarantine")
        let ticket = try begin(runtime, selection: selection, at: origin + 1) { event in
            if case .ready = event { ready.fulfill() }
        }
        wait(for: [ready], timeout: 2)
        let receiver = try XCTUnwrap(factory.microphone.receiver)
        receiver.receive(sampleTime: .nan, hostTimeNanoseconds: 0, sampleRate: .nan, frameCount: -1,
            sampleAt: { _ in XCTFail("Quarantine must never read native PCM"); return 1 })
        receiver.drop(sampleTime: .nan, hostTimeNanoseconds: 0, sampleRate: .nan, frameCount: -1)
        XCTAssertEqual(runtime.snapshot.epoch, 1)
        XCTAssertFalse(try runtime.dispatchNext(at: origin + 2) { _ in XCTFail("Quarantine must not upload") })
        let commit = origin + 2_000_000_000
        clock.advance(to: commit)
        _ = try runtime.service(at: commit)
        try runtime.commitRecoveryAcquisition(ticket, at: commit)
        XCTAssertEqual(runtime.snapshot.lastTransitionNanoseconds, commit, "Commit must use current service chronology")
        XCTAssertEqual(runtime.snapshot.originNanoseconds, origin)
        receiver.receive(sampleTime: -80, hostTimeNanoseconds: commit - 10_000_000, sampleRate: 8000, frameCount: 80,
            sampleAt: { _ in XCTFail("Delayed precommit PCM must not seed the committed clock"); return 1 })
        receiver.drop(sampleTime: -80, hostTimeNanoseconds: commit - 10_000_000, sampleRate: 8000, frameCount: 80)
        receiver.receive(sampleTime: 1234, hostTimeNanoseconds: commit, sampleRate: 8000, frameCount: 80, sampleAt: { _ in 0.5 })
        XCTAssertEqual(runtime.audioDiagnostics[.microphone]?.acceptedCallbacks, 1,
            "Postcommit callbacks must not inherit quarantined or precommit sample clocks")
        XCTAssertTrue(try runtime.dispatchNext(at: commit + 10_000_000) { packet in
            XCTAssertEqual(packet.epoch, ticket.epoch)
            XCTAssertEqual(packet.startNanoseconds, commit)
            XCTAssertEqual(packet.sequence, 0)
            XCTAssertEqual(packet.samples, [Float](repeating: 0.5, count: 80))
        })
        let gaps = try runtime.service(at: commit + 10_000_000)
        XCTAssertEqual(Set(gaps.filter { $0.reason == .paused && $0.endNanoseconds == commit }.map(\.source)), selection.sources,
            "Both interrupted tracks must cover the complete quarantined acquisition")
        try runtime.terminate(at: commit + 10_000_000)
    }

    func testFailedDisposalBlocksRestartUntilStopRetriesRetainedHandles() throws {
        let clock = Clock(origin), factory = Factory()
        factory.microphone.blockStart = true
        factory.microphone.failCleanup = true
        let (runtime, selection) = try paused(factory, clock: clock)
        let failed = expectation(description: "Cleanup failure retained")
        let cleaned = expectation(description: "Stop cleanup retry completed")
        let ticket = try begin(runtime, selection: selection, at: origin + 1) { event in
            if case .cleanupFailed = event { failed.fulfill() }
            if case .cleanupComplete = event { cleaned.fulfill() }
        }
        XCTAssertEqual(factory.microphone.entered.wait(timeout: .now() + 2), .success)
        runtime.cancelRecoveryAcquisition(ticket)
        factory.microphone.release.signal()
        wait(for: [failed], timeout: 2)
        XCTAssertTrue(runtime.hasPendingAcquisition)
        XCTAssertTrue(runtime.acquisitionCleanupFailed)
        XCTAssertThrowsError(try runtime.resume(selection: selection, readiness: readiness, permitRetainedAudio: true, at: origin + 2))
        XCTAssertThrowsError(try begin(runtime, selection: selection, at: origin + 2) { _ in })
        factory.microphone.failCleanup = false
        try runtime.stop(at: origin + 3)
        wait(for: [cleaned], timeout: 2)
        XCTAssertFalse(runtime.hasPendingAcquisition)
        XCTAssertFalse(runtime.acquisitionCleanupFailed)
        XCTAssertEqual(factory.microphone.stops, 2, "Stop must retry the same failed handle")
        XCTAssertEqual(factory.output.stops, 1, "Already disposed handles must not be stopped twice")
    }

    func testOldFaultFreshFaultRevocationAndDeadlineRejectBlockedAcquisition() throws {
        for cause in 0..<4 {
            let clock = Clock(origin), factory = Factory()
            factory.microphone.blockStart = true
            let (runtime, selection) = try paused(factory, clock: clock)
            let cleaned = expectation(description: "Rejected acquisition disposed \(cause)")
            let failed = expectation(description: "Rejected acquisition reported \(cause)")
            let ticket = try begin(runtime, selection: selection, at: origin + 1) { event in
                if case .ready = event { XCTFail("Invalidated acquisition cannot become ready") }
                if case .failed = event { failed.fulfill() }
                if case .cleanupComplete = event { cleaned.fulfill() }
            }
            XCTAssertEqual(factory.microphone.entered.wait(timeout: .now() + 2), .success)
            switch cause {
            case 0: factory.oldOutput.receiver?.fail(.invalidSelection)
            case 1: factory.microphone.receiver?.fail(.sourceReconfigured); factory.microphone.receiver?.fail(.invalidSelection)
            case 2: runtime.updateCaptureLease(until: origin + 2)
            default: clock.advance(to: origin + 12_000_000_000)
            }
            _ = try runtime.service(at: cause == 3 ? clock.now : origin + 2)
            factory.microphone.release.signal()
            wait(for: [failed, cleaned], timeout: 2)
            XCTAssertThrowsError(try runtime.commitRecoveryAcquisition(ticket, at: max(clock.now, origin + 3)))
            XCTAssertEqual(runtime.snapshot.epoch, 1)
            XCTAssertEqual(runtime.snapshot.state, .paused)
            XCTAssertEqual(factory.output.starts, 0)
            XCTAssertFalse(runtime.hasPendingAcquisition)
        }
    }

    func testCancelledTicketCannotCommitOrCancelANewerAcquisition() throws {
        let clock = Clock(origin), factory = Factory()
        let (runtime, selection) = try paused(factory, clock: clock, paired: false)
        let firstReady = expectation(description: "First acquisition ready")
        let firstCleaned = expectation(description: "First acquisition disposed")
        let old = try begin(runtime, selection: selection, at: origin + 1) { event in
            if case .ready = event { firstReady.fulfill() }
            if case .cleanupComplete = event { firstCleaned.fulfill() }
        }
        wait(for: [firstReady], timeout: 2)
        runtime.cancelRecoveryAcquisition(old)
        wait(for: [firstCleaned], timeout: 2)
        let nextReady = expectation(description: "Next acquisition ready")
        let current = try begin(runtime, selection: selection, at: origin + 2) { event in
            if case .ready = event { nextReady.fulfill() }
        }
        wait(for: [nextReady], timeout: 2)
        XCTAssertNotEqual(old, current)
        XCTAssertThrowsError(try runtime.commitRecoveryAcquisition(old, at: origin + 3),
            "A stale ticket must never adopt a newer acquisition")
        runtime.cancelRecoveryAcquisition(old)
        XCTAssertTrue(runtime.hasPendingAcquisition)
        XCTAssertNoThrow(try runtime.commitRecoveryAcquisition(current, at: origin + 3))
        XCTAssertEqual(runtime.snapshot.state, .recording)
        try runtime.terminate(at: origin + 4)
    }

    func testOldScopeFaultDuringStartStopsPairAndRetiresTailWithoutServiceTick() throws {
        let clock = Clock(origin), factory = Factory()
        let selection = MeetingNativeSelection(microphoneDeviceID: 42, output: .excludingProcesses([100]),
            defaultOutputDeviceID: 70, defaultSystemOutputDeviceID: 71)
        let runtime = MeetingCaptureRuntime(factory: factory.make, reportCaptureDiagnostic: { _ in }, monotonicNow: { clock.now })
        try runtime.prepare(selection: selection, readiness: readiness, at: origin)
        try runtime.start(readiness: readiness, at: origin)
        let oldMicrophone = try XCTUnwrap(factory.oldMicrophone.receiver as? MeetingAudioBuffer)
        let oldOutput = try XCTUnwrap(factory.oldOutput.receiver as? MeetingAudioBuffer)
        for buffer in [oldMicrophone, oldOutput] {
            buffer.receive(hostTimeNanoseconds: origin, sampleRate: 8000, frameCount: 80, sampleAt: { _ in 0.25 })
        }
        oldMicrophone.fail(.sourceReconfigured)
        let pausedAt = origin + 100_000_000
        _ = try runtime.service(at: pausedAt)
        clock.advance(to: pausedAt)
        factory.microphone.afterStart = { _ in oldOutput.fail(.invalidSelection) }
        let cleaned = expectation(description: "Old-scope failure disposed")
        var becameReady = false
        _ = try begin(runtime, selection: selection, at: pausedAt) { event in
            if case .ready(let ticket) = event {
                becameReady = true
                // A missing between-source guard must fail the semantic assertions below,
                // not strand a mutation run at an unfulfilled cleanup expectation.
                do {
                    try runtime.commitRecoveryAcquisition(ticket, at: pausedAt)
                    XCTFail("Commit must reject old hard evidence")
                } catch {}
            }
            if case .cleanupComplete = event { cleaned.fulfill() }
        }
        wait(for: [cleaned], timeout: 2)
        XCTAssertFalse(becameReady, "Old hard evidence cannot become ready")
        XCTAssertEqual(factory.output.starts, 0, "Old hard evidence must prevent starting the paired source")
        XCTAssertEqual(oldMicrophone.diagnostics.bufferedSamples, 0,
            "Old scope failure must retire its counterpart tail even after acquisition disposal")
        XCTAssertEqual(oldOutput.diagnostics.bufferedSamples, 0)
        try runtime.stop(at: pausedAt + 1)
        XCTAssertFalse(try runtime.dispatchNext(at: pausedAt + 2) { _ in XCTFail("Uncertain old tails must not upload") })
    }

    func testCommitChecksTrustedDeadlineAfterDelayedMainQueueDelivery() throws {
        let clock = Clock(origin), factory = Factory()
        let (runtime, selection) = try paused(factory, clock: clock, paired: false)
        let ready = expectation(description: "Acquisition ready")
        let cleaned = expectation(description: "Late admission disposed")
        let ticket = try begin(runtime, selection: selection, at: origin + 1) { event in
            if case .ready = event { ready.fulfill() }
            if case .cleanupComplete = event { cleaned.fulfill() }
        }
        wait(for: [ready], timeout: 2)
        clock.advance(to: origin + 12_000_000_000)
        XCTAssertThrowsError(try runtime.commitRecoveryAcquisition(ticket, at: origin + 2),
            "Trusted deadline must reject admission even when the caller supplies an earlier clock")
        // A surviving admission mutation has no staged cleanup event. Satisfy its
        // bookkeeping, but still wait so XCTest records only the semantic failures.
        if runtime.snapshot.state == .recording { cleaned.fulfill() }
        wait(for: [cleaned], timeout: 2)
        XCTAssertEqual(runtime.snapshot.state, .paused)
        XCTAssertEqual(runtime.snapshot.epoch, 1)
        XCTAssertNoThrow(try runtime.terminate(at: clock.now))
    }

    func testCommitRevalidatesDeadlineAndFaultEvenWithoutServiceTick() throws {
        for invalidateLease in [false, true] {
            let clock = Clock(origin), factory = Factory()
            let (runtime, selection) = try paused(factory, clock: clock, paired: false)
            let ready = expectation(description: "Acquisition ready")
            let cleaned = expectation(description: "Commit rejection disposed")
            let ticket = try begin(runtime, selection: selection, at: origin + 1) { event in
                if case .ready = event { ready.fulfill() }
                if case .cleanupComplete = event { cleaned.fulfill() }
            }
            wait(for: [ready], timeout: 2)
            if invalidateLease { runtime.updateCaptureLease(until: origin + 2) }
            else { factory.microphone.receiver?.fail(.invalidSelection) }
            XCTAssertThrowsError(try runtime.commitRecoveryAcquisition(ticket, at: origin + 2))
            wait(for: [cleaned], timeout: 2)
            XCTAssertEqual(runtime.snapshot.state, .paused)
            XCTAssertEqual(runtime.snapshot.epoch, 1)
            XCTAssertFalse(runtime.hasPendingAcquisition)
        }
    }
}
