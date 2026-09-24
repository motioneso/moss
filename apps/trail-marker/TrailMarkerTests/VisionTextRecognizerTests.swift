#if DEBUG
import AppKit
import XCTest
@testable import TrailMarker

/// Backtrack plan §4.5: on-device text recognition reads a known fixture well enough to be
/// useful. The fixture is rendered here from known text rather than stored as a binary.
final class VisionTextRecognizerTests: XCTestCase {
    static let fixture = [
        "Quarterly planning notes for the companion",
        "Ship the focus switch before Friday",
        "Measure battery use across a working day"
    ]

    static func render(_ lines: [String], width: Int = 1400, height: Int = 400) -> CGImage {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let graphics = NSGraphicsContext(cgContext: context, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 40), .foregroundColor: NSColor.black
        ]
        for (index, line) in lines.enumerated() {
            (line as NSString).draw(at: NSPoint(x: 40, y: height - 90 - index * 100), withAttributes: attributes)
        }
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()!
    }

    func testRecognisesAtLeastNinetyPercentOfTheFixturesWords() async throws {
        let recognised = try await VisionTextRecognizer().recognize(Self.render(Self.fixture))
        let expected = Self.fixture.joined(separator: " ").lowercased().split(separator: " ").map(String.init)
        let got = Set(recognised.joined(separator: " ").lowercased().split(separator: " ").map(String.init))
        let hits = expected.filter { got.contains($0) }.count
        XCTAssertGreaterThanOrEqual(Double(hits) / Double(expected.count), 0.9, "recognised: \(recognised)")
    }
}
#endif
