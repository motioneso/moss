import XCTest
@testable import TrailMarker

final class ServerTimeTests: XCTestCase {
    func testParsesFractionalSeconds() {
        XCTAssertNotNil(ServerTime.parse("2026-09-20T21:26:40.572Z"))
    }

    func testParsesWholeSeconds() {
        XCTAssertNotNil(ServerTime.parse("2026-09-20T21:26:40Z"))
    }

    func testRejectsGarbage() {
        XCTAssertNil(ServerTime.parse("not a date"))
    }
}
