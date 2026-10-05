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
        let ring = try buffer()
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
        XCTAssertEqual(ring.failure, .invalidTimestamp)
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
        XCTAssertEqual(ring.failure, .invalidFormat)
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
            XCTAssertEqual(ring.failure, .invalidTimestamp)
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

    func testCallbackContentionReturnsBeforeControlIsReleasedAndLatchesFault() throws {
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
            ring.fail(.invalidFormat)
            contendedDone.fulfill()
        }
        wait(for: [contendedDone], timeout: 1)
        release.signal()
        wait(for: [firstDone], timeout: 2)
        XCTAssertEqual(ring.failure, .bufferFull)
        XCTAssertEqual(ring.peek()?.samples, [0.5])
        put(ring, at: 125_000, count: 1)
        XCTAssertTrue(ring.acknowledge(sequence: 0))
        XCTAssertNil(ring.peek())
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
            epoch: 3, startNanoseconds: 0, endNanoseconds: 4_000_000_001, reason: .expired)])
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

}
