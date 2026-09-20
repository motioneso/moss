import XCTest

final class SmokeTests: XCTestCase {
    func testBundleIdentifierIsStable() {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "com.moss.trailmarker")
    }
}
