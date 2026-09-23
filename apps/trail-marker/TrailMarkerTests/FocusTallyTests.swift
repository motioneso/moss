import XCTest
@testable import TrailMarker

final class FocusTallyTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testAnyOtherLabelBreaksTheDistractedRunLikeTheServerRule() {
        var tally = FocusTally()
        tally.record(.distracted, nudged: false, blockId: "b1", at: start)
        XCTAssertEqual(tally.distractedRun, 1)
        tally.record(.insufficientEvidence, nudged: false, blockId: "b1", at: start)
        XCTAssertEqual(tally.distractedRun, 0)
        tally.record(.distracted, nudged: false, blockId: "b1", at: start)
        tally.record(.distracted, nudged: true, blockId: "b1", at: start)
        XCTAssertEqual(tally.distractedRun, 2)
        XCTAssertTrue(tally.summary(now: start).contains("nudge due"))
        tally.record(.focused, nudged: false, blockId: "b1", at: start)
        XCTAssertEqual(tally.distractedRun, 0)
    }

    func testANewBlockStartsTheCountsOverButKeepsTheLastNudge() {
        var tally = FocusTally()
        tally.record(.distracted, nudged: true, blockId: "b1", at: start)
        tally.record(.focused, nudged: false, blockId: "b2", at: start)
        XCTAssertEqual(tally.counts, [.focused: 1])
        XCTAssertEqual(tally.distractedRun, 0)
        XCTAssertEqual(tally.lastNudgeAt, start)
    }

    func testTheNextAllowedNudgeIsFortyFiveMinutesAfterTheLast() {
        var tally = FocusTally()
        tally.record(.distracted, nudged: true, blockId: "b1", at: start)
        XCTAssertTrue(tally.summary(now: start.addingTimeInterval(44 * 60)).contains("next allowed \(start.addingTimeInterval(45 * 60).formatted(date: .omitted, time: .shortened))"))
        XCTAssertTrue(tally.summary(now: start.addingTimeInterval(45 * 60)).contains("next allowed now"))
    }
}
