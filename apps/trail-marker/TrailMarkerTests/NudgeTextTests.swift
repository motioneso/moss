import XCTest
@testable import TrailMarker

final class NudgeTextTests: XCTestCase {
    func testTheNudgeIsAFixedTemplateNamingTheBlock() {
        XCTAssertEqual(
            NudgeText.body(blockTitle: "Study AI"),
            "Your block “Study AI” is on. Ready to get back to it?"
        )
    }

    func testAVeryLongBlockTitleIsShortened() {
        let body = NudgeText.body(blockTitle: String(repeating: "x", count: 500))
        XCTAssertLessThan(body.count, 160)
        XCTAssertTrue(body.contains("…"))
    }

    func testControlCharactersInATitleAreRemoved() {
        let body = NudgeText.body(blockTitle: "Study\nAI\u{7}")
        XCTAssertTrue(body.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) })
    }

    func testTheTestNudgeSaysItIsATest() {
        XCTAssertTrue(NudgeText.testBody.lowercased().contains("test"))
    }
}
