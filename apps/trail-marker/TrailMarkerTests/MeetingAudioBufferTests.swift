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
        for rate in [Double.nan, .infinity, -1, 0, 7999, 192001] {
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

}
