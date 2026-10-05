import XCTest
@testable import TrailMarker

/// Backtrack phase 2b (plan 2026-10-03-backtrack-phase2.md §5.2): the uploader and its encrypted
/// buffer, against a fake transport and an in-memory key. Nothing here touches the network, the
/// person's Keychain or their real buffer file.
@MainActor
final class BacktrackUploaderTests: XCTestCase {
    // MARK: - Fakes

    final class MemoryKeys: BacktrackBufferKeyStoring {
        var key: Data?
        func storeBacktrackBufferKey(_ key: Data) throws { self.key = key }
        func readBacktrackBufferKey() -> Data? { key }
        @discardableResult func deleteBacktrackBufferKey() -> Bool {
            key = nil
            return true
        }
    }

    /// Records every request body; answers with whatever `answer` returns for it.
    final class ScriptedTransport: CompanionTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _bodies: [Data] = []
        var answer: (BacktrackUploadRequest) throws -> (Int, String) = { request in
            (200, BacktrackUploaderTests.okJSON(accepted: request.segments.count))
        }

        var bodies: [Data] { lock.withLock { _bodies } }
        var requests: [BacktrackUploadRequest] {
            bodies.compactMap { try? JSONDecoder().decode(BacktrackUploadRequest.self, from: $0) }
        }

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let body = request.httpBody ?? Data()
            lock.withLock { _bodies.append(body) }
            let decoded = try JSONDecoder().decode(BacktrackUploadRequest.self, from: body)
            let (status, json) = try answer(decoded)
            return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }

    @MainActor
    final class FakeEnvironment: BacktrackUploadEnvironment {
        var backtrackState: BacktrackState?
        var linked = true
        let transport: ScriptedTransport
        init(state: BacktrackState?, transport: ScriptedTransport) {
            backtrackState = state
            self.transport = transport
        }
        func noteBacktrackState(_ state: BacktrackState?) { backtrackState = state }
        func requestClient() -> (CompanionClient, String)? {
            guard linked else { return nil }
            return (CompanionClient(instance: PrivacyFixesTests.identity().instance, transport: transport), "tm1_test")
        }
    }

    struct NoScheduler: BacktrackScheduling {
        final class Handle: BacktrackTimer { func cancel() {} }
        func schedule(after delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> BacktrackTimer { Handle() }
    }

    static let on = BacktrackState(storage: .on, paused: false)

    nonisolated static func okJSON(accepted: Int, rejectedClock: Int = 0, paused: Bool = false) -> String {
        #"{"accepted":\#(accepted),"duplicates":0,"discarded":0,"rejectedClock":\#(rejectedClock),"state":{"storage":"on","paused":\#(paused)}}"#
    }

    nonisolated static func errorJSON(_ code: String) -> String { #"{"error":"x","code":"\#(code)"}"# }

    // MARK: - Harness

    private var directory: URL!
    private var now = Date(timeIntervalSince1970: 2_000_000_000)
    private var keys = MemoryKeys()
    private var transport = ScriptedTransport()
    private var environment: FakeEnvironment!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("BacktrackUploaderTests-\(UUID().uuidString)")
        keys = MemoryKeys()
        transport = ScriptedTransport()
        environment = FakeEnvironment(state: Self.on, transport: transport)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private var fileURL: URL { directory.appendingPathComponent("buffer.bin") }

    private func uploader(maxBytes: Int = BacktrackBuffer.defaultMaxBytes, sending: Bool = true) -> BacktrackUploader {
        let uploader = BacktrackUploader(
            environment: environment, keys: keys, fileURL: fileURL, clock: { [unowned self] in self.now },
            scheduler: NoScheduler(), bufferMaxBytes: maxBytes
        )
        uploader.sendingAllowed = { sending }
        return uploader
    }

    private func segment(_ text: String, at offset: TimeInterval = 0, bodyBytes: Int? = nil) -> BacktrackSegment {
        let start = now.addingTimeInterval(offset - 30)
        let lines = bodyBytes.map { [text + String(repeating: "x", count: max(0, $0 - text.utf8.count))] } ?? [text]
        return BacktrackSegment(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs", address: "https://example.com/docs",
            lines: lines, start: start, end: start.addingTimeInterval(20)
        )
    }

    private func bodies(_ requests: [BacktrackUploadRequest]) -> [String] {
        requests.flatMap { $0.segments.map(\.body) }
    }

    // MARK: - Nothing without Moss storing it

    func testNothingIsKeptOrSentUntilMossSaysItStoresBacktrack() async {
        for state in [nil, BacktrackState(storage: .off, paused: false)] {
            environment.backtrackState = state
            let uploader = uploader()
            XCTAssertEqual(uploader.availability, .unavailable)
            uploader.accept(segment("Quarterly plan"))
            await uploader.sendNow()
            XCTAssertTrue(uploader.bufferedEntries.isEmpty)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        }
        XCTAssertTrue(transport.bodies.isEmpty)
    }

    func testNothingIsSentWhileSendingIsNotAllowed() async {
        let uploader = uploader(sending: false)
        uploader.accept(segment("Quarterly plan"))
        await uploader.sendNow()
        XCTAssertTrue(transport.bodies.isEmpty, "Pause All, the switch, lock or sleep: no request leaves")
        XCTAssertEqual(uploader.bufferedEntries.count, 1, "and the text waits")
    }

    // MARK: - Sending

    func testSegmentsGoOldestFirstAndLeaveTheBufferOnSuccess() async throws {
        let uploader = uploader()
        uploader.accept(segment("first", at: 0))
        uploader.accept(segment("second", at: 1))
        uploader.accept(segment("third", at: 2))
        await uploader.sendNow()
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(bodies(transport.requests), ["first", "second", "third"])
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        XCTAssertEqual(uploader.lastSentAt, now)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))

        // The body carries no owner or device: those come from the credential.
        let json = try XCTUnwrap(String(data: try XCTUnwrap(transport.bodies.first), encoding: .utf8))
        XCTAssertFalse(json.contains("device"))
        XCTAssertFalse(json.contains("owner"))
    }

    func testSentAtIsTheMacsClockOnEveryAttemptNeverReused() async {
        var fails = true
        transport.answer = { request in
            if fails { throw URLError(.notConnectedToInternet) }
            return (200, Self.okJSON(accepted: request.segments.count))
        }
        let uploader = uploader()
        uploader.accept(segment("Quarterly plan"))
        await uploader.sendNow()
        fails = false
        now = now.addingTimeInterval(60)
        await uploader.sendNow()
        let sent = transport.requests.map(\.sentAt)
        XCTAssertEqual(sent.count, 2)
        XCTAssertNotEqual(sent[0], sent[1])
        XCTAssertEqual(sent[1], ServerTime.format(now))
    }

    func testOfflineKeepsSegmentsAndSendsThemInOrderOnceMossAnswers() async {
        var offline = true
        transport.answer = { request in
            if offline { throw URLError(.notConnectedToInternet) }
            return (200, Self.okJSON(accepted: request.segments.count))
        }
        let uploader = uploader()
        for index in 0..<5 {
            uploader.accept(segment("line \(index)", at: TimeInterval(index)))
            await uploader.sendNow()
        }
        XCTAssertEqual(uploader.bufferedEntries.count, 5, "none lost while offline")
        offline = false
        await uploader.sendNow()
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        XCTAssertEqual(bodies(transport.requests.suffix(1)), (0..<5).map { "line \($0)" })
    }

    func testABacklogGoesOutInSeveralRequestsEachUnderTheByteBudget() async {
        let uploader = uploader()
        for index in 0..<1000 {
            uploader.accept(segment("segment \(index) ", at: TimeInterval(index) / 100, bodyBytes: BacktrackUploader.bodyBytes))
        }
        XCTAssertEqual(uploader.bufferedEntries.count, 1000)
        for _ in 0..<5 where !uploader.bufferedEntries.isEmpty { await uploader.sendNow() }
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        XCTAssertGreaterThan(transport.bodies.count, 5)
        for body in transport.bodies {
            XCTAssertLessThanOrEqual(body.count, BacktrackUploader.maxRequestBytes)
        }
        XCTAssertLessThanOrEqual(transport.requests.map(\.segments.count).max() ?? 0, BacktrackUploader.maxSegmentsPerRequest)
        let sent = bodies(transport.requests).map { String($0.split(separator: " ")[1]) }
        XCTAssertEqual(sent, (0..<1000).map(String.init), "each once, in order")
    }

    func testATooLargeAnswerHalvesTheBatchAndASegmentMossNeverTakesIsDropped() async {
        transport.answer = { request in
            if request.segments.count > 2 { return (413, Self.errorJSON("too_large")) }
            if request.segments.contains(where: { $0.body == "poison" }) { return (400, #"{"error":"bad"}"#) }
            return (200, Self.okJSON(accepted: request.segments.count))
        }
        let uploader = uploader()
        for (index, text) in ["a", "b", "poison", "c", "d"].enumerated() {
            uploader.accept(segment(text, at: TimeInterval(index)))
        }
        for _ in 0..<3 where !uploader.bufferedEntries.isEmpty { await uploader.sendNow() }
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        let accepted = transport.requests.filter { request in
            request.segments.count <= 2 && !request.segments.contains { $0.body == "poison" }
        }
        XCTAssertEqual(bodies(accepted), ["a", "b", "c", "d"], "the rest arrive, in order")
        XCTAssertEqual(uploader.droppedCount, 1)
    }

    // MARK: - What Moss says back

    func testPausedFromMossStopsSendingAndEmptiesTheBuffer() async {
        transport.answer = { _ in (409, Self.errorJSON("backtrack_paused")) }
        let uploader = uploader()
        uploader.accept(segment("Quarterly plan"))
        await uploader.sendNow()
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        XCTAssertEqual(uploader.availability, .paused)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertNil(keys.key)
        uploader.accept(segment("After the pause"))
        await uploader.sendNow()
        XCTAssertEqual(transport.bodies.count, 1, "nothing more is taken or sent while paused")
        XCTAssertTrue(BacktrackVisibility.shows(isDebugBuild: false, availability: .paused), "the tab stays, saying why")
    }

    func testNotStoredInMossStopsAndHidesBacktrackInRelease() async {
        transport.answer = { _ in (409, Self.errorJSON("backtrack_unavailable")) }
        let uploader = uploader()
        uploader.accept(segment("Quarterly plan"))
        await uploader.sendNow()
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        XCTAssertEqual(uploader.availability, .unavailable)
        XCTAssertFalse(BacktrackVisibility.shows(isDebugBuild: false, availability: uploader.availability))
        XCTAssertTrue(BacktrackVisibility.shows(isDebugBuild: true, availability: uploader.availability))
    }

    func testAPausedStateInASuccessfulAnswerAlsoStops() async {
        transport.answer = { request in (200, Self.okJSON(accepted: request.segments.count, paused: true)) }
        let uploader = uploader()
        uploader.accept(segment("first"))
        await uploader.sendNow()
        XCTAssertEqual(uploader.availability, .paused)
        uploader.accept(segment("second"))
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
    }

    func testAClockRefusalKeepsTheBatchAndSaysTheClockLooksWrong() async {
        transport.answer = { _ in (422, Self.errorJSON("backtrack_clock")) }
        let uploader = uploader()
        uploader.accept(segment("Quarterly plan"))
        await uploader.sendNow()
        XCTAssertEqual(uploader.bufferedEntries.count, 1)
        XCTAssertTrue(uploader.clockLooksWrong)

        transport.answer = { request in (200, Self.okJSON(accepted: 0, rejectedClock: request.segments.count)) }
        await uploader.sendNow()
        XCTAssertTrue(uploader.bufferedEntries.isEmpty, "a 2xx removes the batch whatever the counts")
        XCTAssertTrue(uploader.clockLooksWrong, "segments Moss couldn't place still say so")

        transport.answer = { request in (200, Self.okJSON(accepted: request.segments.count)) }
        uploader.accept(segment("Later"))
        await uploader.sendNow()
        XCTAssertFalse(uploader.clockLooksWrong)
    }

    func testAnInvalidCredentialDropsEverything() async {
        transport.answer = { _ in (401, Self.errorJSON("companion_credential_invalid")) }
        let uploader = uploader()
        uploader.accept(segment("Quarterly plan"))
        await uploader.sendNow()
        XCTAssertTrue(uploader.bufferedEntries.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertNil(keys.key)
    }

    func testServerErrorsAndRateLimitsKeepTheBatch() async {
        for status in [429, 500, 503] {
            transport.answer = { _ in (status, #"{"error":"x"}"#) }
            let uploader = uploader()
            uploader.discardAll()
            uploader.accept(segment("Quarterly plan"))
            await uploader.sendNow()
            XCTAssertEqual(uploader.bufferedEntries.count, 1, "status \(status)")
        }
    }

    // MARK: - The buffer

    func testTheBufferFileHoldsNoPlaintextAndSurvivesARestart() async throws {
        let marker = "zebra-marker-7f3a"
        let first = uploader(sending: false)
        first.accept(segment("Text with \(marker) in it"))
        first.accept(segment("More text"))
        let data = try Data(contentsOf: fileURL)
        XCTAssertNil(data.range(of: Data(marker.utf8)), "the file is encrypted")
        XCTAssertNil(data.range(of: Data("example.com".utf8)))
        XCTAssertNil(data.range(of: Data("Safari".utf8)))

        let second = uploader()
        XCTAssertEqual(second.bufferedEntries, first.bufferedEntries, "a restart reads back what waited")
        await second.sendNow()
        XCTAssertEqual(bodies(transport.requests), ["Text with \(marker) in it", "More text"])
    }

    func testAFileWhoseKeyIsGoneIsDeletedUnread() throws {
        let first = uploader(sending: false)
        first.accept(segment("Quarterly plan"))
        keys.key = nil
        let second = uploader()
        XCTAssertTrue(second.bufferedEntries.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testDiscardDeletesTheFileAndTheKeyAndNothingIsSentAfter() async {
        let uploader = uploader()
        uploader.accept(segment("Quarterly plan"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertNotNil(keys.key)
        uploader.discardAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertNil(keys.key)
        await uploader.sendNow()
        XCTAssertTrue(transport.bodies.isEmpty)
    }

    func testTheBufferDropsTheOldestPastADay() {
        let uploader = uploader(sending: false)
        uploader.accept(segment("old", at: 0))
        uploader.accept(segment("newer", at: 2 * 60 * 60))
        now = now.addingTimeInterval(BacktrackBuffer.maxAge + 60)
        uploader.accept(segment("new", at: 0))
        XCTAssertEqual(uploader.bufferedEntries.map(\.upload.body), ["newer", "new"])
    }

    func testTheBufferDropsTheOldestPastItsByteCap() {
        let uploader = uploader(maxBytes: 100_000, sending: false)
        for index in 0..<30 {
            uploader.accept(segment("segment \(index) ", at: TimeInterval(index), bodyBytes: 8000))
        }
        let kept = uploader.bufferedEntries.map { Int($0.upload.body.split(separator: " ")[1])! }
        XCTAssertLessThan(kept.count, 30)
        XCTAssertEqual(kept, Array((30 - kept.count)..<30), "oldest dropped first")
        let reopened = self.uploader(maxBytes: 100_000)
        XCTAssertEqual(reopened.bufferedEntries.count, kept.count, "the file matches what is held")
    }

    // MARK: - The heartbeat

    final class HeartbeatTransport: CompanionTransport, @unchecked Sendable {
        let backtrack: String
        init(_ backtrack: String) { self.backtrack = backtrack }
        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let json = #"{"device":{"id":"d","displayName":"Mac"},"account":{"name":"T","email":"t@example.com"},"serverTime":"2026-01-01T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z""#
                + backtrack + "}"
            return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
    }

    func testTheHeartbeatCarriesMossBacktrackStateAndAnOlderMossHasNone() async throws {
        let instance = PrivacyFixesTests.identity().instance
        let on = CompanionClient(instance: instance, transport: HeartbeatTransport(#","backtrack":{"storage":"on","paused":true}"#))
        let beat = try await on.heartbeat(credential: "tm1_test", app: "1", os: "14")
        XCTAssertEqual(beat.backtrack, BacktrackState(storage: .on, paused: true))
        let older = CompanionClient(instance: instance, transport: HeartbeatTransport(""))
        let none = try await older.heartbeat(credential: "tm1_test", app: "1", os: "14")
        XCTAssertNil(none.backtrack)
        XCTAssertEqual(BacktrackSinkAvailability(none.backtrack), .unavailable)
    }

    // MARK: - Shape

    func testFieldsAreCutToTheServersByteLimitsOnACharacterBoundary() throws {
        let body = String(repeating: "a", count: BacktrackUploader.bodyBytes - 1) + "é"
        let shaped = BacktrackUploader.upload(for: BacktrackSegment(
            appName: "", bundleId: "com.example.app", windowTitle: String(repeating: "👩‍👩‍👧", count: 100),
            address: nil, lines: [body], start: now, end: now
        ))
        XCTAssertEqual(shaped.body.utf8.count, BacktrackUploader.bodyBytes - 1, "é would cross the limit")
        XCTAssertLessThanOrEqual(shaped.windowTitle.utf8.count, BacktrackUploader.windowTitleBytes)
        XCTAssertTrue(shaped.windowTitle.allSatisfy { $0 == "👩‍👩‍👧" }, "no character is split")
        XCTAssertEqual(shaped.appName, "com.example.app", "Moss requires a name")
        let json = try XCTUnwrap(String(data: try JSONEncoder().encode(shaped), encoding: .utf8))
        XCTAssertFalse(json.contains("address"), "no address is omitted, not null")
    }

    func testLinesAreJoinedOnePerLine() {
        let shaped = BacktrackUploader.upload(for: BacktrackSegment(
            appName: "Safari", bundleId: "com.apple.Safari", windowTitle: "Docs", address: "https://example.com",
            lines: ["one", "two"], start: now, end: now
        ))
        XCTAssertEqual(shaped.body, "one\ntwo")
        XCTAssertEqual(shaped.startedAt, ServerTime.format(now))
    }
}
