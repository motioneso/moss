import Foundation
import XCTest
@testable import TrailMarker

final class MeetingCaptureClockTests: XCTestCase {
    func testFractionalSampleDurationCoversTheCumulativeEnd() throws {
        // A real callback-sized tail extends this five-second clip by 2.667 ms.
        let packet = MeetingAudioPacket(source: .microphone, epoch: 1, sequence: 0,
            startNanoseconds: 0, sampleRate: 48_000,
            samples: [Float](repeating: 0, count: 240_128))
        let boundary = try MeetingWireAudioBoundary(packet: packet, originNanoseconds: 0)
        XCTAssertEqual(boundary.startMs, 0)
        XCTAssertEqual(boundary.endMs, 5003)
        XCTAssertGreaterThanOrEqual(boundary.endMs * 1_000_000, packet.endNanoseconds)
    }

    func testMillisecondCoveragePreservesExactBoundariesAndCannotOverflow() {
        let cases: [(UInt64, UInt64)] = [
            (0, 0), (1, 1), (999_999, 1), (1_000_000, 1), (1_000_001, 2),
            (UInt64.max, UInt64.max / 1_000_000 + 1)
        ]
        for (nanoseconds, expected) in cases {
            XCTAssertEqual(MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: nanoseconds), expected)
        }
    }

    func testCumulativeCoverageHasNoOverlapsOrRoundingDriftAcrossSampleRates() throws {
        let origin: UInt64 = 4_000_000_000
        let phase: UInt64 = 400_000
        for rate in [44_100.0, 48_000.0, 192_000.0] {
            let frames = Int(rate * 5) + 128
            let samples = [Float](repeating: 0, count: frames)
            var previousEnd: UInt64?
            for index in 0..<5000 {
                let offset = UInt64(index * frames)
                let elapsedStart = phase + (try XCTUnwrap(MeetingAudioSampleClock.nanoseconds(
                    frames: offset, sampleRate: rate)))
                let packet = MeetingAudioPacket(source: .microphone, epoch: 1, sequence: UInt64(index),
                    startNanoseconds: origin + elapsedStart, sampleRate: rate, samples: samples,
                    timelineOriginNanoseconds: origin + phase, sampleOffset: offset)
                let boundary = try MeetingWireAudioBoundary(packet: packet, originNanoseconds: origin)
                if let previousEnd { XCTAssertEqual(boundary.startMs, previousEnd) }
                let elapsedEnd = packet.endNanoseconds - origin
                XCTAssertGreaterThanOrEqual(boundary.startMs * 1_000_000, elapsedStart)
                XCTAssertLessThan(boundary.startMs * 1_000_000, elapsedStart + 1_000_000)
                XCTAssertGreaterThanOrEqual(boundary.endMs * 1_000_000, elapsedEnd)
                XCTAssertLessThan(boundary.endMs * 1_000_000, elapsedEnd + 1_000_000)
                // The sample count remains authoritative: a shared integer timeline cannot
                // independently round every fractional clip duration up without overlap/drift.
                let duration = Double(frames) * 1000 / rate
                XCTAssertLessThan(abs(Double(boundary.endMs - boundary.startMs) - duration), 1)
                previousEnd = boundary.endMs
            }
        }
    }

    func testSubMillisecondTailsUseTheSameCoverageRule() throws {
        let packet = MeetingAudioPacket(source: .microphone, epoch: 1, sequence: 0,
            startNanoseconds: 875_000, sampleRate: 8000, samples: [0])
        XCTAssertEqual(MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: packet.startNanoseconds),
            MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: packet.endNanoseconds))
        XCTAssertThrowsError(try MeetingWireAudioBoundary(packet: packet, originNanoseconds: 0))

        let crossing = MeetingAudioPacket(source: .microphone, epoch: 1, sequence: 1,
            startNanoseconds: 1_000_000, sampleRate: 8000, samples: [0])
        let boundary = try MeetingWireAudioBoundary(packet: crossing, originNanoseconds: 0)
        XCTAssertEqual(boundary.startMs, 1)
        XCTAssertEqual(boundary.endMs, 2)
    }

    func testCoveredBoundaryRemainsInsideAnIntegerStopCutoff() throws {
        let origin: UInt64 = 4_000_000_123
        let cutoffMs: UInt64 = 5003
        let packet = MeetingAudioPacket(source: .microphone, epoch: 1, sequence: 0,
            startNanoseconds: origin + 200_000, sampleRate: 48_000,
            samples: [Float](repeating: 0, count: 240_128))
        XCTAssertLessThanOrEqual(packet.endNanoseconds, origin + cutoffMs * 1_000_000)
        let boundary = try MeetingWireAudioBoundary(packet: packet, originNanoseconds: origin)
        XCTAssertEqual(boundary.endMs, cutoffMs)
    }
}
