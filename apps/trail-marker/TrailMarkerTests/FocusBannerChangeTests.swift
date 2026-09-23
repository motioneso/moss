import XCTest
@testable import TrailMarker

final class FocusBannerChangeTests: XCTestCase {
    func testOnlyDistractedShowsAndOnlyFocusedClears() {
        XCTAssertEqual(FocusBannerChange.after(.distracted), .show)
        XCTAssertEqual(FocusBannerChange.after(.focused), .hide)
        XCTAssertEqual(FocusBannerChange.after(.necessaryDetour), .keep)
        XCTAssertEqual(FocusBannerChange.after(.insufficientEvidence), .keep)
    }
}
