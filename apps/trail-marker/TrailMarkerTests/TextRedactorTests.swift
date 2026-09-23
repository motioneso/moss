import XCTest
@testable import TrailMarker

final class TextRedactorTests: XCTestCase {
    func testALongTokenIsRemoved() {
        let token = String(repeating: "aB3dE", count: 8) // 40 characters
        let cleaned = TextRedactor.clean("key \(token) end", limit: 200)
        XCTAssertFalse(cleaned.contains(token))
        XCTAssertFalse(cleaned.contains("aB3dEaB3dE"))
    }

    func testARedactedTokenCannotSurviveByBeingCutInHalfFirst() {
        // Truncating before redacting would leave the first 20 characters of the token in
        // place, and 20 is below the token threshold, so nothing would be removed.
        let token = String(repeating: "Zx9Qa", count: 8)
        let cleaned = TextRedactor.clean("abc \(token)", limit: 24)
        XCTAssertFalse(cleaned.contains("Zx9QaZx9Qa"))
        XCTAssertLessThanOrEqual(cleaned.count, 24)
    }

    func testAnEmailLookingStringIsRemoved() {
        let cleaned = TextRedactor.clean("Inbox - ben@example.com - Mail", limit: 200)
        XCTAssertFalse(cleaned.contains("ben@example.com"))
        XCTAssertTrue(cleaned.contains("Inbox"))
    }

    func testControlCharactersAreRemoved() {
        let cleaned = TextRedactor.clean("a\u{0}b\u{7}c\nd\te", limit: 200)
        XCTAssertTrue(cleaned.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) })
        XCTAssertTrue(cleaned.contains("a"))
        XCTAssertTrue(cleaned.contains("e"))
    }

    func testNeverReturnsMoreThanTheLimit() {
        let long = String(repeating: "word ", count: 100)
        for limit in [0, 1, 10, 200] {
            XCTAssertLessThanOrEqual(TextRedactor.clean(long, limit: limit).count, limit)
        }
    }

    func testOrdinaryWordsAreKept() {
        XCTAssertEqual(TextRedactor.clean("Quarterly review — slides", limit: 200), "Quarterly review — slides")
    }
}
