import XCTest
@testable import TrailMarker

final class ObservationStatementTests: XCTestCase {
    private let originalSentence =
        "These permissions prepare future capabilities. Trail Marker is not observing your activity."

    func testWithFocusOffItKeepsTheOriginalWording() {
        XCTAssertEqual(ObservationStatement.current(focusEnabled: false, paused: false), originalSentence)
        XCTAssertEqual(ObservationStatement.current(focusEnabled: false, paused: true), originalSentence)
    }

    func testWithFocusOnAndNotPausedItSaysWhatIsSentAndNeverTheOldSentence() {
        let text = ObservationStatement.current(focusEnabled: true, paused: false)
        XCTAssertTrue(text.contains("name of the app in front"))
        XCTAssertTrue(text.contains("shortened window title"))
        XCTAssertTrue(text.contains("Moss calendar block"))
        // If the old sentence stayed on screen while observing, the screen would be untrue.
        XCTAssertFalse(text.contains("is not observing your activity"))
        XCTAssertFalse(text.contains("prepare future capabilities"))
    }

    func testWhenPausedItSaysPaused() {
        let text = ObservationStatement.current(focusEnabled: true, paused: true)
        XCTAssertTrue(text.lowercased().contains("paused"))
        XCTAssertFalse(text.contains("name of the app in front"))
    }

    func testAccessibilityIsDescribedByWhatItIsNowFor() {
        XCTAssertFalse(ObservationStatement.accessibilityScope.contains("future shortcuts"))
        XCTAssertTrue(ObservationStatement.accessibilityScope.contains("window in front"))
    }
}
