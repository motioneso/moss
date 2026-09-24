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
        // The first launch after a fresh build can take well over ten seconds to draw the card;
        // wait for it once here so no test's own short timeout races a cold start. The harness
        // now starts running every launch (#2646), so Pause All is what appears.
        XCTAssertTrue(app.buttons["Pause All"].waitForExistence(timeout: 30), "the card never appeared running")
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
        for section in ["Connection", "This Mac", "Focus", "Backtrack", "Permissions", "Updates"] {
            XCTAssertTrue(app.staticTexts[section].waitForExistence(timeout: 5), "missing \(section)")
        }
    }

    /// Backtrack plan §4.5 UI: the menu row appears only once Backtrack is turned on through its
    /// consent sheet, and during Pause All it is greyed and keeps its position. The harness's
    /// Backtrack reads nothing (its capture always fails), so this drives the UI only.
    func testBacktrackRowNeedsConsentAndKeepsItsPositionDuringPauseAll() {
        let backtrackSwitch = app.switches["switch.Backtrack"]
        XCTAssertFalse(backtrackSwitch.exists, "no row before Backtrack is turned on")

        let settings = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Settings")).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.click()
        let section = app.staticTexts["Backtrack"]
        XCTAssertTrue(section.waitForExistence(timeout: 5))
        section.click()
        let enable = app.descendants(matching: .any)["backtrack.enabled"].firstMatch
        XCTAssertTrue(enable.waitForExistence(timeout: 5))
        enable.click()
        let turnOn = app.buttons["backtrack.consent.turnOn"]
        XCTAssertTrue(turnOn.waitForExistence(timeout: 5), "the consent sheet appears first")
        XCTAssertFalse(backtrackSwitch.exists, "still no row until consent")
        turnOn.click()

        XCTAssertTrue(backtrackSwitch.waitForExistence(timeout: 5), "the row appears once turned on")
        XCTAssertTrue(isOn(backtrackSwitch))
        XCTAssertTrue(pauseAll.waitForExistence(timeout: 5))
        pauseAll.click()
        XCTAssertTrue(resumeAll.waitForExistence(timeout: 5))
        XCTAssertFalse(backtrackSwitch.isEnabled)
        XCTAssertTrue(isOn(backtrackSwitch), "Pause All keeps its position")
        resumeAll.click()
        XCTAssertTrue(pauseAll.waitForExistence(timeout: 5))
        XCTAssertTrue(backtrackSwitch.isEnabled)
    }
}
