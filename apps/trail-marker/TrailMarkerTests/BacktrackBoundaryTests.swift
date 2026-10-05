#if DEBUG
import XCTest
@testable import TrailMarker

/// Backtrack plan §4.5 "One way out, and only clean data goes through it" (Ben, 2026-09-23): the
/// real `BacktrackRuntime`, assembled with fake capture, recognition and timing, and a spy sink.
/// Whatever reaches the sink must be sanitised and policy-allowed, and nothing reaches it while
/// recording is stopped. Plus the secure-field masking checked on the recogniser's actual pixels.
@MainActor
final class BacktrackBoundaryTests: XCTestCase {
    // MARK: - Fakes

    final class ManualScheduler: BacktrackScheduling {
        final class Handle: BacktrackTimer {
            var action: (@MainActor () -> Void)?
            func cancel() { action = nil }
        }
        private(set) var pending: [Handle] = []

        func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> BacktrackTimer {
            let handle = Handle()
            handle.action = action
            pending.append(handle)
            return handle
        }

        /// Fires every live timer once (the machine keeps only one live at a time).
        func fire() {
            let due = pending
            pending = []
            for handle in due { handle.action?() }
        }
    }

    final class FakeCapture: WindowCapturing {
        private(set) var calls: [CGFloat] = []
        var fails = false
        func capture(_ window: WindowIdentity, pid: pid_t, maxDimension: CGFloat) async throws -> CGImage {
            calls.append(maxDimension)
            if fails { throw ScreenCaptureError.captureFailed }
            return BacktrackBoundaryTests.whiteImage(width: 400, height: 300)
        }
        var fullCaptures: Int { calls.filter { $0 > 100 }.count }
    }

    final class FakeSecureFields: SecureFieldLocating {
        var answers: [[CGRect]?] = []
        var fallback: [CGRect]? = []
        private(set) var calls = 0
        func secureFieldFrames(pid: pid_t, window: WindowIdentity, budget: TimeInterval) -> [CGRect]? {
            calls += 1
            return answers.isEmpty ? fallback : answers.removeFirst()
        }
    }

    /// Plan §7, retry 2, task 3: answers with fixed text, records whether it ran on the main thread,
    /// and can run something on the main actor mid-read (a window change).
    final class FakeWindowText: WindowTextReading, @unchecked Sendable {
        var result: WindowTextResult?
        var during: (@MainActor () -> Void)?
        private(set) var ranOnMain: [Bool] = []
        init(_ result: WindowTextResult?) { self.result = result }
        func visibleText(pid: pid_t, window: WindowIdentity, budget: TimeInterval) async -> WindowTextResult? {
            ranOnMain.append(Thread.isMainThread)
            if let during { await MainActor.run { during() } }
            return result
        }
    }

    static func windowText(_ lines: [String]) -> WindowTextResult {
        WindowTextResult(
            lines: lines, contentCharacters: lines.joined().count, controlCharacters: 0, truncated: false, walkMilliseconds: 3
        )
    }

    struct FakeAddress: BrowserAddressReading {
        var value: String?
        func address(pid: pid_t, window: WindowIdentity, bundleId: String) -> String? { value }
    }

    final class SpyRecognizer: TextRecognizing {
        private(set) var images: [CGImage] = []
        var lines = ["The quarterly plan", "Ship the companion", "Measure the battery"]
        var suspend = false
        private var continuation: CheckedContinuation<Void, Never>?

        func recognize(_ image: CGImage) async throws -> [String] {
            images.append(image)
            if suspend { await withCheckedContinuation { continuation = $0 } }
            return lines
        }

        var isSuspended: Bool { continuation != nil }
        func resume() {
            continuation?.resume()
            continuation = nil
        }
    }

    final class SpySink: BacktrackSink {
        var requiredConsentVersion = 1
        private(set) var accepted: [BacktrackSegment] = []
        private(set) var discards = 0
        func accept(_ segment: BacktrackSegment) { accepted.append(segment) }
        func discardAll() { discards += 1 }
    }

    /// Answers the heartbeat like a healthy Moss, so the link stays up for the whole test.
    final class HealthyTransport: CompanionTransport, @unchecked Sendable {
        /// The heartbeat's `backtrack` field, as JSON; nil answers like a Moss without Backtrack.
        var heartbeatBacktrack: String?
        init(heartbeatBacktrack: String? = nil) { self.heartbeatBacktrack = heartbeatBacktrack }

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let path = request.url?.path ?? ""
            let json: String
            switch path {
            case "/api/companion/heartbeat":
                let backtrack = heartbeatBacktrack.map { #","backtrack":"# + $0 } ?? ""
                json = #"{"device":{"id":"device-1","displayName":"Test Mac"},"account":{"name":"Test","email":"ben@example.com"},"serverTime":"2026-01-01T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z""# + backtrack + "}"
            case "/api/companion/backtrack":
                json = BacktrackUploaderTests.okJSON(accepted: 1)
            case "/api/companion/focus/context":
                json = #"{"block":null,"judgmentReady":true}"#
            default:
                json = "{}"
            }
            let status = path.hasSuffix("/logout") ? 204 : 200
            return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }

    nonisolated static func whiteImage(width: Int, height: Int) -> CGImage {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()!
    }

    /// The red channel at (x, y), top-left origin.
    static func red(_ image: CGImage, x: Int, y: Int) -> UInt8 {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let context = CGContext(
            data: &pixels, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return pixels[(y * image.width + x) * 4]
    }

    // MARK: - Harness

    static let window = WindowIdentity(frame: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Docs")
    static let docs = Observation(appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs", pid: 42, window: window)

    /// One preferences suite per harness: a loop that builds several must not carry one
    /// iteration's stop (a switch left off) into the next.
    private var suiteNames: [String] = []
    private let keychain = KeychainStore(service: "com.moss.trailmarker.tests")

    private struct Harness {
        let runtime: BacktrackRuntime
        let connection: ConnectionRuntime
        let focus: FocusRuntime
        let preferences: PreferencesStore
        let source: PrivacyFixesTests.FakeSource
        let scheduler: ManualScheduler
        let capture: FakeCapture
        let secure: FakeSecureFields
        let recognizer: SpyRecognizer
        let sink: SpySink
        let activity: Activity
        let uploader: BacktrackUploader?
    }

    final class Activity {
        var idleSeconds: TimeInterval = 0
        var now = Date(timeIntervalSince1970: 1_000_000)
    }

    override func tearDown() {
        keychain.delete(for: PrivacyFixesTests.identity())
        for name in suiteNames { UserDefaults().removePersistentDomain(forName: name) }
        suiteNames = []
        super.tearDown()
    }

    private func harness(
        observation: Observation = BacktrackBoundaryTests.docs, consentVersion: Int = 1, address: String? = nil,
        windowText: WindowTextReading = NoWindowText(), heartbeatBacktrack: String? = nil,
        uploaderKeys: BacktrackBufferKeyStoring? = nil, uploaderFile: URL? = nil
    ) async -> Harness {
        let suiteName = "BacktrackBoundaryTests.\(UUID().uuidString)"
        suiteNames.append(suiteName)
        let preferences = PreferencesStore(defaults: UserDefaults(suiteName: suiteName)!)
        preferences.backtrackEnabled = true
        preferences.backtrackConsentVersion = consentVersion
        let transport = HealthyTransport(heartbeatBacktrack: heartbeatBacktrack)
        let connection = ConnectionRuntime(keychain: keychain, preferences: preferences, transportFactory: { _ in transport })
        let permissions = PermissionsService(adaptor: PrivacyFixesTests.AllPermissions())
        permissions.refresh()
        let focus = FocusRuntime(
            connection: connection, permissions: permissions, nudges: PrivacyFixesTests.NoNudges(),
            preferences: preferences, keychain: keychain, observer: FrontmostObserver(source: PrivacyFixesTests.FakeSource()),
            transportFactory: { _ in transport }, freshWindowIdentity: { _ in nil }
        )
        let source = PrivacyFixesTests.FakeSource()
        source.current = observation
        let scheduler = ManualScheduler()
        let capture = FakeCapture()
        let secure = FakeSecureFields()
        let recognizer = SpyRecognizer()
        let sink = SpySink()
        let activity = Activity()
        let services = BacktrackServices(
            capture: capture, secureFields: secure, addresses: FakeAddress(value: address), recognizer: recognizer,
            thumbnails: ThumbnailChangeDetector(), freshWindowIdentity: { [weak source] _ in source?.current?.window },
            clock: { activity.now }, scheduler: scheduler, idleSeconds: { activity.idleSeconds }, windowText: windowText
        )
        var uploader: BacktrackUploader?
        if let uploaderKeys, let uploaderFile {
            uploader = BacktrackUploader(
                environment: connection, keys: uploaderKeys, fileURL: uploaderFile, clock: { activity.now },
                scheduler: ManualScheduler()
            )
        }
        let runtime = BacktrackRuntime(
            connection: connection, permissions: permissions, focus: focus, preferences: preferences,
            observer: FrontmostObserver(source: source), sink: uploader ?? sink, services: services
        )
        uploader?.sendingAllowed = { [weak runtime] in runtime?.allowsSending ?? false }
        connection.send(.linkCompleted(PrivacyFixesTests.identity(), credential: "tm1_test", generation: connection.currentGeneration))
        // The first heartbeat comes a minute after linking; hand the connection Moss's answer now.
        connection.noteBacktrackState(heartbeatBacktrack.flatMap { try? JSONDecoder().decode(BacktrackState.self, from: Data($0.utf8)) })
        await settle()
        runtime.start()
        return Harness(
            runtime: runtime, connection: connection, focus: focus, preferences: preferences, source: source,
            scheduler: scheduler, capture: capture, secure: secure, recognizer: recognizer, sink: sink, activity: activity,
            uploader: uploader
        )
    }

    private func settle(_ nanoseconds: UInt64 = 60_000_000) async {
        try? await Task.sleep(nanoseconds: nanoseconds)
    }

    /// Fires the pending timer and lets the capture and recognition tasks run.
    private func runChain(_ h: Harness) async {
        h.activity.now = h.activity.now.addingTimeInterval(10)
        h.scheduler.fire()
        await settle()
        await settle()
    }

    func testUnchangedScreenIsSkippedAfterASwitchAndRefreshedAfterFiveMinutes() async {
        let h = await harness()
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 1)
        h.source.current = Self.docs.refreshed(window: WindowIdentity(frame: Self.window.frame, title: "Another tab"))
        // Deliver the change through the real observer's poll interval.
        await settle(2_100_000_000)
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 1, "a switch still checks the already recognized image")
        h.activity.now = h.activity.now.addingTimeInterval(60)
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 1, "a minute is no longer enough to re-read a known screen")
        h.activity.now = h.activity.now.addingTimeInterval(ThumbnailChangeDetector.refreshInterval)
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 2, "similarity cannot hide changed text indefinitely")
    }

    func testAccessibilityTextReachesTheSinkSanitisedWithoutAPicture() async {
        let text = FakeWindowText(Self.windowText([
            "The quarterly plan for the companion app", "Ship the focus switch before Friday",
            "Measure battery use across a working day", "token sk-live-0123456789abcdef"
        ]))
        let h = await harness(windowText: text)
        await runChain(h)
        XCTAssertEqual(h.sink.accepted.count, 1)
        XCTAssertEqual(h.sink.accepted.first?.lines.last, "token [redacted]")
        XCTAssertEqual(h.capture.fullCaptures, 0, "no picture was taken")
        XCTAssertTrue(h.recognizer.images.isEmpty)
        XCTAssertEqual(text.ranOnMain, [false], "the walk runs off the main actor")
    }

    func testAWindowChangeDuringTheTextReadEmitsNothing() async {
        let text = FakeWindowText(Self.windowText([
            "The quarterly plan for the companion app", "Ship the focus switch before Friday",
            "Measure battery use across a working day"
        ]))
        let h = await harness(windowText: text)
        text.during = { [weak source = h.source] in
            source?.current = BacktrackBoundaryTests.docs.refreshed(
                window: WindowIdentity(frame: CGRect(x: 50, y: 50, width: 800, height: 600), title: "Docs")
            )
        }
        await runChain(h)
        XCTAssertTrue(h.sink.accepted.isEmpty)
        XCTAssertTrue(h.recognizer.images.isEmpty)
    }

    func testThinAccessibilityTextFallsBackToRecognition() async {
        let h = await harness(windowText: FakeWindowText(Self.windowText(["Back", "Forward"])))
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 1)
        XCTAssertEqual(h.sink.accepted.count, 1)
    }

    func testIdleStopsCaptureAndInputResumesWithoutDiscardingText() async {
        let h = await harness()
        await runChain(h)
        let count = h.capture.calls.count
        let discards = h.sink.discards
        h.activity.idleSeconds = BacktrackRuntime.idleThreshold
        h.runtime.inputsMayHaveChanged()
        XCTAssertFalse(h.runtime.isRecording)
        await runChain(h)
        XCTAssertEqual(h.capture.calls.count, count)
        XCTAssertEqual(h.sink.discards, discards)
        h.activity.idleSeconds = 0
        h.runtime.inputsMayHaveChanged()
        XCTAssertTrue(h.runtime.isRecording)
        await runChain(h)
        XCTAssertGreaterThan(h.capture.calls.count, count)
    }

    func testIdleDuringRecognitionDropsLateTextAndDoesNotCacheTheUnreadScreen() async {
        let h = await harness()
        h.recognizer.suspend = true
        await runChain(h)
        XCTAssertTrue(h.recognizer.isSuspended)
        h.activity.idleSeconds = BacktrackRuntime.idleThreshold
        h.runtime.inputsMayHaveChanged()
        h.recognizer.resume()
        await settle()
        XCTAssertEqual(h.sink.accepted, [])
        h.activity.idleSeconds = 0
        h.recognizer.suspend = false
        h.runtime.inputsMayHaveChanged()
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 2)
        XCTAssertEqual(h.sink.accepted.count, 1)
    }

    // MARK: - What reaches the sink is clean

    func testASegmentReachesTheSinkWithEveryFieldSanitised() async {
        let secretWindow = WindowIdentity(frame: Self.window.frame, title: "Keys sk-proj-abcdefghijklmnop")
        let h = await harness(
            observation: Observation(
                appName: "Safari", bundleId: "com.apple.Safari", windowTitle: secretWindow.title, pid: 42, window: secretWindow
            ),
            address: "https://ben:hunter2@example.com/reset/aZ9kQ2mN8pL4tX7vB1cD3eF5gH6?token=abc#x"
        )
        h.recognizer.lines = ["Card 4111 1111 1111 1111", "Your code is 482913", "API_KEY=supersecretvalue"]
        XCTAssertTrue(h.runtime.isRecording)
        await runChain(h)

        XCTAssertEqual(h.sink.accepted.count, 1)
        let segment = h.sink.accepted.first
        XCTAssertEqual(segment?.windowTitle, "Keys [redacted]")
        XCTAssertEqual(segment?.address, "https://example.com/reset/…")
        XCTAssertEqual(segment?.lines, ["Card [card]", "Your code is [code]", "[redacted]"])
        let everything = ([segment?.windowTitle, segment?.address, segment?.appName] + (segment?.lines ?? [])).compactMap { $0 }
        for secret in ["sk-proj", "4111", "482913", "supersecret", "hunter2", "token=abc", "aZ9kQ2"] {
            XCTAssertFalse(everything.contains { $0.contains(secret) }, "\(secret) crossed the boundary")
        }
    }

    // MARK: - Nothing reaches it for what is never watched

    func testNothingIsReadFromAPasswordManagerAPrivateWindowOrAnExcludedApp() async {
        let windows = [
            Observation(appName: "1Password", bundleId: "com.1password.1password", windowTitle: "Vault", pid: 42, window: Self.window),
            Observation(
                appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Bank — Private Browsing", pid: 42,
                window: WindowIdentity(frame: Self.window.frame, title: "Bank — Private Browsing")
            )
        ]
        for observation in windows {
            let h = await harness(observation: observation)
            await runChain(h)
            XCTAssertEqual(h.capture.calls, [], observation.appName)
            XCTAssertEqual(h.sink.accepted, [], observation.appName)
        }

        let h = await harness(observation: Observation(
            appName: "Finance", bundleId: "com.example.Finance", windowTitle: "Accounts", pid: 42, window: Self.window
        ))
        h.focus.setExcluded("com.example.Finance", excluded: true)
        await settle()
        await runChain(h)
        XCTAssertEqual(h.capture.calls, [])
        XCTAssertEqual(h.sink.accepted, [])
    }

    func testAWindowWhoseSecureFieldsCantBeLocatedIsNeverRead() async {
        let h = await harness()
        h.secure.fallback = nil
        await runChain(h)
        XCTAssertEqual(h.secure.calls, 2, "tried twice, then skipped")
        XCTAssertEqual(h.capture.fullCaptures, 0)
        XCTAssertEqual(h.recognizer.images.count, 0)
        XCTAssertEqual(h.sink.accepted, [])
    }

    func testAWindowWhoseSecureFieldsAreFoundOnTheSecondTryIsRead() async {
        // Safari, measured live: the first search after a switch runs over while the page builds
        // its accessibility tree; the next one fits.
        let h = await harness()
        h.secure.answers = [nil]
        await runChain(h)
        XCTAssertEqual(h.secure.calls, 3, "one timed-out try, one completed, one after the picture")
        XCTAssertEqual(h.recognizer.images.count, 1)
        XCTAssertEqual(h.sink.accepted.count, 1)
    }

    func testFailedCaptureDoesNotSuppressTheSameScreenOnRetry() async {
        let h = await harness()
        h.secure.fallback = nil
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 0)
        h.secure.fallback = []
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 1, "an unread screen must not enter the recent-screen cache")
        XCTAssertEqual(h.sink.accepted.count, 1)
    }

    func testASecureFieldThatMovesDuringTheCaptureSkipsIt() async {
        let h = await harness()
        h.secure.answers = [[CGRect(x: 100, y: 100, width: 200, height: 40)], [CGRect(x: 100, y: 160, width: 200, height: 40)]]
        await runChain(h)
        XCTAssertEqual(h.recognizer.images.count, 0)
        XCTAssertEqual(h.sink.accepted, [])
    }

    // MARK: - Masking, checked on the pixels the recogniser receives

    func testEverySecureFieldIsPaintedBlackBeforeRecognition() async {
        let h = await harness()
        // Screen points in an 800×600 window captured at 400×300; one focused, one not.
        let fields = [CGRect(x: 100, y: 100, width: 200, height: 100), CGRect(x: 500, y: 400, width: 100, height: 60)]
        h.secure.fallback = fields
        await runChain(h)
        let image = try? XCTUnwrap(h.recognizer.images.first)
        guard let image else { return XCTFail("nothing was recognised") }
        XCTAssertEqual(Self.red(image, x: 100, y: 75), 0, "first field is black")
        XCTAssertEqual(Self.red(image, x: 275, y: 215), 0, "second field is black")
        XCTAssertEqual(Self.red(image, x: 10, y: 10), 255, "the rest of the window is untouched")
    }

    // MARK: - Nothing reaches it while stopped

    func testNothingReachesTheSinkWhileAnyStopHolds() async {
        let stops: [(String, (Harness) -> Void)] = [
            ("menu switch off", { $0.runtime.setMenuSwitch(on: false) }),
            ("Pause All", { $0.connection.send(.userDisconnect) }),
            ("screen locked", { $0.runtime.noteScreenLocked(true) }),
            ("asleep", { $0.runtime.noteSleeping(true) }),
            ("Backtrack off", { $0.runtime.setEnabled(false) })
        ]
        for (name, stop) in stops {
            let h = await harness()
            stop(h)
            await settle()
            XCTAssertFalse(h.runtime.isRecording, name)
            await runChain(h)
            XCTAssertEqual(h.capture.calls, [], name)
            XCTAssertEqual(h.sink.accepted, [], name)
        }
    }

    func testConsentBelowTheSinksRequirementSendsNothing() async {
        let h = await harness(consentVersion: 1)
        h.sink.requiredConsentVersion = 2
        h.runtime.inputsMayHaveChanged()
        await settle()
        XCTAssertFalse(h.runtime.isRecording)
        await runChain(h)
        XCTAssertEqual(h.capture.calls, [])
        XCTAssertEqual(h.sink.accepted, [])
    }

    func testAfterLogOutNothingReachesTheSinkAndItIsEmptied() async {
        let h = await harness()
        h.connection.send(.userLogout)
        await settle()
        XCTAssertGreaterThan(h.sink.discards, 0)
        XCTAssertFalse(h.runtime.isRecording)
        XCTAssertFalse(h.preferences.backtrackEnabled, "log out forgets the choice")
        await runChain(h)
        XCTAssertEqual(h.sink.accepted, [])
    }

    func testASegmentInFlightWhenAStopFiresNeverReachesTheSink() async {
        let stops: [(String, (Harness) -> Void)] = [
            ("Pause All", { $0.connection.send(.userDisconnect) }),
            ("menu switch off", { $0.runtime.setMenuSwitch(on: false) }),
            ("screen locked", { $0.runtime.noteScreenLocked(true) })
        ]
        for (name, stop) in stops {
            let h = await harness()
            h.recognizer.suspend = true
            await runChain(h)
            XCTAssertTrue(h.recognizer.isSuspended, "\(name): recognition is in flight")
            stop(h)
            await settle()
            h.recognizer.resume()
            await settle()
            XCTAssertEqual(h.sink.accepted, [], name)
        }
    }
    // MARK: - Phase 2b: the uploader as the sink

    private static let storageOn = #"{"storage":"on","paused":false}"#

    private func uploaderFile() -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("BacktrackBoundary-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("buffer.bin")
    }

    func testAConsentFromTheDebugPreviewNeverLetsTheUploaderTakeText() async {
        let keys = BacktrackUploaderTests.MemoryKeys()
        let h = await harness(
            consentVersion: 1, heartbeatBacktrack: Self.storageOn, uploaderKeys: keys, uploaderFile: uploaderFile()
        )
        let uploader = h.uploader!
        XCTAssertEqual(uploader.availability, .ready, "Moss said it stores Backtrack")
        XCTAssertTrue(h.runtime.needsConsent)
        XCTAssertFalse(h.runtime.isRecording)
        await runChain(h)
        XCTAssertEqual(h.capture.calls, [])
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        XCTAssertFalse(h.runtime.allowsSending)
        XCTAssertNil(keys.key, "no buffer was ever started")
    }

    func testWithConsentTwoTextReachesTheBufferAndEveryStopHoldsSending() async {
        let stops: [(String, (Harness) -> Void)] = [
            ("menu switch off", { $0.runtime.setMenuSwitch(on: false) }),
            ("Pause All", { $0.connection.send(.userDisconnect) }),
            ("screen locked", { $0.runtime.noteScreenLocked(true) }),
            ("asleep", { $0.runtime.noteSleeping(true) })
        ]
        for (name, stop) in stops {
            let h = await harness(
                consentVersion: 2, heartbeatBacktrack: Self.storageOn,
                uploaderKeys: BacktrackUploaderTests.MemoryKeys(), uploaderFile: uploaderFile()
            )
            await runChain(h)
            XCTAssertEqual(h.uploader?.bufferedEntries.count, 1, name)
            XCTAssertTrue(h.runtime.allowsSending, name)
            stop(h)
            await settle()
            XCTAssertFalse(h.runtime.allowsSending, name)
            await h.uploader?.sendNow()
            XCTAssertEqual(h.uploader?.bufferedEntries.count, 1, "\(name): nothing left")
        }
    }

    func testWhileMossDoesNotStoreBacktrackNothingIsRead() async {
        for backtrack in [nil, #"{"storage":"off","paused":false}"#, #"{"storage":"on","paused":true}"#] {
            let h = await harness(
                consentVersion: 2, heartbeatBacktrack: backtrack,
                uploaderKeys: BacktrackUploaderTests.MemoryKeys(), uploaderFile: uploaderFile()
            )
            XCTAssertFalse(h.runtime.isRecording, backtrack ?? "no answer")
            await runChain(h)
            XCTAssertEqual(h.capture.calls, [], backtrack ?? "no answer")
            XCTAssertTrue(h.uploader?.bufferedEntries.isEmpty ?? false)
        }
    }

    func testAfterLogOutTheBufferFileAndKeyAreGoneAndNothingIsSent() async {
        let keys = BacktrackUploaderTests.MemoryKeys()
        let file = uploaderFile()
        let h = await harness(consentVersion: 2, heartbeatBacktrack: Self.storageOn, uploaderKeys: keys, uploaderFile: file)
        await runChain(h)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNotNil(keys.key)
        h.connection.send(.userLogout)
        await settle()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNil(keys.key)
        XCTAssertNil(h.connection.backtrackState, "what Moss said goes with the account")
        await h.uploader?.sendNow()
        XCTAssertTrue(h.uploader?.bufferedEntries.isEmpty ?? false)
    }
}
#endif
