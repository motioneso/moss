import XCTest
@testable import TrailMarker

/// Rung3Decision.shouldCapture is the one gate on when a screenshot is ever taken (rung3 spec §2):
/// only to resolve insufficient_evidence, only with the person's consent, only with the OS
/// permission actually granted. Each condition is checked failing on its own.
final class Rung3DecisionTests: XCTestCase {
    func testCapturesOnlyWhenAllThreeConditionsHold() {
        XCTAssertTrue(
            Rung3Decision.shouldCapture(
                label: .insufficientEvidence, rung3Enabled: true, screenRecordingGranted: true
            )
        )
    }

    func testNeverCapturesForAnAnswerOtherThanInsufficientEvidence() {
        for label: FocusLabel in [.focused, .necessaryDetour, .distracted] {
            XCTAssertFalse(
                Rung3Decision.shouldCapture(label: label, rung3Enabled: true, screenRecordingGranted: true),
                "\(label) must never trigger a capture"
            )
        }
    }

    func testNeverCapturesWithoutConsent() {
        XCTAssertFalse(
            Rung3Decision.shouldCapture(
                label: .insufficientEvidence, rung3Enabled: false, screenRecordingGranted: true
            )
        )
    }

    func testNeverCapturesWithoutTheOSPermission() {
        XCTAssertFalse(
            Rung3Decision.shouldCapture(
                label: .insufficientEvidence, rung3Enabled: true, screenRecordingGranted: false
            )
        )
    }
}
