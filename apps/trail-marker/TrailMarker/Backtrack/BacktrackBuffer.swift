import CryptoKit
import Foundation

/// Where the buffer's 256-bit key lives: the Keychain in the app, memory in tests.
protocol BacktrackBufferKeyStoring {
    func storeBacktrackBufferKey(_ key: Data) throws
    func readBacktrackBufferKey() -> Data?
    @discardableResult func deleteBacktrackBufferKey() -> Bool
}

/// One segment waiting to be sent, already in the shape Moss takes.
struct BacktrackBufferEntry: Codable, Equatable {
    let id: UUID
    /// When the text was first on screen, by this Mac's clock; the 24-hour cap counts from it.
    let capturedAt: Date
    let upload: BacktrackSegmentUpload
}

/// Segments not yet accepted by Moss (phase 2 plan §5.1). Each one is sealed on its own with
/// AES-GCM under a key kept in the Keychain, so plaintext never reaches the disk. A new segment is
/// appended to the file; removing any rewrites it from the sealed records. Capped at 24 hours and
/// 20 MB, oldest dropped first, with some slack so a full buffer isn't rewritten on every segment.
/// `wipe()` deletes the file and the key.
struct BacktrackBuffer {
    static let maxAge: TimeInterval = 24 * 60 * 60
    /// Past 24 hours, everything older than 23 is dropped at once.
    static let ageSlack: TimeInterval = 60 * 60
    static let defaultMaxBytes = 20 * 1024 * 1024
    private static let magic = Data("TMBB1".utf8)

    private(set) var entries: [BacktrackBufferEntry] = []
    /// The sealed form of each entry, so a rewrite never re-encrypts anything.
    private var sealed: [UUID: Data] = [:]
    private(set) var totalBytes = 0
    /// Bumped by `wipe()`, so a send that started before it can't act on what it removed.
    private(set) var generation = 0

    let fileURL: URL
    let maxBytes: Int
    private let keys: BacktrackBufferKeyStoring

    static func defaultFileURL() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("com.moss.trailmarker/Backtrack/buffer.bin")
    }

    /// Opens what an earlier run left. A file whose key is gone can't be read and is deleted.
    init(
        fileURL: URL = BacktrackBuffer.defaultFileURL(), keys: BacktrackBufferKeyStoring, now: Date,
        maxBytes: Int = BacktrackBuffer.defaultMaxBytes
    ) {
        self.fileURL = fileURL
        self.keys = keys
        self.maxBytes = maxBytes
        guard let data = try? Data(contentsOf: fileURL) else { return }
        guard let keyData = keys.readBacktrackBufferKey() else {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        let key = SymmetricKey(data: keyData)
        for record in Self.records(in: data) {
            guard let box = try? AES.GCM.SealedBox(combined: record),
                  let plain = try? AES.GCM.open(box, using: key),
                  let entry = try? JSONDecoder().decode(BacktrackBufferEntry.self, from: plain)
            else { continue }
            entries.append(entry)
            sealed[entry.id] = record
            totalBytes += record.count + 4
        }
        if dropOverCaps(now: now) { persist() }
    }

    var isEmpty: Bool { entries.isEmpty }

    /// Adds a segment, then drops the oldest past the caps. False when it couldn't be sealed (no
    /// key could be read or made): the segment is not kept anywhere.
    @discardableResult
    mutating func append(_ entry: BacktrackBufferEntry, now: Date) -> Bool {
        guard let key = key(creating: true),
              let plain = try? JSONEncoder().encode(entry),
              let record = try? AES.GCM.seal(plain, using: key).combined
        else { return false }
        entries.append(entry)
        sealed[entry.id] = record
        totalBytes += record.count + 4
        if dropOverCaps(now: now) || !appendToFile(record) { persist() }
        return true
    }

    mutating func remove(_ ids: Set<UUID>) {
        guard !ids.isEmpty else { return }
        let before = entries.count
        entries.removeAll { entry in
            guard ids.contains(entry.id) else { return false }
            totalBytes -= (sealed.removeValue(forKey: entry.id)?.count ?? 0) + 4
            return true
        }
        if entries.count != before { persist() }
    }

    /// Drops the oldest entries past 24 hours or 20 MB, on disk too.
    mutating func expire(now: Date) {
        if dropOverCaps(now: now) { persist() }
    }

    /// Drops the oldest entries once the oldest is past 24 hours (down to 23) or the total is past
    /// the byte cap (down to 90% of it). True when anything was dropped.
    private mutating func dropOverCaps(now: Date) -> Bool {
        var dropped = false
        if let oldest = entries.first, now.timeIntervalSince(oldest.capturedAt) > Self.maxAge {
            while let first = entries.first, now.timeIntervalSince(first.capturedAt) > Self.maxAge - Self.ageSlack {
                dropFirst()
                dropped = true
            }
        }
        if totalBytes > maxBytes {
            while !entries.isEmpty, totalBytes > maxBytes / 10 * 9 {
                dropFirst()
                dropped = true
            }
        }
        return dropped
    }

    private mutating func dropFirst() {
        let oldest = entries.removeFirst()
        totalBytes -= (sealed.removeValue(forKey: oldest.id)?.count ?? 0) + 4
    }

    /// Log out, revoke, Backtrack off, paused or not stored in Moss: the file and its key go.
    mutating func wipe() {
        entries = []
        sealed = [:]
        totalBytes = 0
        generation += 1
        try? FileManager.default.removeItem(at: fileURL)
        keys.deleteBacktrackBufferKey()
    }

    // MARK: - File

    private func key(creating: Bool) -> SymmetricKey? {
        if let data = keys.readBacktrackBufferKey() { return SymmetricKey(data: data) }
        guard creating else { return nil }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        guard (try? keys.storeBacktrackBufferKey(data)) != nil else { return nil }
        return key
    }

    private static func framed(_ record: Data) -> Data {
        var length = UInt32(record.count).bigEndian
        return Data(bytes: &length, count: 4) + record
    }

    /// Adds one record at the end of an existing file. False when there is no file to add to, or
    /// the write failed; the caller then rewrites the whole file.
    private func appendToFile(_ record: Data) -> Bool {
        guard let handle = try? FileHandle(forWritingTo: fileURL) else { return false }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: Self.framed(record))
            return true
        } catch {
            return false
        }
    }

    /// The magic, then each sealed record as a 4-byte big-endian length and its bytes.
    private func persist() {
        if entries.isEmpty {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        var data = Self.magic
        data.reserveCapacity(totalBytes + Self.magic.count)
        for entry in entries {
            guard let record = sealed[entry.id] else { continue }
            data.append(Self.framed(record))
        }
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func records(in data: Data) -> [Data] {
        guard data.starts(with: magic) else { return [] }
        var records: [Data] = []
        var offset = data.startIndex + magic.count
        while offset + 4 <= data.endIndex {
            let length = data[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
            offset += 4
            guard length > 0, offset + length <= data.endIndex else { break }
            records.append(Data(data[offset..<offset + length]))
            offset += length
        }
        return records
    }
}
