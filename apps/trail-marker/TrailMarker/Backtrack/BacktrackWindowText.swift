import ApplicationServices
import CoreGraphics
import Foundation

// Plan §7, retry 2, task 3: read the window's visible text through Accessibility first, and only
// take a picture for recognition when that gives too little. Never reads a secure text field's
// value, never changes an accessibility setting in another app.

struct WindowTextResult: Equatable {
    /// Visible text, top to bottom, raw: the machine sanitises it like recognised lines.
    let lines: [String]
    /// From content roles (static text, text areas and fields, headings).
    let contentCharacters: Int
    /// From controls (buttons, tabs, menu items, checkboxes, pop-ups).
    let controlCharacters: Int
    /// Hit the element or time budget; what was read so far is kept.
    let truncated: Bool
    let walkMilliseconds: Int
}

protocol WindowTextReading: Sendable {
    /// Nil when the window is no longer `window` or Accessibility can't be read. Runs off the main
    /// actor.
    func visibleText(pid: pid_t, window: WindowIdentity, budget: TimeInterval) async -> WindowTextResult?
}

/// Whether Accessibility text is enough, or recognition must read a picture. The reason is a fixed
/// word for the metrics log, never text from the window.
enum WindowTextVerdict: Equatable {
    case use
    case thin(String)
}

enum WindowTextPolicy {
    static let minCharacters = 100
    static let minContentShare = 0.3
    /// Apps that draw their content, so Accessibility has little of it.
    static let canvasBundles: Set<String> = ["com.figma.Desktop", "com.electron.realtimeboard", "com.canva.CanvaDesktop"]
    static let canvasHosts: Set<String> = [
        "docs.google.com", "figma.com", "www.figma.com", "miro.com", "www.canva.com", "canva.com",
        "excalidraw.com", "tldraw.com", "www.tldraw.com"
    ]
    /// Terminals that expose no screen text through Accessibility. They are read by recognition at
    /// most every `ocrOnlyFloor` seconds.
    static let ocrOnlyBundles: Set<String> = [
        "net.kovidgoyal.kitty", "org.alacritty", "io.alacritty", "com.github.wez.wezterm",
        "dev.warp.Warp-Stable", "co.zeit.hyper"
    ]
    static let ocrOnlyFloor: TimeInterval = 30

    /// Decided before any read: these apps never get an Accessibility walk.
    static func skipsAccessibility(bundleId: String) -> Bool {
        canvasBundles.contains(bundleId) || ocrOnlyBundles.contains(bundleId)
    }

    static func verdict(_ result: WindowTextResult?, address: String?) -> WindowTextVerdict {
        if let host = address.flatMap({ URL(string: $0)?.host?.lowercased() }), canvasHosts.contains(host) {
            return .thin("canvas")
        }
        guard let result, !result.lines.isEmpty else { return .thin("none") }
        let total = result.contentCharacters + result.controlCharacters
        if total < minCharacters { return .thin("short") }
        if Double(result.contentCharacters) < Double(total) * minContentShare { return .thin("controls") }
        return .use
    }
}

/// Apps whose Accessibility tree is slow to read go straight to recognition for a while
/// (Screenpipe's `budget.rs`, simplified). Bounded.
struct AccessibilityCostTracker: Equatable {
    static let maxApps = 32
    static let window = 8
    static let slowMilliseconds = 100.0
    static let truncatedLimit = 3
    static let skipFor: TimeInterval = 600

    private var walks: [String: [(ms: Int, truncated: Bool)]] = [:]
    private var skipUntil: [String: Date] = [:]
    private var order: [String] = []

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.skipUntil == rhs.skipUntil && lhs.order == rhs.order
            && lhs.walks.mapValues { $0.map(\.ms) } == rhs.walks.mapValues { $0.map(\.ms) }
            && lhs.walks.mapValues { $0.map(\.truncated) } == rhs.walks.mapValues { $0.map(\.truncated) }
    }

    func skips(_ bundleId: String, at: Date) -> Bool {
        guard let until = skipUntil[bundleId] else { return false }
        return at < until
    }

    mutating func record(_ bundleId: String, milliseconds: Int, truncated: Bool, at: Date) {
        if let until = skipUntil[bundleId], at >= until {
            skipUntil[bundleId] = nil
            walks[bundleId] = nil
        }
        var recent = walks[bundleId] ?? []
        recent.append((milliseconds, truncated))
        recent = Array(recent.suffix(Self.window))
        walks[bundleId] = recent
        order.removeAll { $0 == bundleId }
        order.append(bundleId)
        if order.count > Self.maxApps {
            let evicted = order.removeFirst()
            walks[evicted] = nil
            skipUntil[evicted] = nil
        }
        let mean = Double(recent.reduce(0) { $0 + $1.ms }) / Double(recent.count)
        if mean > Self.slowMilliseconds || recent.filter(\.truncated).count >= Self.truncatedLimit {
            skipUntil[bundleId] = at.addingTimeInterval(Self.skipFor)
        }
    }

    mutating func reset() {
        walks = [:]
        skipUntil = [:]
        order = []
    }
}

// MARK: - The walk

/// What the walk needs from one element, read without its text.
struct TextNodeInfo<Node> {
    let role: String?
    let subrole: String?
    let frame: CGRect?
    let children: [Node]
}

/// The tree the walk reads. The real one is Accessibility; tests use a fake that records which
/// elements had their text read.
protocol TextTree {
    associatedtype Node
    func info(_ node: Node) -> TextNodeInfo<Node>?
    /// Value, title and description. Never called for a secure text field.
    func text(_ node: Node) -> (value: String?, title: String?, description: String?)
    /// The visible part of a text area, when the app reports a visible range smaller than the whole.
    func visiblePart(_ node: Node) -> String?
    /// Visible static text in a web area, in page order; nil when the page can't answer.
    func visibleStaticText(in webArea: Node, limit: Int) -> [Node]?
}

enum WindowTextWalker {
    static let maxElements = 3000
    static let maxCharacters = 50_000
    /// A text area with no usable visible range keeps only its last lines (terminal scrollback).
    static let maxAreaLines = 80

    static let contentRoles: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXHeading"]
    static let controlRoles: Set<String> = [
        "AXButton", "AXMenuItem", "AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXComboBox", "AXMenuButton"
    ]
    static let skippedRoles: Set<String> = ["AXScrollBar", "AXImage", "AXMenuBar", "AXMenu", "AXToolbar"]
    static let secureSubrole = "AXSecureTextField"

    static func walk<Tree: TextTree>(
        _ tree: Tree, root: Tree.Node, windowFrame: CGRect, budget: TimeInterval, now: () -> Date = Date.init
    ) -> WindowTextResult {
        let start = now()
        let deadline = start.addingTimeInterval(budget)
        var lines: [String] = []
        var content = 0
        var controls = 0
        var visited = 0
        var truncated = false
        // Depth first, children in order, which is reading order for most apps.
        var stack: [Tree.Node] = [root]

        func take(_ text: String?, isContent: Bool) {
            guard let text else { return }
            for line in text.split(whereSeparator: \.isNewline) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { continue }
                lines.append(trimmed)
                if isContent { content += trimmed.count } else { controls += trimmed.count }
            }
        }

        while let node = stack.popLast() {
            guard visited < maxElements, now() < deadline, content + controls < maxCharacters else {
                truncated = true
                break
            }
            visited += 1
            guard let info = tree.info(node) else { continue }
            if info.subrole == secureSubrole { continue }
            if let role = info.role, skippedRoles.contains(role) { continue }
            // Off-window elements and everything under them are not on screen.
            if let frame = info.frame, !frame.intersects(windowFrame) { continue }
            let role = info.role ?? ""

            if role == "AXWebArea", let found = tree.visibleStaticText(in: node, limit: maxElements - visited) {
                for element in found {
                    visited += 1
                    guard let elementInfo = tree.info(element), elementInfo.subrole != secureSubrole else { continue }
                    if let frame = elementInfo.frame, !frame.intersects(windowFrame) { continue }
                    take(tree.text(element).value, isContent: true)
                }
                continue
            }
            if contentRoles.contains(role), info.frame != nil {
                if role == "AXTextArea" {
                    take(tree.visiblePart(node) ?? lastLines(tree.text(node).value), isContent: true)
                    continue
                }
                // A heading with children holds its text in them.
                if role != "AXHeading" || info.children.isEmpty {
                    let text = tree.text(node)
                    take(text.value ?? text.title, isContent: true)
                    continue
                }
            } else if controlRoles.contains(role), info.frame != nil {
                let text = tree.text(node)
                take(text.title ?? text.description, isContent: false)
                continue
            }
            stack.append(contentsOf: info.children.reversed())
        }
        return WindowTextResult(
            lines: lines, contentCharacters: content, controlCharacters: controls, truncated: truncated,
            walkMilliseconds: Int(now().timeIntervalSince(start) * 1000)
        )
    }

    private static func lastLines(_ text: String?) -> String? {
        guard let text else { return nil }
        let all = text.split(whereSeparator: \.isNewline)
        guard all.count > maxAreaLines else { return text }
        return all.suffix(maxAreaLines).joined(separator: "\n")
    }
}

// MARK: - Accessibility

/// The real tree. Reads role, subrole, frame and children in one call per element, and text only
/// for elements that aren't secure fields.
struct AccessibilityTextTree: TextTree {
    /// A timeout belongs to one element object, not its children, so every element is given it
    /// before it is asked anything. A hung app then costs a fraction of a second per call, not ~6 s.
    var messagingTimeout: Float?

    private func bounded(_ node: AXUIElement) -> AXUIElement {
        if let messagingTimeout { AXUIElementSetMessagingTimeout(node, messagingTimeout) }
        return node
    }

    private static let infoAttributes = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute
    ] as CFArray
    private static let textAttributes = [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] as CFArray

    func info(_ node: AXUIElement) -> TextNodeInfo<AXUIElement>? {
        guard let values = Self.copy(bounded(node), Self.infoAttributes), values.count == 5 else { return nil }
        var frame: CGRect?
        var position = CGPoint.zero
        var size = CGSize.zero
        if let positionRef = Self.axValue(values[2]), let sizeRef = Self.axValue(values[3]),
           AXValueGetValue(positionRef, .cgPoint, &position), AXValueGetValue(sizeRef, .cgSize, &size) {
            frame = CGRect(origin: position, size: size)
        }
        return TextNodeInfo(
            role: values[0] as? String, subrole: values[1] as? String, frame: frame,
            children: (values[4] as? [AXUIElement]) ?? []
        )
    }

    func text(_ node: AXUIElement) -> (value: String?, title: String?, description: String?) {
        guard let values = Self.copy(bounded(node), Self.textAttributes), values.count == 3 else { return (nil, nil, nil) }
        return (Self.nonEmpty(values[0]), Self.nonEmpty(values[1]), Self.nonEmpty(values[2]))
    }

    func visiblePart(_ node: AXUIElement) -> String? {
        let node = bounded(node)
        var rangeRef: CFTypeRef?
        var countRef: CFTypeRef?
        var range = CFRange()
        guard AXUIElementCopyAttributeValue(node, kAXVisibleCharacterRangeAttribute as CFString, &rangeRef) == .success,
              AXUIElementCopyAttributeValue(node, kAXNumberOfCharactersAttribute as CFString, &countRef) == .success,
              let rangeValue = Self.axValue(rangeRef), AXValueGetValue(rangeValue, .cfRange, &range),
              let count = countRef as? Int, range.length > 0, range.length < count
        else { return nil }
        var stringRef: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            node, kAXStringForRangeParameterizedAttribute as CFString, rangeValue, &stringRef
        ) == .success else { return nil }
        return stringRef as? String
    }

    func visibleStaticText(in webArea: AXUIElement, limit: Int) -> [AXUIElement]? {
        let predicate: [String: Any] = [
            "AXSearchKey": "AXStaticTextSearchKey",
            "AXResultsLimit": max(1, limit),
            "AXDirection": "AXDirectionNext",
            "AXVisibleOnly": true
        ]
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(
            bounded(webArea), "AXUIElementsForSearchPredicate" as CFString, predicate as CFDictionary, &value
        ) == .success, let array = value as? [AXUIElement]
        else { return nil }
        return array
    }

    private static func copy(_ node: AXUIElement, _ attributes: CFArray) -> [AnyObject]? {
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(node, attributes, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
            == .success, let values
        else { return nil }
        return values as [AnyObject]
    }

    /// Missing attributes come back as an `AXValue` of type `.axError`; those read as nil.
    private static func axValue(_ object: AnyObject?) -> AXValue? {
        guard let object, CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
        let value = object as! AXValue
        return AXValueGetType(value) == .axError ? nil : value
    }

    private static func nonEmpty(_ object: AnyObject) -> String? {
        guard let text = object as? String, !text.isEmpty else { return nil }
        return text
    }
}

struct AXWindowTextReader: WindowTextReading {
    static let messagingTimeout: Float = 0.2

    func visibleText(pid: pid_t, window identity: WindowIdentity, budget: TimeInterval) async -> WindowTextResult? {
        await Task.detached(priority: .utility) {
            guard let window = BacktrackAX.window(pid: pid, matching: identity, messagingTimeout: Self.messagingTimeout)
            else { return nil }
            return WindowTextWalker.walk(
                AccessibilityTextTree(messagingTimeout: Self.messagingTimeout), root: window,
                windowFrame: identity.frame, budget: budget
            )
        }.value
    }
}

/// For harnesses with no Accessibility: every read is thin, so recognition decides as before.
struct NoWindowText: WindowTextReading {
    func visibleText(pid: pid_t, window: WindowIdentity, budget: TimeInterval) async -> WindowTextResult? { nil }
}
