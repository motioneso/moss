#if DEBUG
import XCTest
@testable import TrailMarker

/// Plan §7, retry 2, task 3: the Accessibility text walk, the thin-text policy and the slow-app
/// tracker, against a fake tree that records whose text was read.
final class BacktrackWindowTextTests: XCTestCase {
    final class Node {
        let role: String
        var subrole: String?
        var frame: CGRect?
        var children: [Node]
        var value: String?
        var title: String?
        var visiblePart: String?
        var visibleStaticText: [Node]?

        init(_ role: String, subrole: String? = nil, frame: CGRect? = CGRect(x: 10, y: 10, width: 100, height: 20),
             value: String? = nil, title: String? = nil, children: [Node] = []) {
            self.role = role
            self.subrole = subrole
            self.frame = frame
            self.value = value
            self.title = title
            self.children = children
        }
    }

    final class FakeTree: TextTree {
        private(set) var textReads: [ObjectIdentifier] = []
        func info(_ node: Node) -> TextNodeInfo<Node>? {
            TextNodeInfo(role: node.role, subrole: node.subrole, frame: node.frame, children: node.children)
        }
        func text(_ node: Node) -> (value: String?, title: String?, description: String?) {
            textReads.append(ObjectIdentifier(node))
            return (node.value, node.title, nil)
        }
        func visiblePart(_ node: Node) -> String? { node.visiblePart }
        func visibleStaticText(in webArea: Node, limit: Int) -> [Node]? { webArea.visibleStaticText }
        func read(_ node: Node) -> Bool { textReads.contains(ObjectIdentifier(node)) }
    }

    static let windowFrame = CGRect(x: 0, y: 0, width: 800, height: 600)

    private func walk(_ tree: FakeTree, _ root: Node, budget: TimeInterval = 1, now: @escaping () -> Date = Date.init) -> WindowTextResult {
        WindowTextWalker.walk(tree, root: root, windowFrame: Self.windowFrame, budget: budget, now: now)
    }

    // MARK: - The walk

    func testASecureFieldsValueIsNeverRead() {
        let password = Node("AXTextField", subrole: "AXSecureTextField", value: "hunter2")
        let label = Node("AXStaticText", value: "Password")
        let root = Node("AXWindow", children: [Node("AXGroup", children: [label, password])])
        let tree = FakeTree()
        let result = walk(tree, root)
        XCTAssertEqual(result.lines, ["Password"])
        XCTAssertFalse(result.lines.joined().contains("hunter2"))
        XCTAssertFalse(tree.read(password), "the secure field's text attributes were requested")
    }

    func testASecureFieldFoundByAWebSearchIsNeverRead() {
        let password = Node("AXTextField", subrole: "AXSecureTextField", value: "hunter2")
        let web = Node("AXWebArea")
        web.visibleStaticText = [Node("AXStaticText", value: "Sign in"), password]
        let tree = FakeTree()
        XCTAssertEqual(walk(tree, Node("AXWindow", children: [web])).lines, ["Sign in"])
        XCTAssertFalse(tree.read(password))
    }

    func testOffWindowElementsAndTheirChildrenAreSkipped() {
        let offscreen = Node("AXGroup", frame: CGRect(x: 0, y: 2000, width: 800, height: 600), children: [
            Node("AXStaticText", frame: nil, value: "Scrolled far away")
        ])
        let root = Node("AXWindow", children: [Node("AXStaticText", value: "On screen"), offscreen])
        XCTAssertEqual(walk(FakeTree(), root).lines, ["On screen"])
    }

    func testAWebAreaUsesTheVisibleSearchInsteadOfWalking() {
        let hidden = Node("AXStaticText", value: "Below the fold")
        let web = Node("AXWebArea", children: [hidden])
        web.visibleStaticText = [Node("AXStaticText", value: "Headline"), Node("AXStaticText", value: "First paragraph")]
        let tree = FakeTree()
        XCTAssertEqual(walk(tree, Node("AXWindow", children: [web])).lines, ["Headline", "First paragraph"])
        XCTAssertFalse(tree.read(hidden))
    }

    func testAWebAreaThatCantSearchIsWalked() {
        let web = Node("AXWebArea", children: [Node("AXStaticText", value: "Walked text")])
        XCTAssertEqual(walk(FakeTree(), Node("AXWindow", children: [web])).lines, ["Walked text"])
    }

    func testATextAreaKeepsItsVisiblePartOrElseItsLastLines() {
        let document = Node("AXTextArea", value: "whole document")
        document.visiblePart = "the visible part"
        XCTAssertEqual(walk(FakeTree(), Node("AXWindow", children: [document])).lines, ["the visible part"])

        let scrollback = (1...200).map { "line \($0)" }.joined(separator: "\n")
        let terminal = Node("AXTextArea", value: scrollback)
        let lines = walk(FakeTree(), Node("AXWindow", children: [terminal])).lines
        XCTAssertEqual(lines.count, WindowTextWalker.maxAreaLines)
        XCTAssertEqual(lines.last, "line 200")
    }

    func testContentAndControlsAreCountedSeparatelyAndSkippedRolesIgnored() {
        let root = Node("AXWindow", children: [
            Node("AXStaticText", value: "12345"),
            Node("AXButton", title: "abc"),
            Node("AXToolbar", children: [Node("AXStaticText", value: "toolbar text")]),
            Node("AXImage", title: "picture")
        ])
        let result = walk(FakeTree(), root)
        XCTAssertEqual(result.lines, ["12345", "abc"])
        XCTAssertEqual(result.contentCharacters, 5)
        XCTAssertEqual(result.controlCharacters, 3)
    }

    func testAHeadingWithChildrenIsReadOnce() {
        let heading = Node("AXHeading", title: "Title", children: [Node("AXStaticText", value: "Title")])
        XCTAssertEqual(walk(FakeTree(), Node("AXWindow", children: [heading])).lines, ["Title"])
    }

    func testTheTimeBudgetTruncatesAndKeepsWhatWasRead() {
        var clock = Date(timeIntervalSince1970: 0)
        let root = Node("AXWindow", children: (0..<10).map { Node("AXStaticText", value: "item \($0)") })
        let result = walk(FakeTree(), root, budget: 0.05) {
            defer { clock = clock.addingTimeInterval(0.01) }
            return clock
        }
        XCTAssertTrue(result.truncated)
        XCTAssertFalse(result.lines.isEmpty)
        XCTAssertLessThan(result.lines.count, 10)
    }

    // MARK: - Policy

    private func result(content: Int, controls: Int) -> WindowTextResult {
        WindowTextResult(lines: ["x"], contentCharacters: content, controlCharacters: controls, truncated: false, walkMilliseconds: 5)
    }

    func testThinTextGoesToRecognition() {
        XCTAssertEqual(WindowTextPolicy.verdict(nil, address: nil), .thin("none"))
        XCTAssertEqual(WindowTextPolicy.verdict(result(content: 99, controls: 0), address: nil), .thin("short"))
        XCTAssertEqual(WindowTextPolicy.verdict(result(content: 25, controls: 75), address: nil), .thin("controls"))
        XCTAssertEqual(WindowTextPolicy.verdict(result(content: 500, controls: 0), address: "https://docs.google.com/document/d/1"), .thin("canvas"))
        XCTAssertEqual(WindowTextPolicy.verdict(result(content: 100, controls: 0), address: "https://example.com/"), .use)
        XCTAssertEqual(WindowTextPolicy.verdict(result(content: 30, controls: 70), address: nil), .use)
    }

    func testCanvasAppsAndTextlessTerminalsNeverGetAWalk() {
        XCTAssertTrue(WindowTextPolicy.skipsAccessibility(bundleId: "net.kovidgoyal.kitty"))
        XCTAssertTrue(WindowTextPolicy.skipsAccessibility(bundleId: "com.figma.Desktop"))
        XCTAssertFalse(WindowTextPolicy.skipsAccessibility(bundleId: "com.mitchellh.ghostty"))
        XCTAssertFalse(WindowTextPolicy.skipsAccessibility(bundleId: "com.apple.Safari"))
    }

    // MARK: - Slow apps

    func testASlowAppGoesToRecognitionForTenMinutesThenIsTriedAgain() {
        var tracker = AccessibilityCostTracker()
        let t0 = Date(timeIntervalSince1970: 0)
        tracker.record("slow", milliseconds: 120, truncated: false, at: t0)
        XCTAssertTrue(tracker.skips("slow", at: t0.addingTimeInterval(599)))
        XCTAssertFalse(tracker.skips("slow", at: t0.addingTimeInterval(600)))
        XCTAssertFalse(tracker.skips("other", at: t0))
        tracker.record("slow", milliseconds: 10, truncated: false, at: t0.addingTimeInterval(600))
        XCTAssertFalse(tracker.skips("slow", at: t0.addingTimeInterval(601)), "its old walks were forgotten")
    }

    func testThreeTruncatedWalksOfEightMakeAnAppSlow() {
        var tracker = AccessibilityCostTracker()
        let t0 = Date(timeIntervalSince1970: 0)
        tracker.record("app", milliseconds: 20, truncated: true, at: t0)
        tracker.record("app", milliseconds: 20, truncated: true, at: t0)
        XCTAssertFalse(tracker.skips("app", at: t0))
        tracker.record("app", milliseconds: 20, truncated: true, at: t0)
        XCTAssertTrue(tracker.skips("app", at: t0))
    }

    func testTheTrackerIsBounded() {
        var tracker = AccessibilityCostTracker()
        let t0 = Date(timeIntervalSince1970: 0)
        tracker.record("first", milliseconds: 500, truncated: false, at: t0)
        for index in 0..<AccessibilityCostTracker.maxApps {
            tracker.record("app-\(index)", milliseconds: 5, truncated: false, at: t0)
        }
        XCTAssertFalse(tracker.skips("first", at: t0), "the 33rd app evicts the oldest")
    }
}
#endif
