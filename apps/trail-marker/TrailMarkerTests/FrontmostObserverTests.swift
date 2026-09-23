import XCTest
@testable import TrailMarker

@MainActor
final class FrontmostObserverTests: XCTestCase {
    private final class FakeSource: FrontmostSource {
        var current: Observation?
        var canReadWindowTitles = true
    }

    private func browser(_ title: String) -> Observation {
        Observation(appName: "Safari", bundleId: "com.apple.Safari", windowTitle: title)
    }

    func testATabChangeInsideTheSameAppIsReported() {
        let source = FakeSource()
        source.current = browser("Keste music website")
        let observer = FrontmostObserver(source: source)
        var reported: [Observation?] = []
        observer.start { reported.append($0) }
        defer { observer.stop() }

        source.current = browser("Reddit")
        observer.poll()

        XCTAssertEqual(reported, [browser("Reddit")])
    }

    func testAnUnchangedWindowIsNotReportedAgain() {
        let source = FakeSource()
        source.current = browser("Keste music website")
        let observer = FrontmostObserver(source: source)
        var reported: [Observation?] = []
        observer.start { reported.append($0) }
        defer { observer.stop() }

        observer.poll()
        source.current = browser("Reddit")
        observer.poll()
        observer.poll()

        XCTAssertEqual(reported, [browser("Reddit")])
    }

    func testNothingIsReportedOnceStopped() {
        let source = FakeSource()
        source.current = browser("Keste music website")
        let observer = FrontmostObserver(source: source)
        var reported: [Observation?] = []
        observer.start { reported.append($0) }
        observer.stop()

        source.current = browser("Reddit")
        observer.poll()

        XCTAssertTrue(reported.isEmpty)
    }

    func testTrailMarkerItselfInFrontIsNotReported() {
        let source = FakeSource()
        source.current = browser("Keste music website")
        let observer = FrontmostObserver(source: source)
        var reported: [Observation?] = []
        observer.start { reported.append($0) }
        defer { observer.stop() }

        source.current = nil
        observer.poll()

        XCTAssertTrue(reported.isEmpty)
    }

    func testASpinnerInATerminalTitleIsNotANewWindowButNewWordsAre() {
        let source = FakeSource()
        let terminal = { (title: String) in Observation(appName: "Ghostty", bundleId: "com.mitchellh.ghostty", windowTitle: title) }
        source.current = terminal("◐ Focus-judgment database tests")
        let observer = FrontmostObserver(source: source)
        var reported: [Observation?] = []
        observer.start { reported.append($0) }
        defer { observer.stop() }

        source.current = terminal("✳ Focus-judgment database tests")
        observer.poll()
        XCTAssertTrue(reported.isEmpty)

        source.current = terminal("✳ Keste website build")
        observer.poll()
        XCTAssertEqual(reported, [terminal("✳ Keste website build")])
    }
}
