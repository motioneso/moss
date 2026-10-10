import XCTest
@testable import TrailMarker

final class MeetingAudioBufferTests: XCTestCase {
    private func buffer(samples: Int = 32, blocks: Int = 4) throws -> MeetingAudioBuffer {
        try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: 0,
                               sampleCapacity: samples, blockCapacity: blocks)
    }
    private func put(_ buffer: MeetingAudioBuffer, at: UInt64 = 0, count: Int = 8, value: Float = 0.25) {
        buffer.receive(hostTimeNanoseconds: at, sampleRate: 8000, frameCount: count, sampleAt: { _ in value })
    }
    private final class StartupTestClock {
        var now: UInt64 = 10_000_000_000
    }
    private func recoveringBuffer(_ clock: StartupTestClock, source: MeetingAudioSource = .microphone,
                                  origin: UInt64 = 0, lease: MeetingAudioLease? = nil) throws -> MeetingAudioBuffer {
        try MeetingAudioBuffer(source: source, epoch: 1, originNanoseconds: origin,
            sampleCapacity: 64, blockCapacity: 8, lease: lease,
            permitsStartupClockRecovery: true, monotonicNow: { clock.now })
    }
    private func putHardware(_ buffer: MeetingAudioBuffer, sampleTime: Double, at: UInt64, value: Float = 1) {
        buffer.receive(sampleTime: sampleTime, hostTimeNanoseconds: at, sampleRate: 8000,
                       frameCount: 8, sampleAt: { _ in value })
    }
    func testPacketIdentityAndReceiptAreIndependentFromProcessing() throws {
        let ring = try buffer()
        put(ring)
        let packet = try XCTUnwrap(ring.peek())
        XCTAssertEqual(packet.samples, Array(repeating: 0.25, count: 8))
        XCTAssertEqual(packet.endNanoseconds, 1_000_000)
        XCTAssertEqual(ring.peek(), packet)
        XCTAssertFalse(ring.acknowledge(sequence: 1))
        XCTAssertEqual(ring.peek(), packet)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertNil(ring.peek())
        XCTAssertFalse(ring.acknowledge(sequence: 0))
    }
    func testPauseClosesAdmissionWithoutDiscardingPrePauseAudio() throws {
        let ring = try buffer()
        put(ring)
        ring.close()
        put(ring, at: 1_000_000)
        XCTAssertEqual(ring.peek()?.sequence, 0)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertNil(ring.peek())
    }
    func testPartialStopUsesOnlyWholeSamplesAtOrBeforeCutoff() throws {
        let ring = try buffer()
        put(ring)
        XCTAssertNil(ring.peek(cutoffNanoseconds: 0))
        XCTAssertNil(ring.peek(cutoffNanoseconds: 124_999))
        XCTAssertEqual(ring.peek(cutoffNanoseconds: 125_000)?.samples.count, 1)
        XCTAssertEqual(ring.peek(cutoffNanoseconds: 499_999)?.samples.count, 3)
        XCTAssertEqual(ring.peek(cutoffNanoseconds: 500_000)?.samples.count, 4)
        XCTAssertEqual(ring.peek(cutoffNanoseconds: UInt64.max)?.samples.count, 8)
    }
    func testRingWrapDoesNotCorruptUnacknowledgedAudio() throws {
        let ring = try buffer(samples: 12)
        put(ring)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        put(ring, at: 1_000_000, value: 0.5)
        XCTAssertEqual(ring.peek()?.samples, Array(repeating: 0.5, count: 8))
        XCTAssertEqual(ring.peek()?.sequence, 1)
    }
    func testByteAndBlockCapsFailExplicitlyWithoutDroppingAcceptedAudio() throws {
        for ring in [try buffer(samples: 8), try buffer(blocks: 1)] {
            put(ring)
            put(ring, at: 1_000_000)
            XCTAssertEqual(ring.failure, .bufferFull)
            XCTAssertEqual(ring.peek()?.sequence, 0)
            XCTAssertTrue(ring.acknowledge(sequence: 0))
            XCTAssertNil(ring.peek())
        }
    }
    func testDurationCapAndExpiryHaveExactBoundaries() throws {
        let ring = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: 0)
        put(ring)
        XCTAssertFalse(ring.isBacklogged(nowNanoseconds: 29_999_999_999))
        XCTAssertTrue(ring.isBacklogged(nowNanoseconds: 30_000_000_000))
        XCTAssertTrue(ring.expire(nowNanoseconds: 59_999_999_999).isEmpty)
        let gaps = ring.expire(nowNanoseconds: 60_000_000_000)
        XCTAssertEqual(gaps.count, 1)
        XCTAssertEqual(gaps.first?.reason, .expired)
        XCTAssertNil(ring.peek())
        put(ring, at: 60_000_000_001)
        XCTAssertNil(ring.peek())
        XCTAssertEqual(ring.failure, .sourceReconfigured)
    }
    func testUnacknowledgedDurationDoesNotGrowPastSixtySeconds() throws {
        let ring = try buffer(samples: 488_000, blocks: 64)
        for second in 0..<60 { put(ring, at: UInt64(second) * 1_000_000_000, count: 8000) }
        XCTAssertNil(ring.failure)
        put(ring, at: 60_000_000_000, count: 8000)
        XCTAssertEqual(ring.failure, .bufferFull)
    }
    func testInvalidNumericAndTimestampInputFailsClosed() throws {
        for rate in [Double.nan, .infinity, -1, 0, 7999, 8000.5, 192001] {
            let ring = try buffer()
            ring.receive(hostTimeNanoseconds: 0, sampleRate: rate, frameCount: 1, sampleAt: { _ in 0 })
            XCTAssertEqual(ring.failure, .invalidFormat)
        }
        for count in [-1, 0, MeetingAudioBuffer.maximumCallbackFrames + 1] {
            let ring = try buffer()
            put(ring, count: count)
            XCTAssertEqual(ring.failure, .invalidFormat)
        }
        let overflow = try buffer()
        put(overflow, at: UInt64.max)
        XCTAssertEqual(overflow.failure, .invalidTimestamp)
        let reverse = try buffer()
        put(reverse, at: 1)
        put(reverse, at: 0)
        XCTAssertEqual(reverse.failure, .invalidTimestamp)
    }
    func testRateChangeAndNonFiniteSamplesAreNotReinterpreted() throws {
        let ring = try buffer()
        put(ring)
        ring.receive(hostTimeNanoseconds: 2_000_000, sampleRate: 16000, frameCount: 1, sampleAt: { _ in 0 })
        XCTAssertEqual(ring.failure, .sourceReconfigured)
        let bad = try buffer()
        put(bad, value: .nan)
        XCTAssertEqual(bad.failure, .invalidFormat)
        XCTAssertNil(bad.peek())
    }
    func testDiscardClosesAndReleasesQueuedSamples() throws {
        let ring = try buffer()
        put(ring)
        ring.discard()
        XCTAssertNil(ring.peek())
        put(ring, at: 1_000_000)
        XCTAssertNil(ring.peek())
    }
    func testInvalidCapacitiesAreRejectedBeforeAllocation() {
        XCTAssertThrowsError(try buffer(samples: 0))
        XCTAssertThrowsError(try buffer(samples: 11_520_001))
        XCTAssertThrowsError(try buffer(blocks: 0))
        XCTAssertThrowsError(try buffer(blocks: 16385))
    }
    func testClockOverlapAndDiscontinuityRequireNewEpoch() throws {
        for next in [UInt64(500_000), 2_000_000] {
            let ring = try buffer()
            put(ring)
            put(ring, at: next)
            XCTAssertEqual(ring.failure, next < 1_000_000 ? .invalidTimestamp : .sourceReconfigured)
        }
        let tolerant = try buffer()
        put(tolerant)
        put(tolerant, at: 1_000_001)
        XCTAssertNil(tolerant.failure)
    }

    func testChunkWaitsForTargetAndAcknowledgesOnlyItsCoveredBlocks() throws {
        let ring = try buffer(samples: 48_000, blocks: 8)
        for second in 0..<4 { put(ring, at: UInt64(second) * 1_000_000_000, count: 8000, value: Float(second)) }
        XCTAssertNil(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
                                    cutoffNanoseconds: nil, allowPartial: false))
        put(ring, at: 4_000_000_000, count: 8000, value: 4)
        let chunk = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
                                               cutoffNanoseconds: nil, allowPartial: false))
        XCTAssertEqual(chunk.packet.samples.count, 40_000)
        XCTAssertEqual(chunk.packet.endNanoseconds, 5_000_000_000)
        XCTAssertEqual(chunk.throughSequence, 4)
        XCTAssertEqual(chunk.packet.samples[32_000], 4)
        put(ring, at: 5_000_000_000, count: 8000, value: 5)
        XCTAssertTrue(ring.acknowledge(sequence: chunk.packet.sequence, throughSequence: chunk.throughSequence))
        XCTAssertEqual(ring.peek()?.sequence, 5)
        XCTAssertEqual(ring.peek()?.samples.first, 5)
    }

    func testCoalescedFinalPartialChunkNeverCrossesCutoff() throws {
        let ring = try buffer(samples: 24_000, blocks: 4)
        for second in 0..<3 { put(ring, at: UInt64(second) * 1_000_000_000, count: 8000) }
        let chunk = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
            cutoffNanoseconds: 1_500_000_001, allowPartial: true))
        XCTAssertEqual(chunk.packet.samples.count, 12_000)
        XCTAssertEqual(chunk.packet.endNanoseconds, 1_500_000_000)
        XCTAssertEqual(chunk.throughSequence, 1)
        XCTAssertTrue(ring.acknowledge(sequence: 0, throughSequence: 1))
        XCTAssertNil(ring.peek(cutoffNanoseconds: 1_500_000_001))
        XCTAssertFalse(ring.acknowledge(sequence: 2, throughSequence: UInt64.max))
    }

    func testMaximumRateFiveSecondChunkFitsDefaultRingAndTenSecondWireCap() throws {
        let ring = try MeetingAudioBuffer(source: .output, epoch: 1, originNanoseconds: 0)
        for slice in 0..<125 {
            ring.receive(hostTimeNanoseconds: UInt64(slice) * 40_000_000, sampleRate: 192_000,
                         frameCount: 7680, sampleAt: { _ in 0.5 })
        }
        XCTAssertNil(ring.failure)
        let chunk = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
                                               cutoffNanoseconds: nil, allowPartial: false))
        XCTAssertEqual(chunk.packet.samples.count, 960_000)
        XCTAssertEqual(chunk.packet.endNanoseconds, 5_000_000_000)
    }

    func testCallbackContentionReturnsBeforeControlIsReleasedAndReportsGap() throws {
        let ring = try buffer()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let firstDone = expectation(description: "Initial sample copied")
        let contendedDone = expectation(description: "Contended callback returns without waiting")
        DispatchQueue.global().async {
            ring.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1) { _ in
                entered.signal()
                _ = release.wait(timeout: .now() + 5)
                return 0.5
            }
            firstDone.fulfill()
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        DispatchQueue.global().async {
            ring.receive(hostTimeNanoseconds: 125_000, sampleRate: 8000, frameCount: 1, sampleAt: { _ in 1 })
            contendedDone.fulfill()
        }
        wait(for: [contendedDone], timeout: 1)
        release.signal()
        wait(for: [firstDone], timeout: 2)
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.peek()?.samples, [0.5])
        put(ring, at: 250_000, count: 1)
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.drainCaptureGaps(), [MeetingAudioGap(source: .microphone, epoch: 1,
            startNanoseconds: 125_000, endNanoseconds: 250_000, reason: .callbackContention)])
        let beforeGap = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 1_000_000,
            cutoffNanoseconds: nil, allowPartial: false))
        XCTAssertEqual(beforeGap.packet.samples, [0.5])
        XCTAssertEqual(beforeGap.throughSequence, 0)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertEqual(ring.peek()?.startNanoseconds, 250_000)
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
    }

    func testDiscardReportsRetentionGapAndRejectsInvalidChunkDurations() throws {
        let ring = try buffer()
        put(ring)
        for duration in [UInt64(0), 5_000_000_001, UInt64.max] {
            XCTAssertNil(ring.peekChunk(targetDurationNanoseconds: duration,
                                        cutoffNanoseconds: nil, allowPartial: true))
        }
        XCTAssertEqual(ring.discard(reason: .retentionDeclined), MeetingAudioGap(source: .microphone,
            epoch: 1, startNanoseconds: 0, endNanoseconds: 1_000_000, reason: .retentionDeclined))
        XCTAssertNil(ring.discard(reason: .retentionDeclined))
    }

    func testScopeFaultSurvivesCallbackContentionAndEarlierFaults() throws {
        let ring = try buffer()
        ring.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1) { _ in
            // Same-thread injection holds the sample-copy lock. Fault reporting must use its
            // atomic path rather than waiting or degrading this privacy fault to bufferFull.
            ring.fail(.invalidSelection)
            return 0.5
        }
        XCTAssertEqual(ring.failure, .invalidSelection)
        ring.fail(.bufferFull)
        XCTAssertEqual(ring.failure, .invalidSelection)
        let earlier = try buffer()
        earlier.fail(.invalidFormat)
        earlier.fail(.invalidSelection)
        XCTAssertEqual(earlier.failure, .invalidSelection)
    }

    func testHundredsOfExpiredCallbacksCoalesceIntoOneLossRangeWithSampleJitter() throws {
        let ring = try MeetingAudioBuffer(source: .output, epoch: 3, originNanoseconds: 0,
                                         sampleCapacity: 192_000, blockCapacity: 400)
        for index in 0..<400 {
            ring.receive(hostTimeNanoseconds: UInt64(index) * 10_000_000 + UInt64(index % 2),
                         sampleRate: 48_000, frameCount: 480, sampleAt: { _ in 0.5 })
        }
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.expire(nowNanoseconds: 64_000_000_000), [MeetingAudioGap(source: .output,
            epoch: 3, startNanoseconds: 0, endNanoseconds: 4_000_000_000, reason: .expired)])
        XCTAssertNil(ring.peek())
        XCTAssertTrue(ring.expire(nowNanoseconds: 65_000_000_000).isEmpty)
    }

    func testExpiryCoalescingKeepsRealDiscontinuitiesAndDifferentIdentitiesSeparate() throws {
        let previous = MeetingAudioGap(source: .microphone, epoch: 1,
            startNanoseconds: 0, endNanoseconds: 1_000_000, reason: .expired)
        let tolerance: UInt64 = 41_667 // Two 48kHz sample periods, matching admission.
        let jitter = MeetingAudioGap(source: .microphone, epoch: 1,
            startNanoseconds: 1_041_667, endNanoseconds: 2_041_667, reason: .expired)
        XCTAssertEqual(MeetingAudioBuffer.coalescedGap(previous, jitter, toleranceNanoseconds: tolerance),
            MeetingAudioGap(source: .microphone, epoch: 1, startNanoseconds: 0,
                            endNanoseconds: 2_041_667, reason: .expired))
        let separate = [
            MeetingAudioGap(source: .microphone, epoch: 1, startNanoseconds: 1_041_668,
                            endNanoseconds: 2_041_668, reason: .expired),
            MeetingAudioGap(source: .output, epoch: 1, startNanoseconds: 1_000_000,
                            endNanoseconds: 2_000_000, reason: .expired),
            MeetingAudioGap(source: .microphone, epoch: 2, startNanoseconds: 1_000_000,
                            endNanoseconds: 2_000_000, reason: .expired),
            MeetingAudioGap(source: .microphone, epoch: 1, startNanoseconds: 1_000_000,
                            endNanoseconds: 2_000_000, reason: .paused),
        ]
        for next in separate {
            XCTAssertNil(MeetingAudioBuffer.coalescedGap(previous, next, toleranceNanoseconds: tolerance))
        }
    }

    func testHardwareSampleClockIgnoresHostJitterAndDriftForThousandsOfChunks() throws {
        let ring = try buffer(samples: 1024, blocks: 2)
        let origin: UInt64 = 1_000_000_123
        var previousEnd = origin
        for index in 0..<5000 {
            let offset = UInt64(index * 512)
            let nominal = try XCTUnwrap(MeetingAudioSampleClock.nanoseconds(frames: offset, sampleRate: 44_100))
            // Alternating 2 ms timestamp jitter plus a gradual 5 ms drift. Neither loses samples.
            let jitter: Int64 = index == 0 ? 0 : (index % 2 == 0 ? 2_000_000 : -2_000_000) + Int64(index * 1000)
            let observed = UInt64(Int64(origin + nominal) + jitter)
            ring.receive(sampleTime: Double(offset) - 512, hostTimeNanoseconds: observed,
                         sampleRate: 44_100, frameCount: 512, sampleAt: { _ in 0.25 })
            XCTAssertNil(ring.failure)
            let packet = try XCTUnwrap(ring.peek())
            XCTAssertEqual(packet.startNanoseconds, previousEnd)
            XCTAssertEqual(packet.sampleOffset, offset)
            XCTAssertEqual(packet.timelineOriginNanoseconds, origin)
            previousEnd = packet.endNanoseconds
            XCTAssertTrue(ring.acknowledge(sequence: packet.sequence))
        }
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 5000)
        XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 0)
        XCTAssertGreaterThan(ring.diagnostics.maximumHostClockDifferenceNanoseconds, 2_000_000)
        XCTAssertEqual(previousEnd, origin + MeetingAudioSampleClock.nanoseconds(frames: 2_560_000, sampleRate: 44_100)!)
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
    }

    func testUnknownHardwareSampleGapOrRepeatNeverBecomesInventedContinuity() throws {
        for next in [Double(7), 9] {
            let ring = try buffer()
            ring.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 1 })
            ring.receive(sampleTime: next, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 2 })
            XCTAssertEqual(ring.failure, .sourceReconfigured)
            XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 1)
            XCTAssertEqual(ring.peek()?.samples, Array(repeating: Float(1), count: 8))
            XCTAssertTrue(ring.acknowledge(sequence: 0))
            XCTAssertNil(ring.peek())
        }
    }

    func testStartupClockRecoveryPreservesBothSegmentsAndRetryIdentity() throws {
        let clock = StartupTestClock()
        let origin: UInt64 = 1_000_000_000
        let ring = try recoveringBuffer(clock, origin: origin)
        putHardware(ring, sampleTime: -8, at: origin, value: 1)
        putHardware(ring, sampleTime: 0, at: origin + 1_000_000, value: 2)
        let originalHead = try XCTUnwrap(ring.peek())
        clock.now += 2_000_000
        var readUntrustedSamples = false
        ring.receive(sampleTime: 0, hostTimeNanoseconds: origin + 2_000_000,
                     sampleRate: 8000, frameCount: 8) { _ in
            readUntrustedSamples = true
            return 99
        }
        XCTAssertNil(ring.failure, "One early microphone counter reset must not pause capture")
        XCTAssertFalse(readUntrustedSamples, "The discontinuous callback must never be copied")
        XCTAssertEqual(ring.peek(), originalHead, "Recovery must not rewrite or discard accepted PCM")
        putHardware(ring, sampleTime: 8, at: origin + 4_000_000, value: 3)
        putHardware(ring, sampleTime: 16, at: origin + 5_000_000, value: 4)
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 4)
        XCTAssertEqual(ring.diagnostics.bufferedSamples, 32)
        XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 1)

        // A complete clock segment can drain before the five-second target, but cannot
        // borrow samples from the new clock merely to satisfy that target.
        let before = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
            cutoffNanoseconds: nil, allowPartial: false))
        XCTAssertEqual(before.packet.samples, [Float](repeating: 1, count: 8) + [Float](repeating: 2, count: 8))
        XCTAssertEqual(before.packet.sequence, 0)
        XCTAssertEqual(before.throughSequence, 1)
        XCTAssertEqual(before.packet.timelineOriginNanoseconds, origin)
        XCTAssertEqual(before.packet.startNanoseconds, origin)
        XCTAssertEqual(before.packet.endNanoseconds, origin + 2_000_000)
        let retry = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
            cutoffNanoseconds: nil, allowPartial: false))
        XCTAssertEqual(retry.packet, before.packet)
        XCTAssertEqual(retry.throughSequence, before.throughSequence)
        XCTAssertFalse(ring.acknowledge(sequence: 1, throughSequence: 1))
        XCTAssertTrue(ring.acknowledge(sequence: before.packet.sequence, throughSequence: before.throughSequence))

        let after = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 2_000_000,
            cutoffNanoseconds: nil, allowPartial: false))
        XCTAssertEqual(after.packet.samples, [Float](repeating: 3, count: 8) + [Float](repeating: 4, count: 8))
        XCTAssertEqual(after.packet.sequence, 2, "The dropped callback cannot consume or reset packet identity")
        XCTAssertEqual(after.throughSequence, 3)
        XCTAssertEqual(after.packet.sampleOffset, 0)
        XCTAssertEqual(after.packet.timelineOriginNanoseconds, origin + 4_000_000)
        XCTAssertEqual(after.packet.startNanoseconds, origin + 4_000_000)
        XCTAssertEqual(after.packet.endNanoseconds, origin + 6_000_000)
        XCTAssertGreaterThanOrEqual(after.packet.startNanoseconds, before.packet.endNanoseconds)
        XCTAssertFalse(ring.acknowledge(sequence: before.packet.sequence, throughSequence: before.throughSequence))
        XCTAssertEqual(ring.peekChunk(targetDurationNanoseconds: 2_000_000,
            cutoffNanoseconds: nil, allowPartial: false)?.packet, after.packet)
        XCTAssertEqual(ring.drainCaptureGaps(), [MeetingAudioGap(source: .microphone, epoch: 1,
            startNanoseconds: origin + 2_000_000, endNanoseconds: origin + 4_000_000, reason: .startupTimestamp)])
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        XCTAssertTrue(ring.acknowledge(sequence: after.packet.sequence, throughSequence: after.throughSequence))
        XCTAssertNil(ring.peek())
    }

    func testStartupRecoveryDoesNotDiscardValidEarlyAudioOrSilence() throws {
        let clock = StartupTestClock()
        let ring = try recoveringBuffer(clock)
        for index in 0..<8 {
            clock.now += 1_000_000
            putHardware(ring, sampleTime: Double(index * 8) - 128,
                        at: UInt64(index) * 1_000_000, value: Float(index))
        }
        let packet = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 8_000_000,
            cutoffNanoseconds: nil, allowPartial: false)?.packet)
        XCTAssertEqual(packet.samples, (0..<8).flatMap { [Float](repeating: Float($0), count: 8) })
        XCTAssertEqual(packet.startNanoseconds, 0)
        XCTAssertEqual(packet.endNanoseconds, 8_000_000)
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 8)
        XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 0)
        XCTAssertNil(ring.failure)
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        XCTAssertTrue(ring.acknowledge(sequence: 0, throughSequence: 7))
        clock.now += 1_000_000_000
        putHardware(ring, sampleTime: -64, at: 1_000_000_000, value: 8)
        XCTAssertNil(ring.failure, "An established continuous sample clock remains valid after startup")
        XCTAssertEqual(ring.peek()?.startNanoseconds, 8_000_000, "Host drift must not move valid PCM")
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
    }

    func testStartupRecoveryIsOptInAndNeverAppliesToOutput() throws {
        let clock = StartupTestClock()
        for ring in [try buffer(), try recoveringBuffer(clock, source: .output)] {
            putHardware(ring, sampleTime: 0, at: 0)
            var copied = false
            ring.receive(sampleTime: 0, hostTimeNanoseconds: 1_000_000, sampleRate: 8000,
                         frameCount: 8, sampleAt: { _ in copied = true; return 2 })
            XCTAssertEqual(ring.failure, .sourceReconfigured)
            XCTAssertFalse(copied)
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        }
    }

    func testStartupRecoveryRequiresIndependentMonotonicWindow() throws {
        for elapsed in [Int64(500_000_000), 500_000_001, -1] {
            let clock = StartupTestClock()
            let ring = try recoveringBuffer(clock)
            putHardware(ring, sampleTime: 0, at: 0)
            clock.now = UInt64(Int64(clock.now) + elapsed)
            // A plausible, early hardware timestamp must not reopen an expired real-time window.
            putHardware(ring, sampleTime: 0, at: 1_000_000, value: 99)
            if elapsed == 500_000_000 {
                XCTAssertNil(ring.failure, "One bounded startup counter reset must not pause microphone capture")
                putHardware(ring, sampleTime: 8, at: 2_000_000, value: 2)
                XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 2)
            } else {
                XCTAssertEqual(ring.failure, elapsed < 0 ? .invalidTimestamp : .sourceReconfigured)
                XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
                XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
            }
        }
    }

    func testStartupRecoveryAlsoRequiresHostWindowFromEpochOrigin() throws {
        let origin: UInt64 = 1_000_000_000
        for hostOffset in [UInt64(499_000_000), 499_000_001, 500_000_000, 500_000_001] {
            let clock = StartupTestClock()
            let ring = try recoveringBuffer(clock, origin: origin)
            putHardware(ring, sampleTime: 0, at: origin)
            putHardware(ring, sampleTime: 0, at: origin + hostOffset, value: 99)
            if hostOffset == 499_000_000 {
                XCTAssertNil(ring.failure)
                putHardware(ring, sampleTime: 8, at: origin + hostOffset + 1_000_000, value: 2)
                XCTAssertNil(ring.failure, "The discarded interval must end within the startup window")
                XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 2)
            } else {
                XCTAssertEqual(ring.failure, .sourceReconfigured)
                XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
                XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
            }
        }
        let late = try recoveringBuffer(StartupTestClock(), origin: origin)
        putHardware(late, sampleTime: 0, at: origin + 600_000_000)
        putHardware(late, sampleTime: 0, at: origin + 601_000_000)
        XCTAssertEqual(late.failure, .sourceReconfigured, "A late first callback must not extend the epoch's window")

        let longCallback = try recoveringBuffer(StartupTestClock())
        putHardware(longCallback, sampleTime: 0, at: 0)
        longCallback.receive(sampleTime: 0, hostTimeNanoseconds: 1_000_000, sampleRate: 8000,
            frameCount: 4096, sampleAt: { _ in XCTFail("An over-window reset callback must not read PCM"); return 99 })
        XCTAssertEqual(longCallback.failure, .sourceReconfigured)
        XCTAssertTrue(longCallback.drainCaptureGaps().isEmpty)
    }

    func testDelayedFirstCallbackCannotRestartTrustedStartupWindow() throws {
        let clock = StartupTestClock()
        let ring = try recoveringBuffer(clock)
        clock.now += 500_000_001
        // Both hardware timestamps look early, but admission was opened more than 500 ms ago.
        putHardware(ring, sampleTime: 0, at: 0)
        XCTAssertNil(ring.failure, "A delayed first valid callback must still preserve its PCM")
        putHardware(ring, sampleTime: 0, at: 1_000_000, value: 99)
        XCTAssertEqual(ring.failure, .sourceReconfigured)
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
        XCTAssertEqual(ring.peek()?.samples, [Float](repeating: 1, count: 8))
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
    }

    func testStartupRecoveryRejectsLateSuccessorOnEitherClock() throws {
        let cases: [(UInt64, UInt64)] = [(500_000_001, 2_000_000), (0, 500_000_001)]
        for (elapsed, host) in cases {
            let clock = StartupTestClock()
            let ring = try recoveringBuffer(clock)
            putHardware(ring, sampleTime: 0, at: 0)
            putHardware(ring, sampleTime: 0, at: 1_000_000, value: 99)
            XCTAssertNil(ring.failure)
            clock.now += elapsed
            var copied = false
            ring.receive(sampleTime: 8, hostTimeNanoseconds: host, sampleRate: 8000,
                         frameCount: 8, sampleAt: { _ in copied = true; return 2 })
            XCTAssertEqual(ring.failure, .invalidTimestamp)
            XCTAssertFalse(copied)
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
            XCTAssertEqual(ring.drainCaptureGaps(), [MeetingAudioGap(source: .microphone, epoch: 1,
                startNanoseconds: 1_000_000, endNanoseconds: 2_000_000, reason: .startupTimestamp)])
        }
    }

    func testStartupRecoveryCannotBeRepeatedEvenAfterAcknowledgement() throws {
        let ring = try recoveringBuffer(StartupTestClock())
        putHardware(ring, sampleTime: 0, at: 0)
        putHardware(ring, sampleTime: 0, at: 1_000_000, value: 99)
        putHardware(ring, sampleTime: 8, at: 2_000_000, value: 2)
        XCTAssertNil(ring.failure)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        let accepted = try XCTUnwrap(ring.peek())
        XCTAssertEqual(accepted.sequence, 1)
        _ = ring.drainCaptureGaps()
        var copied = false
        ring.receive(sampleTime: 8, hostTimeNanoseconds: 3_000_000, sampleRate: 8000,
                     frameCount: 8, sampleAt: { _ in copied = true; return 99 })
        XCTAssertEqual(ring.failure, .sourceReconfigured)
        XCTAssertFalse(copied)
        XCTAssertEqual(ring.peek(), accepted)
        XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 2)
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        XCTAssertTrue(ring.acknowledge(sequence: 1))
        putHardware(ring, sampleTime: 16, at: 4_000_000)
        XCTAssertNil(ring.peek(), "A subsequent valid callback cannot reopen the failed epoch")
    }

    func testStartupLossSurvivesStopWithoutSuccessorAndHonorsCutoff() throws {
        let clock = StartupTestClock()
        let ring = try recoveringBuffer(clock)
        putHardware(ring, sampleTime: 0, at: 0)
        putHardware(ring, sampleTime: 0, at: 1_000_000, value: 99)
        ring.close()
        clock.now += 500_000_001
        var copiedAfterStop = false
        ring.receive(sampleTime: 8, hostTimeNanoseconds: 2_000_000, sampleRate: 8000,
                     frameCount: 8, sampleAt: { _ in copiedAfterStop = true; return 2 })
        XCTAssertFalse(copiedAfterStop)
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.drainCaptureGaps(cutoffNanoseconds: 1_500_000), [MeetingAudioGap(source: .microphone,
            epoch: 1, startNanoseconds: 1_000_000, endNanoseconds: 1_500_000, reason: .startupTimestamp)])
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        XCTAssertEqual(ring.peek()?.samples, [Float](repeating: 1, count: 8))
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertNil(ring.peek())
    }

    func testStartupRecoveryWithoutSuccessorExpiresWhileOpenAndPreservesScopePriority() throws {
        for scopeBeforeTimeout in [false, true] {
            let clock = StartupTestClock()
            let ring = try recoveringBuffer(clock)
            putHardware(ring, sampleTime: 0, at: 0)
            putHardware(ring, sampleTime: 0, at: 1_000_000, value: 99)
            clock.now += 500_000_000
            XCTAssertNil(ring.failure, "The exact startup deadline remains eligible for a successor")
            if scopeBeforeTimeout { ring.fail(.invalidSelection) }
            clock.now += 1
            XCTAssertEqual(ring.failure, scopeBeforeTimeout ? .invalidSelection : .invalidTimestamp,
                "An open reset cannot wait indefinitely for another callback")
            ring.fail(.invalidSelection)
            XCTAssertEqual(ring.failure, .invalidSelection, "A scope fault must also override an earlier startup timeout")
            var copied = false
            ring.receive(sampleTime: 8, hostTimeNanoseconds: 2_000_000, sampleRate: 8000,
                         frameCount: 8, sampleAt: { _ in copied = true; return 2 })
            XCTAssertFalse(copied)
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
            XCTAssertEqual(ring.drainCaptureGaps(), [MeetingAudioGap(source: .microphone, epoch: 1,
                startNanoseconds: 1_000_000, endNanoseconds: 2_000_000, reason: .startupTimestamp)])
        }
    }

    func testStartupRecoveryRejectsMalformedTimestampsBeforeReadingSamples() throws {
        let origin: UInt64 = 1_000_000_000
        let invalid: [(Double, UInt64)] = [
            (.nan, origin + 1_000_000), (.infinity, origin + 1_000_000),
            (-.infinity, origin + 1_000_000), (0.5, origin + 1_000_000),
            (9_007_199_254_740_992, origin + 1_000_000),
            (0, origin - 1), (0, UInt64.max),
        ]
        for (sampleTime, host) in invalid {
            let ring = try recoveringBuffer(StartupTestClock(), origin: origin)
            putHardware(ring, sampleTime: 0, at: origin)
            var copied = false
            ring.receive(sampleTime: sampleTime, hostTimeNanoseconds: host, sampleRate: 8000,
                         frameCount: 8, sampleAt: { _ in copied = true; return 2 })
            XCTAssertEqual(ring.failure, .invalidTimestamp)
            XCTAssertFalse(copied)
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        }
    }

    func testStartupRecoveryRejectsFormatChangesAndInvalidPCM() throws {
        for rate in [Double.nan, .infinity, 0, 8000.5, 16000] {
            let ring = try recoveringBuffer(StartupTestClock())
            putHardware(ring, sampleTime: 0, at: 0)
            var copied = false
            ring.receive(sampleTime: 0, hostTimeNanoseconds: 1_000_000, sampleRate: rate,
                         frameCount: 8, sampleAt: { _ in copied = true; return 2 })
            XCTAssertEqual(ring.failure, rate == 16000 ? .sourceReconfigured : .invalidFormat)
            XCTAssertFalse(copied)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        }
        for count in [-1, 0, MeetingAudioBuffer.maximumCallbackFrames + 1] {
            let ring = try recoveringBuffer(StartupTestClock())
            putHardware(ring, sampleTime: 0, at: 0)
            ring.receive(sampleTime: 0, hostTimeNanoseconds: 1_000_000, sampleRate: 8000,
                         frameCount: count, sampleAt: { _ in XCTFail("Invalid frame count read PCM"); return 2 })
            XCTAssertEqual(ring.failure, .invalidFormat)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        }
        let badPCM = try recoveringBuffer(StartupTestClock())
        putHardware(badPCM, sampleTime: 0, at: 0)
        putHardware(badPCM, sampleTime: 8, at: 1_000_000, value: .nan)
        XCTAssertEqual(badPCM.failure, .invalidFormat)
        XCTAssertEqual(badPCM.diagnostics.acceptedCallbacks, 1)
        XCTAssertEqual(badPCM.peek()?.samples, [Float](repeating: 1, count: 8))
    }

    func testNominalFortyEightKilohertzRoundingJitterDoesNotPauseStartup() throws {
        let clock = StartupTestClock()
        let ring = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: 0,
            sampleCapacity: 2048, blockCapacity: 4, permitsStartupClockRecovery: true,
            monotonicNow: { clock.now })
        ring.receive(sampleTime: 1024, hostTimeNanoseconds: 0, sampleRate: 48_000,
            frameCount: 512, sampleAt: { _ in 1 })
        ring.receive(sampleTime: 0, hostTimeNanoseconds: 10_666_666, sampleRate: 48_000,
            frameCount: 512, sampleAt: { _ in 99 })
        ring.receive(sampleTime: 512, hostTimeNanoseconds: 21_333_332, sampleRate: 48_000,
            frameCount: 512, sampleAt: { _ in 2 })
        XCTAssertNil(ring.failure, "Nominal 48 kHz rounding jitter must not pause startup")
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 2)
    }

    func testStartupRecoveryClampsRealisticResetAndSuccessorHostJitterWithoutOverlappingAudio() throws {
        for jitter in [UInt64(1), 2_000] {
            let clock = StartupTestClock()
            let origin: UInt64 = 1_000_000_000
            let ring = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: origin,
                sampleCapacity: 2048, blockCapacity: 4, permitsStartupClockRecovery: true,
                monotonicNow: { clock.now })
            ring.receive(sampleTime: 1024, hostTimeNanoseconds: origin, sampleRate: 48_000,
                frameCount: 512, sampleAt: { _ in 1 })
            let before = try XCTUnwrap(ring.peek())
            ring.receive(sampleTime: 0, hostTimeNanoseconds: before.endNanoseconds - jitter,
                sampleRate: 48_000, frameCount: 512,
                sampleAt: { _ in XCTFail("A reset callback must never read PCM"); return 99 })
            XCTAssertNil(ring.failure, "Callback-sized startup slack must include ordinary host jitter")
            XCTAssertEqual(ring.peek(), before, "Recovery must preserve the accepted segment byte-for-byte")
            let gap = try XCTUnwrap(ring.drainCaptureGaps().first)
            XCTAssertEqual(gap.reason, .startupTimestamp)
            XCTAssertEqual(gap.startNanoseconds, before.endNanoseconds)
            XCTAssertGreaterThan(gap.endNanoseconds, gap.startNanoseconds)

            ring.receive(sampleTime: 512, hostTimeNanoseconds: gap.endNanoseconds - jitter,
                sampleRate: 48_000, frameCount: 512, sampleAt: { _ in 2 })
            XCTAssertNil(ring.failure, "A successor one nanosecond or two microseconds short must recover")
            let oldSegment = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
                cutoffNanoseconds: nil, allowPartial: false))
            XCTAssertEqual(oldSegment.packet, before)
            XCTAssertEqual(oldSegment.throughSequence, 0)
            XCTAssertTrue(ring.acknowledge(sequence: 0))
            let after = try XCTUnwrap(ring.peek())
            XCTAssertEqual(after.sequence, 1)
            XCTAssertEqual(after.sampleOffset, 0)
            XCTAssertEqual(after.timelineOriginNanoseconds, gap.endNanoseconds)
            XCTAssertEqual(after.startNanoseconds, gap.endNanoseconds)
            XCTAssertGreaterThanOrEqual(after.startNanoseconds, before.endNanoseconds)
            XCTAssertEqual(after.samples, [Float](repeating: 2, count: 512))
            XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 1)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        }
    }

    func testStartupRecoveryGapAlsoClampsAboveObservedHostDrift() throws {
        let ring = try recoveringBuffer(StartupTestClock())
        putHardware(ring, sampleTime: 0, at: 0)
        putHardware(ring, sampleTime: 8, at: 1_500_000)
        putHardware(ring, sampleTime: 8, at: 2_000_000, value: 99)
        XCTAssertNil(ring.failure, "Observed host overlap within one callback is bounded startup jitter")
        XCTAssertEqual(ring.drainCaptureGaps(), [.init(source: .microphone, epoch: 1,
            startNanoseconds: 2_000_000, endNanoseconds: 3_000_000, reason: .startupTimestamp)])
        putHardware(ring, sampleTime: 16, at: 2_999_999, value: 2)
        XCTAssertNil(ring.failure)
        XCTAssertTrue(ring.acknowledge(sequence: 0, throughSequence: 1))
        XCTAssertEqual(ring.peek()?.timelineOriginNanoseconds, 3_000_000)
        XCTAssertEqual(ring.peek()?.startNanoseconds, 3_000_000)
    }

    func testStartupRecoveryRejectsOverlapBeyondOneCallbackOrTwentyMilliseconds() throws {
        for (rate, frames) in [(Double(48_000), 512), (Double(8_000), 512)] {
            let duration = try XCTUnwrap(MeetingAudioSampleClock.nanoseconds(frames: UInt64(frames), sampleRate: rate))
            let slack = min(duration, 20_000_000)
            for rejectSuccessor in [false, true] {
                let clock = StartupTestClock()
                let ring = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: 0,
                    sampleCapacity: 2048, blockCapacity: 4, permitsStartupClockRecovery: true,
                    monotonicNow: { clock.now })
                ring.receive(sampleTime: 1024, hostTimeNanoseconds: 100_000_000, sampleRate: rate,
                    frameCount: frames, sampleAt: { _ in 1 })
                let before = try XCTUnwrap(ring.peek())
                var boundary = before.endNanoseconds
                if rejectSuccessor {
                    ring.receive(sampleTime: 0, hostTimeNanoseconds: boundary, sampleRate: rate,
                        frameCount: frames, sampleAt: { _ in XCTFail("Reset PCM is untrusted"); return 99 })
                    XCTAssertNil(ring.failure)
                    boundary = try XCTUnwrap(ring.drainCaptureGaps().first).endNanoseconds
                }
                ring.receive(sampleTime: rejectSuccessor ? Double(frames) : 0,
                    hostTimeNanoseconds: boundary - slack - 1, sampleRate: rate, frameCount: frames,
                    sampleAt: { _ in XCTFail("Out-of-slack callbacks must not read PCM"); return 99 })
                XCTAssertEqual(ring.failure, .invalidTimestamp)
                XCTAssertEqual(ring.peek(), before)
                XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
                XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
            }
        }
    }

    func testDroppedCallbackCanRecoverOnceAndPreservesHostOrderAcrossCounterReset() throws {
        let ring = try recoveringBuffer(StartupTestClock())
        putHardware(ring, sampleTime: 1000, at: 0)
        let before = try XCTUnwrap(ring.peek())
        // Older counter values are numerically larger. The mailbox must consume host order,
        // including coalesced pre-reset drops, rather than sorting by the reset sample counter.
        ring.drop(sampleTime: 1008, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8)
        ring.drop(sampleTime: 1016, hostTimeNanoseconds: 2_000_000, sampleRate: 8000, frameCount: 8)
        ring.drop(sampleTime: 0, hostTimeNanoseconds: 3_000_000, sampleRate: 8000, frameCount: 8)
        ring.drop(sampleTime: 8, hostTimeNanoseconds: 4_000_000, sampleRate: 8000, frameCount: 8)
        putHardware(ring, sampleTime: 16, at: 5_000_000, value: 2)
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.diagnostics.droppedCallbacks, 4)
        XCTAssertEqual(ring.diagnostics.dropMailboxOverflows, 0)
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 2)
        XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 1)
        let gaps = ring.drainCaptureGaps()
        XCTAssertFalse(gaps.isEmpty)
        XCTAssertEqual(gaps.first?.startNanoseconds, before.endNanoseconds)
        XCTAssertEqual(gaps.last?.endNanoseconds, 5_000_000)
        XCTAssertTrue(gaps.contains { $0.reason == .callbackContention && $0.startNanoseconds == 1_000_000 })
        XCTAssertTrue(gaps.contains { $0.reason == .startupTimestamp && $0.startNanoseconds == 3_000_000 })
        for (previous, next) in zip(gaps, gaps.dropFirst()) {
            XCTAssertEqual(previous.endNanoseconds, next.startNanoseconds, "Loss intervals must neither overlap nor disappear")
        }
        XCTAssertEqual(ring.peek(), before)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        let after = try XCTUnwrap(ring.peek())
        XCTAssertEqual(after.sequence, 1)
        XCTAssertEqual(after.startNanoseconds, 5_000_000)
        XCTAssertEqual(after.samples, [Float](repeating: 2, count: 8))
        ring.drop(sampleTime: 16, hostTimeNanoseconds: 6_000_000, sampleRate: 8000, frameCount: 8)
        _ = ring.drainCaptureGaps()
        XCTAssertEqual(ring.failure, .sourceReconfigured, "A second reset requires a fresh epoch rather than another in-place startup recovery")
        XCTAssertEqual(ring.peek(), after)
    }

    func testCoalescedDropsPreserveLatestObservedEndForLeaseAndStartupBounds() throws {
        let lease = MeetingAudioLease(deadline: 3_250_000)
        let leased = try recoveringBuffer(StartupTestClock(), lease: lease)
        putHardware(leased, sampleTime: 0, at: 0)
        leased.drop(sampleTime: 8, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8)
        leased.drop(sampleTime: 16, hostTimeNanoseconds: 2_500_000, sampleRate: 8000, frameCount: 8)
        XCTAssertTrue(leased.drainCaptureGaps().isEmpty)
        XCTAssertEqual(leased.failure, .leaseExpired,
            "The coalesced nominal end is 3 ms, but the final measured callback ends at 3.5 ms")
        XCTAssertEqual(leased.diagnostics.acceptedCallbacks, 1)
        XCTAssertEqual(leased.diagnostics.dropMailboxOverflows, 0)

        let startup = try recoveringBuffer(StartupTestClock())
        putHardware(startup, sampleTime: 0, at: 0)
        startup.drop(sampleTime: 0, hostTimeNanoseconds: 498_000_000, sampleRate: 8000, frameCount: 8)
        startup.drop(sampleTime: 8, hostTimeNanoseconds: 499_500_000, sampleRate: 8000, frameCount: 8)
        XCTAssertTrue(startup.drainCaptureGaps().isEmpty)
        XCTAssertEqual(startup.failure, .sourceReconfigured,
            "A nominal 500 ms coalesced reset must not hide its measured 500.5 ms end")
        XCTAssertFalse(startup.hasRecoveredStartupClock)
        XCTAssertEqual(startup.diagnostics.acceptedCallbacks, 1)
        XCTAssertEqual(startup.diagnostics.dropMailboxOverflows, 0)
    }

    func testCoalescedDropsPreserveObservedEndAsTheNextResetGapBoundary() throws {
        let ring = try recoveringBuffer(StartupTestClock())
        putHardware(ring, sampleTime: 0, at: 0)
        ring.drop(sampleTime: 8, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8)
        ring.drop(sampleTime: 16, hostTimeNanoseconds: 2_500_000, sampleRate: 8000, frameCount: 8)
        XCTAssertEqual(ring.drainCaptureGaps(), [.init(source: .microphone, epoch: 1,
            startNanoseconds: 1_000_000, endNanoseconds: 3_000_000, reason: .callbackContention)])
        putHardware(ring, sampleTime: 0, at: 3_000_000, value: 99)
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.drainCaptureGaps(), [.init(source: .microphone, epoch: 1,
            startNanoseconds: 3_000_000, endNanoseconds: 4_000_000, reason: .startupTimestamp)])
        putHardware(ring, sampleTime: 8, at: 4_000_000, value: 2)
        XCTAssertNil(ring.failure)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertEqual(ring.peek()?.startNanoseconds, 4_000_000)
    }

    func testSampleContiguousDropsWithHostInversionNeverInventAClockReset() throws {
        let ring = try recoveringBuffer(StartupTestClock())
        putHardware(ring, sampleTime: 0, at: 0)
        ring.drop(sampleTime: 8, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8)
        ring.drop(sampleTime: 16, hostTimeNanoseconds: 999_999, sampleRate: 8000, frameCount: 8)
        putHardware(ring, sampleTime: 24, at: 3_000_000, value: 2)
        XCTAssertNil(ring.failure)
        XCTAssertFalse(ring.hasRecoveredStartupClock)
        XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 0)
        XCTAssertEqual(ring.diagnostics.droppedCallbacks, 2)
        XCTAssertEqual(ring.drainCaptureGaps(), [.init(source: .microphone, epoch: 1,
            startNanoseconds: 1_000_000, endNanoseconds: 3_000_000, reason: .callbackContention)])
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        let packet = try XCTUnwrap(ring.peek())
        XCTAssertEqual(packet.timelineOriginNanoseconds, 0)
        XCTAssertEqual(packet.sampleOffset, 24)
        XCTAssertEqual(packet.startNanoseconds, 3_000_000)
        XCTAssertEqual(packet.samples, [Float](repeating: 2, count: 8))
    }

    func testVariableFrameResetFrontierPreservesCallbackOrderDespiteHostInversion() throws {
        let ring = try recoveringBuffer(StartupTestClock())
        putHardware(ring, sampleTime: 0, at: 0)
        ring.drop(sampleTime: 8, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8)
        ring.drop(sampleTime: 0, hostTimeNanoseconds: 999_999, sampleRate: 8000, frameCount: 16)
        ring.drop(sampleTime: 16, hostTimeNanoseconds: 2_999_999, sampleRate: 8000, frameCount: 8)
        putHardware(ring, sampleTime: 24, at: 3_999_999, value: 2)
        XCTAssertNil(ring.failure)
        XCTAssertTrue(ring.hasRecoveredStartupClock)
        XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, 1)
        XCTAssertEqual(ring.diagnostics.droppedCallbacks, 3)
        XCTAssertEqual(ring.diagnostics.dropMailboxOverflows, 0)
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 2)
        let gaps = ring.drainCaptureGaps()
        XCTAssertEqual(gaps.first, .init(source: .microphone, epoch: 1,
            startNanoseconds: 1_000_000, endNanoseconds: 2_000_000, reason: .callbackContention))
        XCTAssertTrue(gaps.contains { $0.reason == .startupTimestamp && $0.startNanoseconds == 2_000_000 })
        XCTAssertEqual(gaps.last?.endNanoseconds, 3_999_999)
        for (previous, next) in zip(gaps, gaps.dropFirst()) {
            XCTAssertEqual(previous.endNanoseconds, next.startNanoseconds)
        }
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        let packet = try XCTUnwrap(ring.peek())
        XCTAssertEqual(packet.sequence, 1)
        XCTAssertEqual(packet.startNanoseconds, 3_999_999)
        XCTAssertEqual(packet.samples, [Float](repeating: 2, count: 8))
        ring.drop(sampleTime: 24, hostTimeNanoseconds: 4_999_999, sampleRate: 8000, frameCount: 8)
        _ = ring.drainCaptureGaps()
        XCTAssertEqual(ring.failure, .sourceReconfigured, "The inverted reset frontier still consumes the one in-place recovery")
    }

    func testCoalescedDropsCannotInflateStartupSlackBeyondOnePhysicalCallback() throws {
        let ring = try recoveringBuffer(StartupTestClock())
        putHardware(ring, sampleTime: 1000, at: 100_000_000)
        // The first dropped callback is only one millisecond long. Coalescing its
        // two-millisecond successor must not legitimize a reset two milliseconds early.
        ring.drop(sampleTime: 0, hostTimeNanoseconds: 99_000_000, sampleRate: 8000, frameCount: 8)
        ring.drop(sampleTime: 8, hostTimeNanoseconds: 100_000_000, sampleRate: 8000, frameCount: 16)
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        XCTAssertEqual(ring.failure, .invalidTimestamp)
        XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
        XCTAssertEqual(ring.diagnostics.droppedCallbacks, 2)
        XCTAssertEqual(ring.diagnostics.dropMailboxOverflows, 0)
        XCTAssertEqual(ring.peek()?.samples, [Float](repeating: 1, count: 8))
    }

    func testDroppedStartupResetRetainsOptInMicrophoneTimeAndLeaseBounds() throws {
        for scenario in 0..<6 {
            let clock = StartupTestClock()
            let lease = MeetingAudioLease(deadline: scenario == 5 ? 1_500_000 : UInt64.max)
            let ring = try MeetingAudioBuffer(source: scenario == 0 ? .output : .microphone,
                epoch: 1, originNanoseconds: 0, sampleCapacity: 64, blockCapacity: 8, lease: lease,
                permitsStartupClockRecovery: scenario != 1, monotonicNow: { clock.now })
            putHardware(ring, sampleTime: 0, at: 0)
            if scenario == 2 { clock.now += 500_000_001 }
            if scenario == 3 { clock.now -= 1 }
            ring.drop(sampleTime: 0, hostTimeNanoseconds: scenario == 4 ? 499_000_001 : 1_000_000,
                sampleRate: 8000, frameCount: 8)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
            XCTAssertNotNil(ring.failure, "Dropped resets remain subject to the same startup admission bounds")
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
            XCTAssertEqual(ring.diagnostics.sampleDiscontinuities, scenario == 3 || scenario == 5 ? 0 : 1)
            XCTAssertEqual(ring.peek()?.samples, [Float](repeating: 1, count: 8))
        }
    }

    func testStartupRecoveryDoesNotBypassLeaseDeviceOrScopeFaults() throws {
        for sampleTime in [Double(0), 8] {
            let lease = MeetingAudioLease(deadline: 1_500_000)
            let ring = try recoveringBuffer(StartupTestClock(), lease: lease)
            putHardware(ring, sampleTime: 0, at: 0)
            var copied = false
            ring.receive(sampleTime: sampleTime, hostTimeNanoseconds: 1_000_000, sampleRate: 8000,
                         frameCount: 8, sampleAt: { _ in copied = true; return 2 })
            XCTAssertNotNil(ring.failure)
            if sampleTime == 8 { XCTAssertEqual(ring.failure, .leaseExpired) }
            XCTAssertFalse(copied)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
            lease.update(deadline: 30_000_000_000)
            putHardware(ring, sampleTime: 8, at: 2_000_000, value: 3)
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
        }
        let faults: [MeetingAudioFailure] = [.invalidSelection, .deviceFailure(operation: "test-device", status: -1)]
        for fault in faults {
            let ring = try recoveringBuffer(StartupTestClock())
            putHardware(ring, sampleTime: 0, at: 0)
            ring.fail(fault)
            var copied = false
            ring.receive(sampleTime: 0, hostTimeNanoseconds: 1_000_000, sampleRate: 8000,
                         frameCount: 8, sampleAt: { _ in copied = true; return 2 })
            XCTAssertEqual(ring.failure, fault)
            XCTAssertFalse(copied)
            XCTAssertFalse(ring.withSendAdmission { XCTFail("Faulted capture cannot send") })
            XCTAssertEqual(ring.diagnostics.acceptedCallbacks, 1)
            XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
        }
    }

    func testDroppedFinalCallbackSurvivesCloseWithoutAnotherCallback() throws {
        let ring = try buffer()
        put(ring)
        ring.drop(sampleTime: 8, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8)
        ring.close()
        XCTAssertEqual(ring.drainCaptureGaps(cutoffNanoseconds: 1_500_000), [MeetingAudioGap(source: .microphone,
            epoch: 1, startNanoseconds: 1_000_000, endNanoseconds: 1_500_000, reason: .callbackContention)])
        XCTAssertNil(ring.failure)
        XCTAssertTrue(ring.drainCaptureGaps().isEmpty)
    }

    func testContentionTelemetryCoalescesHundredsOfCallbacksWithoutLosingItsCause() throws {
        let ring = try buffer()
        for index in 0..<250 {
            ring.drop(sampleTime: Double(index * 8), hostTimeNanoseconds: UInt64(index) * 1_000_000,
                sampleRate: 8000, frameCount: 8)
        }
        XCTAssertNil(ring.failure)
        XCTAssertEqual(ring.diagnostics.droppedCallbacks, 250)
        XCTAssertEqual(ring.diagnostics.dropMailboxOverflows, 0)
        XCTAssertEqual(ring.drainCaptureGaps(), [.init(source: .microphone, epoch: 1,
            startNanoseconds: 0, endNanoseconds: 250_000_000, reason: .callbackContention)])
        XCTAssertNil(ring.failure)
    }

    func testContentionTelemetryIsBoundedAndNonCoalescibleExhaustionIsExplicit() throws {
        let ring = try buffer()
        for index in 0..<64 {
            ring.setHostSourceVerificationPending(index % 2 == 0)
            if index % 2 == 0 {
                ring.receive(sampleTime: Double(index), hostTimeNanoseconds: UInt64(index) * 125_000,
                    sampleRate: 8000, frameCount: 1,
                    sampleAt: { _ in XCTFail("Quarantined callbacks cannot read PCM"); return 1 })
            } else {
                ring.drop(sampleTime: Double(index), hostTimeNanoseconds: UInt64(index) * 125_000,
                    sampleRate: 8000, frameCount: 1)
            }
        }
        XCTAssertNil(ring.failure)
        ring.setHostSourceVerificationPending(true)
        ring.receive(sampleTime: 64, hostTimeNanoseconds: 8_000_000, sampleRate: 8000, frameCount: 1,
            sampleAt: { _ in XCTFail("A full quarantine mailbox cannot read PCM"); return 1 })
        XCTAssertEqual(ring.failure, .bufferFull)
        let gaps = ring.drainCaptureGaps()
        XCTAssertEqual(gaps.count, 64, "Different loss causes must never merge just to avoid a fixed capacity")
        XCTAssertEqual(gaps.first?.reason, .sourceVerification)
        XCTAssertEqual(gaps.last?.reason, .callbackContention)
        XCTAssertEqual(ring.diagnostics.droppedCallbacks, 64)
        XCTAssertEqual(ring.diagnostics.dropMailboxOverflows, 1)
    }

    func testStopHonorsObservedHostBoundaryWhenSampleClockDrifts() throws {
        let ring = try buffer()
        ring.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 1 })
        ring.receive(sampleTime: 8, hostTimeNanoseconds: 1_500_000, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 2 })
        ring.close()
        let packet = try XCTUnwrap(ring.peekChunk(targetDurationNanoseconds: 5_000_000_000,
            cutoffNanoseconds: 2_000_000, allowPartial: true)?.packet)
        XCTAssertEqual(packet.samples.count, 12, "Only four samples in the drifted callback precede Stop")
        XCTAssertLessThanOrEqual(packet.endNanoseconds, 2_000_000)
    }

    func testHighRateCapacityWarnsBeforeItsShorterMemoryLimit() throws {
        let capacity = MeetingAudioBuffer.effectiveCapacityNanoseconds(sampleRate: 192_000)
        XCTAssertEqual(capacity, 10_922_666_667)
        let ring = try MeetingAudioBuffer(source: .output, epoch: 1, originNanoseconds: 0)
        ring.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 192_000, frameCount: 512, sampleAt: { _ in 0 })
        XCTAssertFalse(ring.isBacklogged(nowNanoseconds: capacity / 2 - 1))
        XCTAssertTrue(ring.isBacklogged(nowNanoseconds: capacity / 2))
    }

    func testFormatFailureDuringContentionKeepsItsReason() throws {
        let ring = try buffer()
        ring.receive(hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 1) { _ in
            ring.fail(.invalidFormat)
            return 0.5
        }
        XCTAssertEqual(ring.failure, .invalidFormat)
        XCTAssertNil(ring.peek())
    }

    func testCaptureLeaseClosesAdmissionWithoutWaitingForControlThread() throws {
        let lease = MeetingAudioLease(deadline: 1_000_000)
        let ring = try MeetingAudioBuffer(source: .microphone, epoch: 1, originNanoseconds: 0,
            sampleCapacity: 32, blockCapacity: 8, lease: lease)
        ring.receive(sampleTime: 0, hostTimeNanoseconds: 0, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 1 })
        var readPostLease = false
        ring.receive(sampleTime: 8, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8,
            sampleAt: { _ in readPostLease = true; return 2 })
        XCTAssertFalse(readPostLease, "Expired lease must reject before reading samples")
        XCTAssertEqual(ring.failure, .leaseExpired)
        lease.update(deadline: 30_000_000_000)
        ring.receive(sampleTime: 8, hostTimeNanoseconds: 1_000_000, sampleRate: 8000, frameCount: 8, sampleAt: { _ in 3 })
        XCTAssertEqual(ring.peek()?.samples, [Float](repeating: 1, count: 8))
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertNil(ring.peek(), "Renewing transport must not reopen expired admission")
    }

}
