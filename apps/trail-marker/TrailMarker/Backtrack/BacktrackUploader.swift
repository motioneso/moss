import Foundation

/// What the uploader needs from the link: what Moss last said about Backtrack, and a client to
/// send with. `ConnectionRuntime` in the app, a fake in tests.
@MainActor
protocol BacktrackUploadEnvironment: AnyObject {
    var backtrackState: BacktrackState? { get }
    func noteBacktrackState(_ state: BacktrackState?)
    /// Nil while not linked, paused, or without a readable credential.
    func requestClient() -> (CompanionClient, String)?
}

/// Phase 2b's sink (plan 2026-10-03-backtrack-phase2.md §5.1): keeps segments in the encrypted
/// buffer and sends the oldest to Moss once a minute. It takes nothing unless Moss has said it
/// stores Backtrack and the person hasn't paused it there, and it sends nothing while
/// `sendingAllowed` says no (Pause All, the Backtrack switch, lock, sleep).
@MainActor
final class BacktrackUploader: BacktrackSink, ObservableObject {
    /// Consent version 2: "sent to your Moss and kept there".
    let requiredConsentVersion = 2

    static let interval: TimeInterval = 60
    static let maxSegmentsPerRequest = 200
    /// Decision 13: 1.5 MiB of encoded JSON, measured, under the route's 2 MiB limit.
    static let maxRequestBytes = 1_572_864
    /// The route allows 10 requests a minute from one address; leave room for other Macs.
    static let maxRequestsPerSend = 6
    // The server's column limits, in UTF-8 bytes (packages/backtrack/sql/0282). A longer field
    // would be dropped there without a word, so it is cut here instead.
    static let bodyBytes = 8192
    static let appNameBytes = 400
    static let bundleIdBytes = 255
    static let windowTitleBytes = 1000
    static let addressBytes = 2048

    @Published private(set) var lastSentAt: Date?
    /// Moss refused this Mac's clock, or dropped segments whose times it couldn't place.
    @Published private(set) var clockLooksWrong = false
    @Published private(set) var pendingCount = 0
    /// Segments Moss refused even on their own, dropped so they can't block the rest.
    private(set) var droppedCount = 0

    /// Wired to the runtime: Backtrack on and agreed to, the menu switch on, not Pause All, not
    /// locked or asleep.
    var sendingAllowed: () -> Bool = { false }

    private weak var environment: BacktrackUploadEnvironment?
    private var buffer: BacktrackBuffer
    private let clock: () -> Date
    private let scheduler: BacktrackScheduling
    private var timer: BacktrackTimer?
    private var sending = false

    init(
        environment: BacktrackUploadEnvironment,
        keys: BacktrackBufferKeyStoring,
        fileURL: URL = BacktrackBuffer.defaultFileURL(),
        clock: @escaping () -> Date = Date.init,
        scheduler: BacktrackScheduling? = nil,
        bufferMaxBytes: Int = BacktrackBuffer.defaultMaxBytes
    ) {
        self.environment = environment
        self.clock = clock
        self.scheduler = scheduler ?? RunLoopScheduler()
        buffer = BacktrackBuffer(fileURL: fileURL, keys: keys, now: clock(), maxBytes: bufferMaxBytes)
        pendingCount = buffer.entries.count
    }

    var availability: BacktrackSinkAvailability { BacktrackSinkAvailability(environment?.backtrackState) }

    var bufferedEntries: [BacktrackBufferEntry] { buffer.entries }

    func start() {
        guard timer == nil else { return }
        scheduleNext()
    }

    private func scheduleNext() {
        timer?.cancel()
        timer = scheduler.schedule(after: Self.interval) { [weak self] in
            Task { @MainActor [weak self] in
                await self?.sendNow()
                self?.scheduleNext()
            }
        }
    }

    // MARK: - BacktrackSink

    func accept(_ segment: BacktrackSegment) {
        guard availability == .ready else { return }
        let entry = BacktrackBufferEntry(id: UUID(), capturedAt: segment.start, upload: Self.upload(for: segment))
        buffer.append(entry, now: clock())
        pendingCount = buffer.entries.count
    }

    func discardAll() {
        buffer.wipe()
        pendingCount = 0
        lastSentAt = nil
        clockLooksWrong = false
    }

    // MARK: - Sending

    /// One send: up to `maxRequestsPerSend` requests, oldest segments first.
    func sendNow() async {
        guard !sending else { return }
        sending = true
        defer {
            sending = false
            pendingCount = buffer.entries.count
        }
        guard availability == .ready else {
            // Paused from Moss, or not stored there: what waits here would only be refused.
            if !buffer.isEmpty { buffer.wipe() }
            return
        }
        buffer.expire(now: clock())
        guard !buffer.isEmpty, sendingAllowed(), let environment, let (client, credential) = environment.requestClient()
        else { return }

        let generation = buffer.generation
        var halves: [[BacktrackBufferEntry]] = []
        var requests = 0
        batches: while requests < Self.maxRequestsPerSend {
            let batch = halves.popLast() ?? Self.pack(buffer.entries)
            guard !batch.isEmpty else { break }
            guard sendingAllowed(), availability == .ready, buffer.generation == generation else { break }
            requests += 1
            let ids = Set(batch.map(\.id))
            do {
                let body = try Self.encode(batch, sentAt: clock())
                let response = try await client.backtrackUpload(credential: credential, encoded: body)
                guard buffer.generation == generation else { break }
                buffer.remove(ids)
                lastSentAt = clock()
                clockLooksWrong = response.rejectedClock > 0
                environment.noteBacktrackState(response.state)
                if availability != .ready {
                    buffer.wipe()
                    break
                }
            } catch let error as CompanionError {
                guard buffer.generation == generation else { break }
                switch error {
                case .server(status: 413), .server(status: 400):
                    // Too big, or one segment Moss won't take: halve until it goes, and drop a
                    // single segment that still fails.
                    if batch.count == 1 {
                        buffer.remove(ids)
                        droppedCount += 1
                    } else {
                        let middle = batch.count / 2
                        halves.append(Array(batch[middle...]))
                        halves.append(Array(batch[..<middle]))
                    }
                case .backtrackClock:
                    clockLooksWrong = true
                    break batches
                case .backtrackUnavailable:
                    environment.noteBacktrackState(BacktrackState(storage: .off, paused: false))
                    buffer.wipe()
                    break batches
                case .backtrackPaused:
                    environment.noteBacktrackState(BacktrackState(storage: .on, paused: true))
                    buffer.wipe()
                    break batches
                case .credentialInvalid:
                    buffer.wipe()
                    break batches
                default:
                    // Offline, rate limited or a server error: kept for the next send.
                    break batches
                }
            } catch {
                break
            }
        }
    }

    // MARK: - Shape

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }

    /// The oldest entries that fit one request: at most 200, and at most `maxRequestBytes` once
    /// encoded, counted from each segment's own encoded bytes.
    static func pack(_ entries: [BacktrackBufferEntry]) -> [BacktrackBufferEntry] {
        let encoder = encoder()
        let empty = BacktrackUploadRequest(sentAt: ServerTime.format(Date()), segments: [])
        var size = (try? encoder.encode(empty).count) ?? 0
        var batch: [BacktrackBufferEntry] = []
        for entry in entries.prefix(maxSegmentsPerRequest) {
            guard let segment = try? encoder.encode(entry.upload).count else { continue }
            let added = segment + (batch.isEmpty ? 0 : 1)
            if size + added > maxRequestBytes { break }
            size += added
            batch.append(entry)
        }
        return batch
    }

    static func encode(_ batch: [BacktrackBufferEntry], sentAt: Date) throws -> Data {
        try encoder().encode(BacktrackUploadRequest(sentAt: ServerTime.format(sentAt), segments: batch.map(\.upload)))
    }

    /// The segment as Moss takes it: the lines joined, every field cut on a character boundary to
    /// the server's byte limits. The device comes from the credential, never the body.
    static func upload(for segment: BacktrackSegment) -> BacktrackSegmentUpload {
        let bundleId = segment.bundleId.isEmpty ? "unknown" : segment.bundleId
        let appName = segment.appName.isEmpty ? bundleId : segment.appName
        return BacktrackSegmentUpload(
            startedAt: ServerTime.format(segment.start),
            endedAt: ServerTime.format(max(segment.end, segment.start)),
            appName: clip(appName, toBytes: appNameBytes),
            bundleId: clip(bundleId, toBytes: bundleIdBytes),
            windowTitle: clip(segment.windowTitle, toBytes: windowTitleBytes),
            address: segment.address.map { clip($0, toBytes: addressBytes) },
            body: clip(segment.lines.joined(separator: "\n"), toBytes: bodyBytes)
        )
    }

    static func clip(_ text: String, toBytes limit: Int) -> String {
        guard text.utf8.count > limit else { return text }
        var bytes = 0
        var end = text.startIndex
        for index in text.indices {
            let size = text[index].utf8.count
            if bytes + size > limit { break }
            bytes += size
            end = text.index(after: index)
        }
        return String(text[..<end])
    }
}

extension BacktrackSinkAvailability {
    /// What Moss last said: nothing, or storage off, means there is nowhere to send.
    init(_ state: BacktrackState?) {
        guard let state, state.storage == .on else {
            self = .unavailable
            return
        }
        self = state.paused ? .paused : .ready
    }
}

/// Whether a build shows Backtrack at all (plan §5.1): Debug always, for the in-memory preview;
/// Release only once Moss has said it stores Backtrack.
enum BacktrackVisibility {
    static func shows(isDebugBuild: Bool, availability: BacktrackSinkAvailability) -> Bool {
        isDebugBuild || availability != .unavailable
    }
}
