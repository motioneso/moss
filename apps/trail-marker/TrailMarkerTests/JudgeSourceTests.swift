import XCTest
import SwiftUI
@testable import TrailMarker

@MainActor
final class JudgeSourceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""
    private var keychain: KeychainStore!

    override func setUp() {
        suite = "JudgeSourceTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        keychain = KeychainStore(service: suite)
    }

    override func tearDown() {
        keychain.delete(for: PrivacyFixesTests.identity())
        defaults.removePersistentDomain(forName: suite)
    }

    final class Transport: CompanionTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [[String: Any]] = []
        var takesImages = true
        var name: String? = "clef-flash (Cloudflare)"
        var hasBlock = true
        var failImage = false
        var returnEmptyId = false
        var judgments: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return recorded }

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let path = request.url!.path
            var json: [String: Any] = [:]
            var status = 200
            if path.hasSuffix("/context") {
                json = ["judgmentReady": true, "judgeTakesImages": takesImages,
                        "judgeName": name as Any? ?? NSNull(), "block": NSNull()]
                if hasBlock {
                    json["block"] = ["id": "b1", "title": "Study", "startsAt": ServerTime.format(Date()),
                                     "endsAt": ServerTime.format(Date().addingTimeInterval(3600))]
                }
            } else if path.hasSuffix("/judge") {
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
                lock.lock(); recorded.append(body); lock.unlock()
                let isImage = body["image"] != nil
                status = failImage && isImage ? 503 : 200
                json = ["judgmentId": body["test"] as? Bool == true || returnEmptyId ? "" : "j1",
                        "label": isImage ? "distracted" : "insufficient_evidence",
                        "reason": isImage ? "Distracted, 89% sure; looks like shopping" : "", "nudge": false]
            }
            return (try JSONSerialization.data(withJSONObject: json),
                    HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }

    private struct Harness {
        let focus: FocusRuntime
        let connection: ConnectionRuntime
        let capture: PrivacyFixesTests.SuspendingCapture
        let describer: PrivacyFixesTests.SpyDescriber
        let source: PrivacyFixesTests.FakeSource
        let transport: Transport
    }

    private func harness(available: Bool = true, name: String? = "clef-flash (Cloudflare)", block: Bool = true) async -> Harness {
        let prefs = PreferencesStore(defaults: defaults)
        prefs.focusConsent = true
        prefs.focusWatchEntireDesktop = true
        prefs.focusRung3Enabled = true
        prefs.focusVisionSource = .judge
        let transport = Transport()
        transport.takesImages = available
        transport.name = name
        transport.hasBlock = block
        let connection = ConnectionRuntime(keychain: keychain, preferences: prefs, transportFactory: { _ in transport })
        let permissions = PermissionsService(adaptor: PrivacyFixesTests.AllPermissions())
        permissions.refresh()
        let source = PrivacyFixesTests.FakeSource()
        source.current = PrivacyFixesTests.docs
        let capture = PrivacyFixesTests.SuspendingCapture()
        capture.suspend = false
        let describer = PrivacyFixesTests.SpyDescriber()
        let focus = FocusRuntime(
            connection: connection, permissions: permissions, nudges: PrivacyFixesTests.NoNudges(),
            preferences: prefs, keychain: keychain, observer: FrontmostObserver(source: source),
            transportFactory: { _ in transport }, windowCapture: capture,
            freshWindowIdentity: { [weak source] _ in source?.current?.window },
            visionDescriberFactory: { _, _, _, _ in describer }
        )
        focus.start()
        connection.send(.linkCompleted(PrivacyFixesTests.identity(), credential: "tm1_test", generation: connection.currentGeneration))
        await settle()
        return Harness(focus: focus, connection: connection, capture: capture, describer: describer, source: source, transport: transport)
    }

    private func settle() async { try? await Task.sleep(nanoseconds: 200_000_000) }

    func testOldContextIsUnavailableAndOldRequestOmitsImageAndTest() throws {
        let context = try JSONDecoder().decode(FocusContext.self, from: Data(#"{"block":null,"judgmentReady":true}"#.utf8))
        XCTAssertFalse(context.judgeTakesImages)
        XCTAssertNil(context.judgeName)
        let request = FocusJudgeRequest(blockId: "b", appName: "Safari", windowTitle: "Docs", observedAt: "now")
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
        XCTAssertEqual(Set(body.keys), ["blockId", "appName", "windowTitle", "observedAt"])
    }

    func testDirectAutomaticCaptureSkipsDescriberAndRemembersNoPicture() async {
        let h = await harness()
        XCTAssertTrue(h.focus.judgeAvailable)
        XCTAssertEqual(h.transport.judgments.count, 2)
        XCTAssertNil(h.transport.judgments[0]["image"])
        XCTAssertTrue((h.transport.judgments[1]["image"] as? String)?.hasPrefix("data:image/jpeg;base64,") == true)
        XCTAssertNil(h.transport.judgments[1]["description"])
        XCTAssertEqual(h.capture.calls, 1)
        XCTAssertEqual(h.describer.calls, 0)
        XCTAssertNil(h.focus.visionTestCapture)
        XCTAssertNil(h.focus.lastJudgment?.screenDescription)
        XCTAssertEqual(h.focus.lastJudgment?.judgment.label, .distracted)
        XCTAssertFalse(String(describing: defaults.dictionaryRepresentation()).contains("data:image"))
        h.connection.send(.userDisconnect)
    }

    func testTestResultHasThumbnailAndNeverReplacesRememberedJudgment() async {
        let h = await harness()
        let previous = h.focus.lastJudgment
        h.focus.testVision()
        await settle()
        XCTAssertEqual(h.transport.judgments.last?["test"] as? Bool, true)
        XCTAssertEqual(h.focus.visionTestResult, .success("Distracted, 89% sure; looks like shopping"))
        XCTAssertNotNil(h.focus.visionTestCapture)
        XCTAssertEqual(h.focus.lastJudgment, previous)
        XCTAssertEqual(h.describer.calls, 0)
        h.focus.clearVisionTest()
        XCTAssertNil(h.focus.visionTestCapture)
        XCTAssertNil(h.focus.visionTestResult)
        h.focus.testVision()
        await settle()
        XCTAssertNotNil(h.focus.visionTestCapture)
        h.connection.send(.userDisconnect)
        await settle()
        XCTAssertNil(h.focus.visionTestCapture)
        XCTAssertFalse(h.focus.judgeAvailable)
    }

    func testClosingRetainedSettingsWindowClearsTestPreview() async {
        let h = await harness()
        let settings = SettingsWindow(
            connection: h.connection, permissions: PermissionsService(), focus: h.focus,
            updater: UpdaterService(), loginItem: LoginItemService(), onSetUp: {}
        )
        let window = NSWindow(contentViewController: NSHostingController(rootView: settings))
        window.identifier = SettingsWindow.windowIdentifier
        window.isReleasedWhenClosed = false
        window.orderFront(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        await settle()
        h.focus.testVision()
        await settle()
        XCTAssertNotNil(h.focus.visionTestCapture)
        XCTAssertNotNil(h.focus.visionTestResult)
        window.close()
        await settle()
        XCTAssertNil(h.focus.visionTestCapture)
        XCTAssertNil(h.focus.visionTestResult)
        h.connection.send(.userDisconnect)
    }

    func testJudgeChangeAndUnknownNameNeverSelectAnotherSourceOrCapture() async {
        let h = await harness(available: false)
        XCTAssertFalse(h.focus.judgeAvailable)
        XCTAssertEqual(h.focus.visionSource, .judge)
        XCTAssertEqual(h.capture.calls, 0)
        h.focus.testVision()
        await settle()
        XCTAssertEqual(h.focus.visionTestResult, .failure(.judgeUnavailable))
        XCTAssertEqual(h.capture.calls, 0)
        XCTAssertTrue(h.focus.rung3ConsentSentence.contains("Choose another way"))
        h.transport.takesImages = true
        h.transport.name = nil
        h.focus.testVision()
        await settle()
        XCTAssertFalse(h.focus.judgeAvailable)
        XCTAssertEqual(h.capture.calls, 0)
        h.connection.send(.userDisconnect)
    }

    func testConsentNamesTheJudgeAndNoBlockTestDoesNotCapture() async {
        let h = await harness(block: false)
        XCTAssertTrue(h.focus.rung3ConsentSentence.contains("clef-flash (Cloudflare) through your Moss server to judge"))
        h.focus.testVision()
        await settle()
        XCTAssertEqual(h.focus.visionTestResult, .failure(.noBlock))
        XCTAssertEqual(h.capture.calls, 0)
        h.connection.send(.userDisconnect)
    }

    func testEmptyAutomaticIdCannotReachRememberedJudgment() async {
        let h = await harness(block: false)
        h.transport.returnEmptyId = true
        h.transport.hasBlock = true
        h.focus.send(.contextLoaded(FocusContext(
            block: FocusBlock(id: "b1", title: "Study", startsAt: ServerTime.format(Date()), endsAt: ServerTime.format(Date().addingTimeInterval(3600))),
            judgmentReady: true, judgeTakesImages: true, judgeName: "clef-flash (Cloudflare)"
        ), generation: h.focus.generationForTesting))
        await settle()
        XCTAssertNil(h.focus.lastJudgment)
        h.connection.send(.userDisconnect)
    }

    func testPauseDuringTestCaptureDropsPreviewAndImageRequest() async {
        let h = await harness()
        h.capture.suspend = true
        let before = h.transport.judgments.count
        h.focus.testVision()
        await settle()
        XCTAssertTrue(h.capture.isSuspended)
        h.connection.send(.userDisconnect)
        await settle()
        h.capture.resume()
        await settle()
        XCTAssertEqual(h.transport.judgments.count, before)
        XCTAssertNil(h.focus.visionTestCapture)
    }

    func testFailureKeepsOnlyPreviewUntilLogout() async {
        let h = await harness()
        h.transport.failImage = true
        h.focus.testVision()
        await settle()
        XCTAssertEqual(h.focus.visionTestResult, .failure(.unreachable))
        XCTAssertNotNil(h.focus.visionTestCapture)
        h.focus.resetForEndedLink()
        XCTAssertNil(h.focus.visionTestCapture)
    }
    func testSourceChangeDuringAutomaticCaptureSendsNoImage() async {
        let h = await harness(block: false)
        h.capture.suspend = true
        h.focus.send(.contextLoaded(FocusContext(
            block: FocusBlock(id: "b1", title: "Study", startsAt: ServerTime.format(Date()), endsAt: ServerTime.format(Date().addingTimeInterval(3600))),
            judgmentReady: true, judgeTakesImages: true, judgeName: "clef-flash (Cloudflare)"
        ), generation: h.focus.generationForTesting))
        await settle()
        XCTAssertTrue(h.capture.isSuspended)
        h.focus.setVisionSource(.cli)
        h.capture.resume()
        await settle()
        XCTAssertEqual(h.transport.judgments.count, 1)
        XCTAssertNil(h.transport.judgments[0]["image"])
        XCTAssertEqual(h.describer.calls, 0)
        h.connection.send(.userDisconnect)
    }

    func testFailedAutomaticImageKeepsFirstInsufficientJudgment() async {
        let h = await harness(block: false)
        h.transport.failImage = true
        h.focus.send(.contextLoaded(FocusContext(
            block: FocusBlock(id: "b1", title: "Study", startsAt: ServerTime.format(Date()), endsAt: ServerTime.format(Date().addingTimeInterval(3600))),
            judgmentReady: true, judgeTakesImages: true, judgeName: "clef-flash (Cloudflare)"
        ), generation: h.focus.generationForTesting))
        await settle()
        XCTAssertEqual(h.transport.judgments.count, 2)
        XCTAssertEqual(h.focus.lastJudgment?.judgment.label, .insufficientEvidence)
        XCTAssertNil(h.focus.visionTestCapture)
        XCTAssertEqual(h.describer.calls, 0)
        h.connection.send(.userDisconnect)
    }

    func testStaleContextCannotPublishJudgeCapability() async {
        let h = await harness(available: false)
        h.focus.send(.contextLoaded(FocusContext(
            block: nil, judgmentReady: true, judgeTakesImages: true, judgeName: "Stale judge"
        ), generation: h.focus.generationForTesting - 1))
        XCTAssertFalse(h.focus.judgeAvailable)
        XCTAssertNotEqual(h.focus.judgeName, "Stale judge")
        h.connection.send(.userDisconnect)
    }

}
