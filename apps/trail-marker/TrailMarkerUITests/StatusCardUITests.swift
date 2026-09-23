import XCTest

/// Phase 0 end-to-end (Backtrack plan §3.5): the real card, drawn by the real app, driven through
/// the UI. The Debug-only `-TMHostCardInWindow YES` hosts it in a window against a stubbed link,
/// because XCUITest can't open a status item's popover.
final class StatusCardUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-TMHostCardInWindow", "YES"]
        app.launch()
    }

    override func tearDown() {
        app.terminate()
    }

    private var pauseAll: XCUIElement { app.buttons["Pause All"] }
    private var resumeAll: XCUIElement { app.buttons["Resume All"] }
    private var focusSwitch: XCUIElement { app.switches["switch.Focus"] }

    private func isOn(_ element: XCUIElement) -> Bool {
        (element.value as? String) == "1" || (element.value as? Int) == 1
    }

    func testPauseAllAndResumeAllTitles() {
        XCTAssertTrue(pauseAll.waitForExistence(timeout: 10))
        pauseAll.click()
        XCTAssertTrue(resumeAll.waitForExistence(timeout: 5))
        resumeAll.click()
        XCTAssertTrue(pauseAll.waitForExistence(timeout: 5))
    }

    func testTogglingFocusChangesTheRow() {
        XCTAssertTrue(focusSwitch.waitForExistence(timeout: 10))
        XCTAssertTrue(isOn(focusSwitch))
        focusSwitch.click()
        XCTAssertFalse(isOn(focusSwitch))
        focusSwitch.click()
        XCTAssertTrue(isOn(focusSwitch))
    }

    func testDuringPauseAllTheFocusSwitchIsDisabledAndKeepsItsPosition() {
        XCTAssertTrue(focusSwitch.waitForExistence(timeout: 10))
        focusSwitch.click()
        XCTAssertFalse(isOn(focusSwitch))

        XCTAssertTrue(pauseAll.waitForExistence(timeout: 5))
        pauseAll.click()
        XCTAssertTrue(resumeAll.waitForExistence(timeout: 5))
        XCTAssertFalse(focusSwitch.isEnabled)
        XCTAssertFalse(isOn(focusSwitch))

        resumeAll.click()
        XCTAssertTrue(pauseAll.waitForExistence(timeout: 5))
        XCTAssertTrue(focusSwitch.isEnabled)
        XCTAssertFalse(isOn(focusSwitch))
    }

    func testSettingsOpensWithItsSections() {
        let settings = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Settings")).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.click()
        for section in ["Connection", "This Mac", "Focus", "Permissions", "Updates"] {
            XCTAssertTrue(app.staticTexts[section].waitForExistence(timeout: 5), "missing \(section)")
        }
    }
}
