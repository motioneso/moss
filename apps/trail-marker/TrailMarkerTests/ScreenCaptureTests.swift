import XCTest
@testable import TrailMarker

/// `selectCaptureWindowIndex` is the fix for a real bug confirmed live against Ghostty: it
/// registers an untitled 68pt-tall decorative sliver window alongside its real 1680x1014 content
/// window, and picking the first on-screen match for the bundle id grabbed the sliver — captured,
/// downscaled, and described as "a narrow strip... the rest of the screen is completely blank".
final class ScreenCaptureTests: XCTestCase {
    func testPicksTheLargestOnScreenWindowOverASmallerDecorativeOne() {
        // The exact shapes seen live: an untitled sliver first in the list, the real window second.
        let windows = [
            CapturableWindow(bundleId: "com.mitchellh.ghostty", isOnScreen: true, frame: CGRect(x: 0, y: 0, width: 1680, height: 68)),
            CapturableWindow(bundleId: "com.mitchellh.ghostty", isOnScreen: true, frame: CGRect(x: 0, y: 36, width: 1680, height: 1014))
        ]

        let index = selectCaptureWindowIndex(from: windows, bundleId: "com.mitchellh.ghostty")

        XCTAssertEqual(index, 1)
    }

    func testIgnoresWindowsFromOtherApps() {
        let windows = [
            CapturableWindow(bundleId: "com.other.app", isOnScreen: true, frame: CGRect(x: 0, y: 0, width: 2000, height: 2000)),
            CapturableWindow(bundleId: "com.mitchellh.ghostty", isOnScreen: true, frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        ]

        XCTAssertEqual(selectCaptureWindowIndex(from: windows, bundleId: "com.mitchellh.ghostty"), 1)
    }

    func testIgnoresAWindowThatIsNotOnScreen() {
        let windows = [
            CapturableWindow(bundleId: "com.mitchellh.ghostty", isOnScreen: false, frame: CGRect(x: 0, y: 0, width: 2000, height: 2000)),
            CapturableWindow(bundleId: "com.mitchellh.ghostty", isOnScreen: true, frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        ]

        XCTAssertEqual(selectCaptureWindowIndex(from: windows, bundleId: "com.mitchellh.ghostty"), 1)
    }

    func testReturnsNilWithNoMatch() {
        XCTAssertNil(selectCaptureWindowIndex(from: [], bundleId: "com.mitchellh.ghostty"))
    }
}
