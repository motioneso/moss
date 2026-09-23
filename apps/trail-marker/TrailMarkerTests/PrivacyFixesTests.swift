import XCTest
@testable import TrailMarker

/// #2643: capture only the window the policy checked, Pause stops every send, and a link that
/// ends leaves nothing of the account behind, stored or running. These drive the real runtimes
/// with a spy transport and fake capture/describer, so they fail if a guard is removed.
@MainActor
final class PrivacyFixesTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!
    private let keychain = KeychainStore(service: "com.moss.trailmarker.tests")

    override func setUp() {
        super.setUp()
        suiteName = "PrivacyFixesTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        keychain.delete(for: Self.identity())
        keychain.delete(for: Self.identity(email: "other@example.com", device: "device-2"))
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    // MARK: - Fakes

    nonisolated static func identity(email: String = "ben@example.com", device: String = "device-1") -> LinkedIdentity {
        guard case .success(let instance) = InstanceURL.parse("https://privacy-tests.example.com") else {
            fatalError("expected a valid instance URL")
        }
        return LinkedIdentity(instance: instance, deviceId: device, accountName: "Test", accountEmail: email)
    }

    /// Records every request and answers the focus endpoints.
    /// Requests arrive on several threads at once, so the record is behind a lock.
    final class SpyTransport: CompanionTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var recorded: [String] = []
        let blockEndsAt = ServerTime.format(Date().addingTimeInterval(3600))

        var paths: [String] { lock.lock(); defer { lock.unlock() }; return recorded }

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let path = request.url?.path ?? ""
            lock.lock(); recorded.append(path); lock.unlock()
            let json: String
            switch path {
            case "/api/companion/focus/context":
                json = #"{"block":{"id":"b1","title":"Study","startsAt":"2026-01-01T00:00:00.000Z","endsAt":"\#(blockEndsAt)"},"judgmentReady":true}"#
            case "/api/companion/focus/judge":
                json = #"{"judgmentId":"j1","label":"insufficient_evidence","reason":"","nudge":false}"#
            default:
                json = "{}"
            }
            let status = path.hasSuffix("/correct") || path.hasSuffix("/logout") ? 204 : 200
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data(json.utf8), response)
        }

        func count(_ suffix: String) -> Int { paths.filter { $0.hasSuffix(suffix) }.count }
    }

    /// Suspends inside capture until the test resumes it, so a stop can be fired mid-capture.
    final class SuspendingCapture: WindowCapturing {
        private(set) var calls = 0
        private var continuation: CheckedContinuation<Void, Never>?
        var suspend = true

        func capture(_ window: WindowIdentity, pid: pid_t, appName: String, maxDimension: CGFloat) async throws -> CGImage {
            calls += 1
            if suspend { await withCheckedContinuation { continuation = $0 } }
            return PrivacyFixesTests.onePixel()
        }

        var isSuspended: Bool { continuation != nil }
        func resume() {
            continuation?.resume()
            continuation = nil
        }
    }

    final class SpyDescriber: VisionDescribing {
        private(set) var calls = 0
        func describe(_ image: Data) async throws -> String {
            calls += 1
            return "a document"
        }
    }

    struct NoNudges: NudgeDelivering {
        func requestAuthorization() {}
        func showNudge(blockTitle: String) {}
        func showTestNudge() {}
    }

    struct AllPermissions: PermissionsOSAdaptor {
        func accessibilityTrusted(prompting: Bool) -> Bool { true }
        func screenRecordingGranted(prompting: Bool) -> Bool { true }
    }

    final class FakeSource: FrontmostSource {
        var current: Observation?
        var canReadWindowTitles = true
    }

    nonisolated static func onePixel() -> CGImage {
        let context = CGContext(
            data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return context.makeImage()!
    }

    static let docsWindow = WindowIdentity(frame: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Docs")
    static let docs = Observation(
        appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs", pid: 42, window: docsWindow
    )

    private struct Harness {
        let preferences: PreferencesStore
        let transport: SpyTransport
        let connection: ConnectionRuntime
        let focus: FocusRuntime
        let capture: SuspendingCapture
        let describer: SpyDescriber
        let source: FakeSource
    }

    private func harness(consent: Bool = true, rung3: Bool = false) -> Harness {
        let preferences = PreferencesStore(defaults: defaults)
        preferences.focusConsent = consent
        preferences.focusWatchEntireDesktop = true
        preferences.focusRung3Enabled = rung3
        let transport = SpyTransport()
        let connection = ConnectionRuntime(keychain: keychain, preferences: preferences, transportFactory: { _ in transport })
        let permissions = PermissionsService(adaptor: AllPermissions())
        permissions.refresh()
        let source = FakeSource()
        source.current = Self.docs
        let capture = SuspendingCapture()
        let describer = SpyDescriber()
        let focus = FocusRuntime(
            connection: connection, permissions: permissions, nudges: NoNudges(), preferences: preferences,
            keychain: keychain, observer: FrontmostObserver(source: source),
            transportFactory: { _ in transport }, windowCapture: capture,
            freshWindowIdentity: { [weak source] _ in source?.current?.window },
            visionDescriberFactory: { _, _, _, _ in describer }
        )
        focus.start()
        return Harness(
            preferences: preferences, transport: transport, connection: connection, focus: focus,
            capture: capture, describer: describer, source: source
        )
    }

    private func link(_ h: Harness, _ identity: LinkedIdentity = PrivacyFixesTests.identity()) {
        h.connection.send(.linkCompleted(identity, credential: "tm1_test", generation: h.connection.currentGeneration))
    }

    private func settle(_ nanoseconds: UInt64 = 100_000_000) async {
        try? await Task.sleep(nanoseconds: nanoseconds)
    }

    private func remembered() -> RememberedJudgment {
        RememberedJudgment(
            judgment: FocusJudgment(judgmentId: "j1", label: .focused, reason: "", nudge: false),
            at: Date(), blockTitle: "Study", appName: "Safari", windowTitle: "Docs", screenDescription: nil
        )
    }

    // MARK: - §3.1 capture fails closed; app-name judgment unchanged

    func testWithoutAnIdentifiedWindowNothingIsCapturedButAppNameJudgmentStillRuns() {
        let policy = ObservationPolicy(allowedBundleIds: [], watchEntireDesktop: true)
        let unidentified = Observation(appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs")
        XCTAssertTrue(policy.allows(unidentified), "judging by app name must not need a window")
        XCTAssertFalse(policy.allowsCapture(unidentified))
        XCTAssertFalse(policy.allowsTestCapture(unidentified))
        XCTAssertTrue(policy.allowsCapture(Self.docs))
    }

    func testTestVisionWithoutAnIdentifiedWindowTakesNoPicture() async {
        let h = harness()
        h.source.current = Observation(appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs")
        h.capture.suspend = false
        h.focus.testVision()
        await settle()
        XCTAssertEqual(h.capture.calls, 0)
    }

    // MARK: - §3.2 Pause stops every send

    func testWhilePausedTestVisionCorrectAndRenameSendNothing() async {
        let h = harness()
        link(h)
        await settle()
        h.focus.seedLastJudgmentForTesting(remembered())
        h.connection.send(.userDisconnect)
        await settle()
        let before = h.transport.paths.count

        h.focus.testVision()
        h.focus.correct(.right)
        h.connection.rename(displayName: "New name")
        await settle()

        XCTAssertEqual(h.transport.paths.count, before, "sent while paused: \(h.transport.paths.suffix(3))")
        XCTAssertEqual(h.capture.calls, 0)
        XCTAssertEqual(h.describer.calls, 0)
        XCTAssertEqual(h.focus.visionTestResult, .failure(.paused))
    }

    /// Control for the test above: the same three actions do send when not paused, so a spy that
    /// records nothing can't make it pass.
    func testWhenNotPausedCorrectAndRenameDoSend() async {
        let h = harness()
        link(h)
        await settle()
        h.focus.seedLastJudgmentForTesting(remembered())
        h.focus.correct(.right)
        h.connection.rename(displayName: "New name")
        await settle()
        XCTAssertEqual(h.transport.count("/focus/correct"), 1)
        XCTAssertEqual(h.transport.count("/device"), 1)
    }

    func testRenameIsNotGatedOnFocus() async {
        let h = harness(consent: false)
        link(h)
        await settle()
        h.connection.rename(displayName: "New name")
        await settle()
        XCTAssertEqual(h.transport.count("/device"), 1)
    }

    func testPauseDuringTestVisionCaptureNeverReachesTheVisionSource() async {
        let h = harness()
        link(h)
        await settle()
        h.focus.testVision()
        await settle()
        XCTAssertTrue(h.capture.isSuspended)

        h.connection.send(.userDisconnect)
        h.capture.resume()
        await settle()

        XCTAssertEqual(h.describer.calls, 0)
        XCTAssertNil(h.focus.visionTestCapture)
    }

    /// The automatic path: judged insufficient, a capture starts, Pause fires while it is
    /// suspended. No description and no second judge request (#2643). Waits out the 5 s dwell.
    func testPauseDuringAutomaticCaptureSendsNoDescriptionAndNoSecondJudgment() async {
        let h = harness(rung3: true)
        link(h)
        for _ in 0..<80 where !h.capture.isSuspended {
            await settle()
        }
        XCTAssertTrue(h.capture.isSuspended, "never reached the capture; requests: \(h.transport.paths)")
        XCTAssertEqual(h.transport.count("/focus/judge"), 1)

        h.connection.send(.userDisconnect)
        h.capture.resume()
        await settle(300_000_000)

        XCTAssertEqual(h.describer.calls, 0)
        XCTAssertEqual(h.transport.count("/focus/judge"), 1, "a second judgment left while paused")
    }

    // MARK: - §3.3 a link that ends leaves nothing behind

    private func assertAccountDataCleared(_ file: StaticString = #filePath, line: UInt = #line) {
        for key in [
            "focusConsent", "focusAllowedBundleIds", "focusExcludedBundleIds", "focusWatchEntireDesktop",
            "focusRung3Enabled", "focusVisionSource", "focusVisionBaseURL", "focusVisionModel", "displayName"
        ] {
            XCTAssertNil(defaults.object(forKey: key), "\(key) survived", file: file, line: line)
        }
    }

    func testLogOutWhileConnectedClearsSettingsAndCredential() async {
        let h = harness()
        link(h)
        h.preferences.focusExcludedBundleIds = ["com.example.Finance"]
        h.preferences.displayName = "Mac"
        h.connection.send(.userLogout)
        await settle()
        assertAccountDataCleared()
        XCTAssertNil(defaults.object(forKey: "linkedIdentity"))
        XCTAssertNil(keychain.read(for: Self.identity()))
    }

    func testLogOutWhilePausedIsAcceptedAndClears() async {
        let h = harness()
        link(h)
        h.connection.send(.userDisconnect)
        h.preferences.focusExcludedBundleIds = ["com.example.Finance"]
        h.connection.send(.userLogout)
        await settle()
        XCTAssertEqual(h.connection.state, .notLinked)
        assertAccountDataCleared()
        XCTAssertNil(keychain.read(for: Self.identity()))
    }

    func testRevokedByMossClearsTheAccountButKeepsTheInstanceForSignIn() async {
        let h = harness()
        link(h)
        await settle()
        h.connection.send(.heartbeatFailed(.credentialInvalid, generation: h.connection.currentGeneration))
        await settle()
        assertAccountDataCleared()
        XCTAssertNil(keychain.read(for: Self.identity()))
        XCTAssertNotNil(defaults.object(forKey: "linkedIdentity"))
        XCTAssertEqual(h.focus.consent, false)
    }

    /// Log out, then link as a different account in the same run: the running Focus must not
    /// carry the first account's consent, lists or last judgment into the second (#2643).
    func testRelinkingAsAnotherAccountWithoutRestartingStartsFromNothing() async {
        let h = harness()
        link(h)
        await settle()
        h.focus.setAllowed("com.apple.Safari", allowed: true)
        h.focus.seedLastJudgmentForTesting(remembered())
        XCTAssertTrue(h.focus.consent)

        h.connection.send(.userLogout)
        await settle()
        let before = h.transport.paths.count
        link(h, Self.identity(email: "other@example.com", device: "device-2"))
        await settle()

        XCTAssertFalse(h.focus.consent)
        XCTAssertEqual(h.focus.allowedBundleIds, [])
        XCTAssertNil(h.focus.lastJudgment)
        XCTAssertEqual(h.focus.state, .off)
        XCTAssertEqual(
            h.transport.paths.dropFirst(before).filter { $0.contains("/focus/") }, [],
            "the new account was watched before opting in"
        )
    }
}
