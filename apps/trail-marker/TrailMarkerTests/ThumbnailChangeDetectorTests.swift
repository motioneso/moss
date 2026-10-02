#if DEBUG
import XCTest
@testable import TrailMarker

final class ThumbnailChangeDetectorTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private let key = DedupeKey(bundleId: "test", frame: .zero)

    private func image(_ pattern: Int, brightness: CGFloat = 1) -> CGImage {
        let context = CGContext(data: nil, width: 90, height: 80, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        context.setFillColor(CGColor(gray: brightness, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 90, height: 80))
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        for row in 0..<8 {
            for column in 0..<9 where (pattern & (1 << column)) != 0 {
                context.fill(CGRect(x: column * 10, y: row * 10, width: 10, height: 10))
            }
        }
        return context.makeImage()!
    }

    func testChecksDoNotRememberFailedOrUnreadScreens() {
        let detector = ThumbnailChangeDetector()
        let screen = image(0b010101010)
        XCTAssertTrue(detector.changed(key, thumbnail: screen, at: t0))
        XCTAssertTrue(detector.changed(key, thumbnail: screen, at: t0.addingTimeInterval(10)))
        detector.recognized(key, thumbnail: screen, at: t0)
        XCTAssertFalse(detector.changed(key, thumbnail: screen, at: t0.addingTimeInterval(10)))
    }

    func testRecentScreensAreRememberedAcrossSwitchesAndChecksDoNotExtendTheRefreshDeadline() {
        let detector = ThumbnailChangeDetector()
        let a = image(0b010101010), b = image(0b101010101)
        detector.recognized(key, thumbnail: a, at: t0)
        XCTAssertTrue(detector.changed(key, thumbnail: b, at: t0.addingTimeInterval(10)))
        detector.recognized(key, thumbnail: b, at: t0.addingTimeInterval(10))
        XCTAssertFalse(detector.changed(key, thumbnail: a, at: t0.addingTimeInterval(20)))
        XCTAssertFalse(detector.changed(key, thumbnail: a, at: t0.addingTimeInterval(299)))
        XCTAssertTrue(detector.changed(key, thumbnail: a, at: t0.addingTimeInterval(300)))
        XCTAssertTrue(detector.changed(key, thumbnail: a, at: t0.addingTimeInterval(-1)))
    }

    func testSmallBrightnessChangesAreIgnoredButDifferentPagesAreRead() {
        let detector = ThumbnailChangeDetector()
        detector.recognized(key, thumbnail: image(0), at: t0)
        XCTAssertFalse(detector.changed(key, thumbnail: image(0, brightness: 0.98), at: t0))
        XCTAssertTrue(detector.changed(key, thumbnail: image(0, brightness: 0.5), at: t0))
        XCTAssertTrue(detector.changed(key, thumbnail: image(0b010101010), at: t0))
    }

    func testScreenAndWindowHistoriesAreBoundedAndResetForgetsThem() {
        let detector = ThumbnailChangeDetector()
        let first = image(1)
        detector.recognized(key, thumbnail: first, at: t0)
        for index in 2...9 { detector.recognized(key, thumbnail: image(index), at: t0) }
        XCTAssertTrue(detector.changed(key, thumbnail: first, at: t0), "the ninth screen evicts the oldest")
        let screen = image(0b010101010)
        detector.recognized(key, thumbnail: screen, at: t0)
        for index in 0..<ThumbnailChangeDetector.maxWindows {
            detector.recognized(DedupeKey(bundleId: "window-\(index)", frame: .zero), thumbnail: screen, at: t0)
        }
        XCTAssertTrue(detector.changed(key, thumbnail: screen, at: t0))
        detector.recognized(key, thumbnail: screen, at: t0)
        detector.reset()
        XCTAssertTrue(detector.changed(key, thumbnail: screen, at: t0))
    }
}
#endif
