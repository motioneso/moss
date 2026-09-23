import XCTest
@testable import TrailMarker

/// Capture takes exactly the window the policy checked (#2643). It replaced "the app's largest
/// window", which could let a small ordinary browser window in front authorise a picture of a
/// larger private window behind it.
final class ScreenCaptureTests: XCTestCase {
    private let browser: pid_t = 501

    private func window(_ pid: pid_t, _ title: String?, _ frame: CGRect, onScreen: Bool = true) -> CapturableWindow {
        CapturableWindow(pid: pid, title: title, isOnScreen: onScreen, frame: frame)
    }

    func testTakesTheSmallFocusedWindowNotTheLargerPrivateOneBehindIt() {
        let ordinary = CGRect(x: 100, y: 100, width: 600, height: 400)
        let windows = [
            window(browser, "Private Browsing — Bank", CGRect(x: 0, y: 0, width: 1600, height: 1000)),
            window(browser, "Docs", ordinary)
        ]
        let identity = WindowIdentity(frame: ordinary, title: "Docs")

        XCTAssertEqual(matchCaptureWindowIndex(from: windows, pid: browser, appName: "Browser", identity: identity), 1)
    }

    /// Ghostty registers a 68pt untitled sliver alongside its real window (seen live); the
    /// identity picks the real one because it is the one Accessibility reports as focused.
    func testIgnoresADecorativeSliverOfTheSameApp() {
        let real = CGRect(x: 0, y: 36, width: 1680, height: 1014)
        let windows = [
            window(browser, "", CGRect(x: 0, y: 0, width: 1680, height: 68)),
            window(browser, "zsh", real)
        ]
        XCTAssertEqual(
            matchCaptureWindowIndex(from: windows, pid: browser, appName: "Browser", identity: WindowIdentity(frame: real, title: "zsh")), 1
        )
    }

    func testTwoIdenticalCandidatesAreAmbiguousSoNeitherIsTaken() {
        let frame = CGRect(x: 10, y: 10, width: 800, height: 600)
        let windows = [window(browser, "Docs", frame), window(browser, "Docs", frame)]
        XCTAssertNil(matchCaptureWindowIndex(from: windows, pid: browser, appName: "Browser", identity: WindowIdentity(frame: frame, title: "Docs")))
    }

    func testAnUnreadableTitleNeverMatches() {
        let frame = CGRect(x: 10, y: 10, width: 800, height: 600)
        XCTAssertNil(
            matchCaptureWindowIndex(
                from: [window(browser, nil, frame)], pid: browser, appName: "Browser", identity: WindowIdentity(frame: frame, title: "Docs")
            )
        )
    }

    func testAnotherProcessWithTheSameFrameAndTitleNeverMatches() {
        let frame = CGRect(x: 10, y: 10, width: 800, height: 600)
        XCTAssertNil(
            matchCaptureWindowIndex(
                from: [window(999, "Docs", frame)], pid: browser, appName: "Browser", identity: WindowIdentity(frame: frame, title: "Docs")
            )
        )
    }

    func testIgnoresAWindowThatIsNotOnScreen() {
        let frame = CGRect(x: 10, y: 10, width: 800, height: 600)
        XCTAssertNil(
            matchCaptureWindowIndex(
                from: [window(browser, "Docs", frame, onScreen: false)], pid: browser, appName: "Browser",
                identity: WindowIdentity(frame: frame, title: "Docs")
            )
        )
    }

    func testFramesWithinAPointStillMatch() {
        let identity = WindowIdentity(frame: CGRect(x: 10, y: 10, width: 800, height: 600), title: "Docs")
        XCTAssertTrue(
            identity.matchesCaptureWindow(frame: CGRect(x: 10.5, y: 9.5, width: 800.8, height: 600), title: "Docs", appNames: [])
        )
        XCTAssertFalse(
            identity.matchesCaptureWindow(frame: CGRect(x: 12, y: 10, width: 800, height: 600), title: "Docs", appNames: [])
        )
    }

    // Measured on Ben's Mac, 2026-09-23: Accessibility and ScreenCaptureKit report the same
    // Chrome window with the same frame, but only Accessibility adds " - Google Chrome".
    func testChromeStyleAppNameSuffixMatches() {
        let frame = CGRect(x: 11, y: 8, width: 1427, height: 1006)
        let identity = WindowIdentity(frame: frame, title: "Voice - (19) Messages - Google Chrome")
        XCTAssertEqual(
            matchCaptureWindowIndex(
                from: [window(browser, "Voice - (19) Messages", frame)], pid: browser, appName: "Google Chrome",
                identity: identity
            ),
            0
        )
    }

    /// An incognito window's Accessibility title ends differently, so it never matches this way.
    func testADifferentSuffixDoesNotMatch() {
        let frame = CGRect(x: 11, y: 8, width: 1427, height: 1006)
        let identity = WindowIdentity(frame: frame, title: "Bank - Google Chrome (Incognito)")
        XCTAssertNil(
            matchCaptureWindowIndex(
                from: [window(browser, "Bank", frame)], pid: browser, appName: "Google Chrome", identity: identity
            )
        )
    }

    func testAnotherAppsNameAsSuffixDoesNotMatch() {
        let frame = CGRect(x: 11, y: 8, width: 1427, height: 1006)
        let identity = WindowIdentity(frame: frame, title: "Docs - Safari")
        XCTAssertNil(
            matchCaptureWindowIndex(
                from: [window(browser, "Docs", frame)], pid: browser, appName: "Google Chrome", identity: identity
            )
        )
    }

    /// Only "<capture title> - <app name>" is accepted, never a title that merely starts the same.
    func testATitleThatOnlySharesAPrefixDoesNotMatch() {
        let frame = CGRect(x: 11, y: 8, width: 1427, height: 1006)
        let identity = WindowIdentity(frame: frame, title: "Voice - (19) Messages and more - Google Chrome")
        XCTAssertNil(
            matchCaptureWindowIndex(
                from: [window(browser, "Voice - (19) Messages", frame)], pid: browser, appName: "Google Chrome",
                identity: identity
            )
        )
    }

    /// The post-capture re-check compares Accessibility with Accessibility, so it stays exact.
    func testAccessibilityRecheckStaysExact() {
        let frame = CGRect(x: 11, y: 8, width: 1427, height: 1006)
        let before = WindowIdentity(frame: frame, title: "Voice - (19) Messages - Google Chrome")
        XCTAssertFalse(before.matches(WindowIdentity(frame: frame, title: "Voice - (19) Messages")))
        XCTAssertTrue(before.matches(WindowIdentity(frame: frame, title: "Voice - (19) Messages - Google Chrome")))
    }

    func testReturnsNilWithNoMatch() {
        XCTAssertNil(
            matchCaptureWindowIndex(
                from: [], pid: browser, appName: "Browser", identity: WindowIdentity(frame: .zero, title: "")
            )
        )
    }
}
