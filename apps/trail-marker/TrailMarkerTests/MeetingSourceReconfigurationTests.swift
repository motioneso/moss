import AudioToolbox
import CoreAudio
import XCTest
@testable import TrailMarker

final class MeetingSourceReconfigurationTests: XCTestCase {
    private func ring(source: MeetingAudioSource = .microphone, lease: MeetingAudioLease? = nil) throws -> MeetingAudioBuffer {
        try MeetingAudioBuffer(source: source, epoch: 1, originNanoseconds: 0,
            sampleCapacity: 32, blockCapacity: 4, lease: lease)
    }

    private func put(_ ring: MeetingAudioBuffer, sample: Double = 0, host: UInt64 = 0, rate: Double = 8000) {
        ring.receive(sampleTime: sample, hostTimeNanoseconds: host, sampleRate: rate,
            frameCount: 8, sampleAt: { _ in 0.5 })
    }

    func testOnlyValidForwardHostClockEvidenceQualifiesForReconfiguration() throws {
        for source in MeetingAudioSource.allCases {
            let buffer = try ring(source: source)
            put(buffer)
            let original = try XCTUnwrap(buffer.peek())
            buffer.receive(sampleTime: 0, hostTimeNanoseconds: 1_000_000, sampleRate: 8000,
                frameCount: 8, sampleAt: { _ in XCTFail("Reset PCM must remain quarantined"); return 0 })
            XCTAssertEqual(buffer.failure, .sourceReconfigured)
            XCTAssertEqual(buffer.peek(), original)
            XCTAssertEqual(buffer.recoveryBoundaryNanoseconds, 1_000_000)
            XCTAssertFalse(buffer.withSendAdmission {})
        }
        for (sample, host, rate) in [(Double.nan, UInt64(1_000_000), Double(16000)),
                                    (0, UInt64.max, 16000), (0, 999_999, 16000),
                                    (9_007_199_254_732_800, 1_000_000, 8000)] {
            let buffer = try ring()
            put(buffer)
            put(buffer, sample: sample, host: host, rate: rate)
            XCTAssertEqual(buffer.failure, .invalidTimestamp)
        }
    }

    func testRateChangeDoesNotRemapOldCounterOrInventLeaseExpiry() throws {
        let lease = MeetingAudioLease(deadline: 90_000_000_000)
        let buffer = try ring(lease: lease)
        put(buffer, rate: 48000)
        XCTAssertTrue(buffer.acknowledge(sequence: 0))
        // A continuous sample run is established by one long-lived old sample origin.
        // Use dropped callback ranges to advance it without retaining a minute of PCM.
        for index in 0..<360 {
            let sample = Double(8 + index * 8000)
            buffer.drop(sampleTime: sample, hostTimeNanoseconds: UInt64(index) * 1_000_000_000 / 6 + 166_667,
                sampleRate: 48000, frameCount: 8000)
            _ = buffer.drainCaptureGaps()
        }
        XCTAssertNil(buffer.failure)
        put(buffer, sample: 2_880_008, host: 60_000_166_667, rate: 16000)
        XCTAssertEqual(buffer.failure, .sourceReconfigured,
            "A slower rate must not map the previous counter to an artificial 180-second lease boundary")
    }

    func testEveryHardFailureOverridesSoftEvidenceIncludingAfterCloseAndUnderContention() throws {
        let failures: [MeetingAudioFailure] = [.invalidSelection, .invalidFormat, .invalidTimestamp, .bufferFull,
            .leaseExpired, .deviceFailure(operation: "read", status: -50), .invalidTransition, .cleanupFailed]
        for failure in failures {
            let buffer = try ring()
            buffer.fail(.sourceReconfigured)
            buffer.close()
            buffer.fail(failure)
            buffer.fail(.sourceReconfigured)
            XCTAssertEqual(buffer.failure, failure)
        }
        let contended = try ring()
        contended.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 8) { _ in
            contended.fail(.sourceReconfigured)
            contended.fail(.invalidSelection)
            return 1
        }
        XCTAssertEqual(contended.failure, .invalidSelection)
        XCTAssertNil(contended.peek())
    }

    func testQueuedOutputHardEvidenceSurvivesClosedCaptureUntilDisposed() throws {
        let failures: [MeetingAudioFailure] = [.invalidSelection, .invalidTimestamp, .bufferFull,
            .deviceFailure(operation: "read", status: -50)]
        for failure in failures {
            let buffer = try ring(source: .output), gate = MeetingOutputReceiverGate(buffer)
            try gate.open()
            gate.fail(.sourceReconfigured)
            gate.close(preservingFailures: true)
            gate.fail(failure)
            XCTAssertEqual(buffer.failure, failure, "Output teardown must retain all hard failures")
            gate.finishFaultMonitoring()
            gate.fail(.invalidSelection)
            XCTAssertEqual(buffer.failure, failure)
        }
        let buffer = try ring(source: .output), gate = MeetingOutputReceiverGate(buffer)
        try gate.open()
        gate.fail(.sourceReconfigured)
        gate.close(preservingFailures: true)
        let expected = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked, mBytesPerPacket: 4, mFramesPerPacket: 1,
            mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        gate.verifyFormat(expected: expected) { throw MeetingAudioFailure.invalidFormat }
        XCTAssertEqual(buffer.failure, .invalidFormat, "A queued unreadable tap format must prevent recovery")
        gate.finishFaultMonitoring()
        gate.verifyFormat(expected: expected) { XCTFail("Disposed hardware must not be queried"); return expected }
    }

    func testPhysicalRoutesArePartOfSelectionAndRecoveryRequiresBothPins() throws {
        let unpinned = MeetingNativeSelection(microphoneDeviceID: 3, output: .excludingProcesses([7]))
        var pinned = unpinned
        pinned.defaultOutputDeviceID = 11
        XCTAssertFalse(pinned.hasPinnedOutputRoutes)
        pinned.defaultSystemOutputDeviceID = 12
        XCTAssertTrue(pinned.hasPinnedOutputRoutes)
        XCTAssertNotEqual(pinned, unpinned)
        var changed = pinned
        changed.defaultOutputDeviceID = 13
        XCTAssertNotEqual(changed, pinned)
        changed = pinned
        changed.defaultSystemOutputDeviceID = 13
        XCTAssertNotEqual(changed, pinned)
        changed.defaultSystemOutputDeviceID = 0
        XCTAssertThrowsError(try changed.validate())
        XCTAssertTrue(MeetingNativeSelection(microphoneDeviceID: 3, output: nil).hasPinnedOutputRoutes)
    }

    func testInventoryPinsBothPhysicalRoutesAndKnownDeniedOutputFailsClosed() throws {
        let excluded = MeetingProcessIdentity(pid: 100, parentPID: 1, startedSeconds: 1,
            startedMicroseconds: 0, executable: "/Applications/Moss.app/Contents/MacOS/Moss")
        let choice = MeetingCaptureChoice(mode: "computer-audio", microphone: nil, outputSourceId: "computer",
            appProcessTreeId: nil, scope: .init(kind: "process-exclusion", endpointId: nil,
                excludedProcessTreeIds: [excluded.key]))
        func snapshot(_ permission: MeetingCapturePermission) -> MeetingInventorySnapshot {
            MeetingInventorySnapshot(wire: .init(microphones: [], applications: [],
                computerAudio: .init(available: true, excludedProcessTreeIds: [excluded.key]),
                microphonePermission: .unknown, systemAudioPermission: permission),
                microphones: [:], applications: [:], processes: [excluded], audioObjects: [100: 7],
                excluded: [excluded], defaultOutputDeviceID: 11, defaultSystemOutputDeviceID: 12)
        }
        let original = snapshot(.unknown)
        let resolved = try original.resolve(choice)
        XCTAssertEqual(resolved.selection.defaultOutputDeviceID, 11)
        XCTAssertEqual(resolved.selection.defaultSystemOutputDeviceID, 12)
        XCTAssertTrue(resolved.selection.hasPinnedOutputRoutes)
        var changed = original
        changed.defaultOutputDeviceID = 13
        XCTAssertNotEqual(try changed.resolve(choice), resolved)
        XCTAssertFalse(changed.onlyOmitsStartupSources(from: original, choice: choice))
        XCTAssertThrowsError(try snapshot(.denied).resolve(choice))
    }
}
