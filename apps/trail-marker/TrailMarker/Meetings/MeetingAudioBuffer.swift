import Foundation

/// A bounded memory-only ring. No per-callback task, file, network call or array allocation.
/// Lock holders never invoke device APIs or external code except the synchronous sample reader.
final class MeetingAudioBuffer: MeetingAudioReceiving {
    static let maximumCallbackFrames = 8192
    static let maximumAgeNanoseconds: UInt64 = 60_000_000_000
    static let warningAgeNanoseconds: UInt64 = 30_000_000_000

    private struct Block {
        var start: UInt64 = 0
        var rate: Double = 0
        var frames: Int = 0
        var position: Int = 0
        var sequence: UInt64 = 0
        var end: UInt64 { start + UInt64((Double(frames) * 1_000_000_000 / rate).rounded(.up)) }
    }

    let source: MeetingAudioSource
    let epoch: UInt64
    private let origin: UInt64
    private let lock = NSLock()
    private var samples: [Float]
    private var blocks: [Block]
    private var sampleTail = 0
    private var usedSamples = 0
    private var blockHead = 0
    private var blockCount = 0
    private var nextSequence: UInt64 = 0
    private var lastStart: UInt64?
    private var lastEnd: UInt64?
    private var rate: Double?
    private var accepting = true
    private var storedFailure: MeetingAudioFailure?

    init(source: MeetingAudioSource, epoch: UInt64, originNanoseconds: UInt64,
         sampleCapacity: Int = 1_048_576, blockCapacity: Int = 4096) throws {
        guard epoch > 0, sampleCapacity > 0, sampleCapacity <= 11_520_000,
              blockCapacity > 0, blockCapacity <= 16384 else { throw MeetingAudioFailure.invalidSelection }
        self.source = source
        self.epoch = epoch
        origin = originNanoseconds
        samples = Array(repeating: 0, count: sampleCapacity)
        blocks = Array(repeating: Block(), count: blockCapacity)
    }

    func receive(hostTimeNanoseconds start: UInt64, sampleRate: Double, frameCount: Int,
                 sampleAt: (Int) -> Float) {
        lock.lock()
        defer { lock.unlock() }
        guard accepting, storedFailure == nil else { return }
        guard sampleRate.isFinite, (8000...192000).contains(sampleRate), frameCount > 0,
              frameCount <= Self.maximumCallbackFrames else { failLocked(.invalidFormat); return }
        guard rate.map({ $0 == sampleRate }) ?? true else { failLocked(.invalidFormat); return }
        let duration = UInt64((Double(frameCount) * 1_000_000_000 / sampleRate).rounded(.up))
        guard start >= origin, start <= UInt64.max - duration,
              lastStart.map({ start > $0 }) ?? true else { failLocked(.invalidTimestamp); return }
        // Tolerate at most two sample periods for host-clock timestamp rounding/jitter.
        // Larger gaps/overlap require an explicit new epoch instead of invented continuity.
        if let previousEnd = lastEnd {
            let difference = start >= previousEnd ? start - previousEnd : previousEnd - start
            let tolerance = UInt64((2_000_000_000 / sampleRate).rounded(.up))
            guard difference <= tolerance else { failLocked(.invalidTimestamp); return }
        }
        guard frameCount <= samples.count - usedSamples, blockCount < blocks.count,
              blockCount == 0 || start + duration - blocks[blockHead].start <= Self.maximumAgeNanoseconds,
              nextSequence < UInt64.max else { failLocked(.bufferFull); return }
        // Validate before publishing the block. A malformed sample never becomes pending audio.
        for index in 0..<frameCount {
            let value = sampleAt(index)
            guard value.isFinite else { failLocked(.invalidFormat); return }
            samples[(sampleTail + index) % samples.count] = value
        }
        blocks[(blockHead + blockCount) % blocks.count] = Block(
            start: start, rate: sampleRate, frames: frameCount, position: sampleTail, sequence: nextSequence
        )
        sampleTail = (sampleTail + frameCount) % samples.count
        usedSamples += frameCount
        blockCount += 1
        nextSequence += 1
        lastStart = start
        lastEnd = start + duration
        rate = sampleRate
    }

    func fail(_ failure: MeetingAudioFailure) {
        lock.lock()
        defer { lock.unlock() }
        failLocked(failure)
    }

    private func failLocked(_ failure: MeetingAudioFailure) {
        if storedFailure == nil { storedFailure = failure }
        accepting = false
    }

    var failure: MeetingAudioFailure? {
        lock.lock()
        defer { lock.unlock() }
        return storedFailure
    }

    /// Closes admission before the caller stops the device; later callbacks cannot refill the ring.
    func close() {
        lock.lock()
        accepting = false
        lock.unlock()
    }

    /// Only the next unacknowledged block is exposed; repeated reads retain stable identity.
    func peek(cutoffNanoseconds: UInt64? = nil) -> MeetingAudioPacket? {
        lock.lock()
        defer { lock.unlock() }
        guard blockCount > 0 else { return nil }
        let block = blocks[blockHead]
        var count = block.frames
        if let cutoff = cutoffNanoseconds {
            guard cutoff > block.start else { return nil }
            let available = (Double(cutoff - block.start) * block.rate / 1_000_000_000).rounded(.down)
            if available < Double(count) { count = max(0, Int(available)) }
            // Floating-point conversion cannot authorize even one sample crossing the cutoff.
            while count > 0 && block.start + UInt64((Double(count) * 1_000_000_000 / block.rate).rounded(.up)) > cutoff {
                count -= 1
            }
        }
        guard count > 0 else { return nil }
        let copy = (0..<count).map { samples[(block.position + $0) % samples.count] }
        return MeetingAudioPacket(source: source, epoch: epoch, sequence: block.sequence,
                                  startNanoseconds: block.start, sampleRate: block.rate, samples: copy)
    }

    /// A receive receipt, not completion of ASR. Only the exposed head may be acknowledged.
    func acknowledge(sequence: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard blockCount > 0, blocks[blockHead].sequence == sequence else { return false }
        removeHead()
        return true
    }

    private func removeHead() {
        let block = blocks[blockHead]
        for index in 0..<block.frames { samples[(block.position + index) % samples.count] = 0 }
        usedSamples -= block.frames
        blocks[blockHead] = Block()
        blockHead = (blockHead + 1) % blocks.count
        blockCount -= 1
    }

    func expire(nowNanoseconds now: UInt64) -> [MeetingAudioGap] {
        lock.lock()
        defer { lock.unlock() }
        var gaps: [MeetingAudioGap] = []
        while blockCount > 0 {
            let block = blocks[blockHead]
            guard now >= block.start, now - block.start >= Self.maximumAgeNanoseconds else { break }
            gaps.append(MeetingAudioGap(source: source, epoch: epoch, startNanoseconds: block.start,
                endNanoseconds: block.end, reason: .expired))
            removeHead()
        }
        return gaps
    }

    func isBacklogged(nowNanoseconds now: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard blockCount > 0, now >= blocks[blockHead].start else { return false }
        return now - blocks[blockHead].start >= Self.warningAgeNanoseconds
    }

    func discard() {
        lock.lock()
        defer { lock.unlock() }
        accepting = false
        while blockCount > 0 { removeHead() }
    }
}
