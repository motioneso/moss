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
    private let callbackFailures = MeetingAudioAtomicState()
    private let controlLock = NSLock()
    private let samples: UnsafeMutablePointer<Float>
    private let sampleCapacity: Int
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
         sampleCapacity: Int = 2_097_152, blockCapacity: Int = 4096) throws {
        guard epoch > 0, sampleCapacity > 0, sampleCapacity <= 11_520_000,
              blockCapacity > 0, blockCapacity <= 16384 else { throw MeetingAudioFailure.invalidSelection }
        self.source = source
        self.epoch = epoch
        origin = originNanoseconds
        self.sampleCapacity = sampleCapacity
        samples = .allocate(capacity: sampleCapacity)
        samples.initialize(repeating: 0, count: sampleCapacity)
        blocks = Array(repeating: Block(), count: blockCapacity)
    }

    func receive(hostTimeNanoseconds start: UInt64, sampleRate: Double, frameCount: Int,
                 sampleAt: (Int) -> Float) {
        // Never wait behind control-plane packet copies/expiry. Latch an explicit fault
        // atomically so even a final dropped callback is visible without a later callback.
        guard lock.try() else { callbackFailures.insert(1); return }
        defer { lock.unlock() }
        guard accepting, storedFailure == nil, callbackFailures.value == 0 else { return }
        guard sampleRate.isFinite, (8000...192000).contains(sampleRate),
              sampleRate.rounded() == sampleRate, frameCount > 0,
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
        guard frameCount <= sampleCapacity - usedSamples, blockCount < blocks.count,
              blockCount == 0 || start + duration - blocks[blockHead].start <= Self.maximumAgeNanoseconds,
              nextSequence < UInt64.max else { failLocked(.bufferFull); return }
        // Validate before publishing the block. A malformed sample never becomes pending audio.
        for index in 0..<frameCount {
            let value = sampleAt(index)
            guard value.isFinite else { failLocked(.invalidFormat); return }
            samples[(sampleTail + index) % sampleCapacity] = value
        }
        blocks[(blockHead + blockCount) % blocks.count] = Block(
            start: start, rate: sampleRate, frames: frameCount, position: sampleTail, sequence: nextSequence
        )
        sampleTail = (sampleTail + frameCount) % sampleCapacity
        usedSamples += frameCount
        blockCount += 1
        nextSequence += 1
        lastStart = start
        lastEnd = start + duration
        rate = sampleRate
    }

    func fail(_ failure: MeetingAudioFailure) {
        // Scope uncertainty must survive simultaneous copying/other faults, because runtime
        // discards that epoch instead of later flushing potentially out-of-scope retained audio.
        if failure == .invalidSelection { callbackFailures.insert(2) }
        guard lock.try() else { callbackFailures.insert(1); return }
        defer { lock.unlock() }
        guard accepting else { return }
        failLocked(failure)
    }

    private func failLocked(_ failure: MeetingAudioFailure) {
        if storedFailure == nil { storedFailure = failure }
        accepting = false
    }

    var failure: MeetingAudioFailure? {
        lock.lock()
        defer { lock.unlock() }
        let flags = callbackFailures.value
        if flags & 2 != 0 { return .invalidSelection }
        return storedFailure ?? (flags == 0 ? nil : .bufferFull)
    }

    /// Closes admission before the caller stops the device; later callbacks cannot refill the ring.
    func close() {
        lock.lock()
        accepting = false
        lock.unlock()
    }

    struct Chunk {
        let packet: MeetingAudioPacket
        let throughSequence: UInt64
    }

    /// Control operations are serialized independently from callback admission. Published sample
    /// ranges stay occupied until acknowledgement, so packet allocation/copy never holds the
    /// callback lock. The callback writes only unoccupied ranges of the preallocated storage.
    func peek(cutoffNanoseconds: UInt64? = nil) -> MeetingAudioPacket? {
        peekChunk(targetDurationNanoseconds: nil, cutoffNanoseconds: cutoffNanoseconds,
                  allowPartial: true)?.packet
    }

    func peekChunk(targetDurationNanoseconds: UInt64?, cutoffNanoseconds: UInt64?,
                   allowPartial: Bool) -> Chunk? {
        if let duration = targetDurationNanoseconds, duration == 0 || duration > 5_000_000_000 { return nil }
        controlLock.lock()
        defer { controlLock.unlock() }
        lock.lock()
        guard blockCount > 0 else { lock.unlock(); return nil }
        let first = blocks[blockHead]
        let targetFrames = targetDurationNanoseconds.map {
            Int((Double($0) * first.rate / 1_000_000_000).rounded(.up))
        } ?? first.frames
        var selected: [(Block, Int)] = []
        var total = 0
        for offset in 0..<blockCount {
            let block = blocks[(blockHead + offset) % blocks.count]
            var count = block.frames
            if let cutoff = cutoffNanoseconds {
                guard cutoff > block.start else { break }
                let available = (Double(cutoff - block.start) * block.rate / 1_000_000_000).rounded(.down)
                if available < Double(count) { count = max(0, Int(available)) }
            }
            // Bound the coalesced timeline and integer addition, including accumulated
            // timestamp jitter. A callback's own end need not equal the merged sample end.
            let limit = cutoffNanoseconds ?? UInt64.max
            while count > 0 && UInt64((Double(total + count) * 1_000_000_000 /
                    first.rate).rounded(.up)) > limit - first.start { count -= 1 }
            guard count > 0 else { break }
            selected.append((block, count))
            total += count
            if total >= targetFrames || count < block.frames { break }
        }
        lock.unlock()
        guard total > 0, allowPartial || total >= targetFrames, let last = selected.last else { return nil }
        var copy = [Float]()
        copy.reserveCapacity(total)
        for (block, count) in selected {
            for index in 0..<count { copy.append(samples[(block.position + index) % sampleCapacity]) }
        }
        return Chunk(packet: MeetingAudioPacket(source: source, epoch: epoch, sequence: first.sequence,
            startNanoseconds: first.start, sampleRate: first.rate, samples: copy), throughSequence: last.0.sequence)
    }

    /// A receive receipt, not completion of ASR. Only an unchanged head/chunk may be acknowledged.
    func acknowledge(sequence: UInt64, throughSequence: UInt64? = nil) -> Bool {
        controlLock.lock()
        defer { controlLock.unlock() }
        lock.lock()
        let last = throughSequence ?? sequence
        guard blockCount > 0, blocks[blockHead].sequence == sequence, last >= sequence,
              last - sequence < UInt64(blockCount) else { lock.unlock(); return false }
        let count = Int(last - sequence + 1)
        lock.unlock()
        for _ in 0..<count { removeHead() }
        return true
    }

    /// Caller holds controlLock. Keep storage occupied while erasing it without blocking callbacks.
    private func removeHead() {
        lock.lock()
        let block = blocks[blockHead]
        lock.unlock()
        for index in 0..<block.frames { samples[(block.position + index) % sampleCapacity] = 0 }
        lock.lock()
        usedSamples -= block.frames
        blocks[blockHead] = Block()
        blockHead = (blockHead + 1) % blocks.count
        blockCount -= 1
        lock.unlock()
    }

    func expire(nowNanoseconds now: UInt64) -> [MeetingAudioGap] {
        controlLock.lock()
        defer { controlLock.unlock() }
        var gaps: [MeetingAudioGap] = []
        while true {
            lock.lock()
            guard blockCount > 0 else { lock.unlock(); break }
            let block = blocks[blockHead]
            lock.unlock()
            guard now >= block.start, now - block.start >= Self.maximumAgeNanoseconds else { break }
            let next = MeetingAudioGap(source: source, epoch: epoch, startNanoseconds: block.start,
                                       endNanoseconds: block.end, reason: .expired)
            // An expiry tick can drain hundreds of hardware callbacks. Preserve one range
            // per contiguous loss rather than spending the meeting's gap budget per callback.
            let tolerance = UInt64((2_000_000_000 / block.rate).rounded(.up))
            if let previous = gaps.last,
               let merged = Self.coalescedGap(previous, next, toleranceNanoseconds: tolerance) {
                gaps[gaps.count - 1] = merged
            } else { gaps.append(next) }
            removeHead()
        }
        return gaps
    }

    /// Match the admission jitter allowance only; never bridge a real discontinuity or epoch.
    static func coalescedGap(_ previous: MeetingAudioGap, _ next: MeetingAudioGap,
                             toleranceNanoseconds: UInt64) -> MeetingAudioGap? {
        guard previous.source == next.source, previous.epoch == next.epoch, previous.reason == next.reason,
              next.startNanoseconds >= previous.startNanoseconds else { return nil }
        let distance = next.startNanoseconds >= previous.endNanoseconds
            ? next.startNanoseconds - previous.endNanoseconds : previous.endNanoseconds - next.startNanoseconds
        guard distance <= toleranceNanoseconds else { return nil }
        return MeetingAudioGap(source: previous.source, epoch: previous.epoch,
            startNanoseconds: previous.startNanoseconds, endNanoseconds: max(previous.endNanoseconds, next.endNanoseconds),
            reason: previous.reason)
    }

    func isBacklogged(nowNanoseconds now: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard blockCount > 0, now >= blocks[blockHead].start else { return false }
        return now - blocks[blockHead].start >= Self.warningAgeNanoseconds
    }

    @discardableResult func discard(reason: MeetingAudioGapReason? = nil) -> MeetingAudioGap? {
        controlLock.lock()
        defer { controlLock.unlock() }
        close()
        lock.lock()
        let gap: MeetingAudioGap?
        if let reason, blockCount > 0 {
            gap = MeetingAudioGap(source: source, epoch: epoch, startNanoseconds: blocks[blockHead].start,
                endNanoseconds: blocks[(blockHead + blockCount - 1) % blocks.count].end, reason: reason)
        } else { gap = nil }
        lock.unlock()
        while true {
            lock.lock()
            let hasBlocks = blockCount > 0
            lock.unlock()
            guard hasBlocks else { break }
            removeHead()
        }
        // Also erase a partially copied invalid callback that was never published as a block.
        for index in 0..<sampleCapacity { samples[index] = 0 }
        return gap
    }

    deinit {
        samples.deinitialize(count: sampleCapacity)
        samples.deallocate()
    }
}
