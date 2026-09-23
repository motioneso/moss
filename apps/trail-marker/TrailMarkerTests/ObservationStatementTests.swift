import XCTest
@testable import TrailMarker

final class ObservationStatementTests: XCTestCase {
    private let originalSentence =
        "These permissions prepare future capabilities. Trail Marker is not observing your activity."

    func testWithFocusOffItKeepsTheOriginalWording() {
        XCTAssertEqual(ObservationStatement.current(focusEnabled: false), originalSentence)
    }

    func testWithFocusOnItSaysWhatIsSentAndNeverTheOldSentence() {
        let text = ObservationStatement.current(focusEnabled: true)
        XCTAssertTrue(text.contains("name of the app in front"))
        XCTAssertTrue(text.contains("shortened window title"))
        XCTAssertTrue(text.contains("another company"))
        XCTAssertTrue(text.contains("Moss calendar block"))
        // If the old sentence stayed on screen while observing, the screen would be untrue.
        XCTAssertFalse(text.contains("is not observing your activity"))
        XCTAssertFalse(text.contains("prepare future capabilities"))
    }

    func testWatchingTheEntireDesktopSaysSoInsteadOfClaimingAnAllowlist() {
        let text = ObservationStatement.current(focusEnabled: true, watchEntireDesktop: true)
        XCTAssertTrue(text.contains("entire desktop"))
        // Must not still claim a per-app allowlist scope while watching everything.
        XCTAssertFalse(text.contains("apps you have allowed"))
    }

    func testAccessibilityIsDescribedByWhatItIsNowFor() {
        XCTAssertFalse(ObservationStatement.accessibilityScope.contains("future shortcuts"))
        XCTAssertTrue(ObservationStatement.accessibilityScope.contains("window in front"))
    }
}
