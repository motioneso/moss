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
        var sampleOffset: UInt64 = 0
        var clockOrigin: UInt64 = 0
        var observedStart: UInt64 = 0
        var end: UInt64 {
            clockOrigin + MeetingAudioSampleClock.nanoseconds(frames: sampleOffset + UInt64(frames), sampleRate: rate)!
        }
    }

    let source: MeetingAudioSource
    let epoch: UInt64
    private let origin: UInt64
    private let lease: MeetingAudioLease?
    private let lock = NSLock()
    private let callbackFailures = MeetingAudioAtomicState()
    private let callbackDiagnostic = MeetingAudioFailureDiagnosticSlot()
    private let scopeDiagnostic = MeetingAudioFailureDiagnosticSlot()
    private let recoveryDiagnostic = MeetingAudioFailureDiagnosticSlot()
    var failureDiagnostic: MeetingAudioFailureDiagnostic? {
        if callbackFailures.value & 1 != 0 { return scopeDiagnostic.latest }
        // Reading diagnostics is allowed from an in-progress sample reader. Never enter
        // the ring lock here, and never label an undiagnosed hard failure with a soft tag.
        if callbackFailures.value & 255 != 0 { return callbackDiagnostic.latest }
        return callbackDiagnostic.latest ?? recoveryDiagnostic.latest
    }
    private let closed = MeetingAudioAtomicState()
    private let scopeVerification = MeetingAudioAtomicState()
    private let hostSourceVerification = MeetingAudioAtomicState()
    private var sourceVerificationCutoff: UInt64 = 0
    private let sendLock = NSLock()
    var isScopeVerificationPending: Bool { scopeVerification.value != 0 || hostSourceVerification.value & 1 != 0 }
    func setScopeVerificationPending(_ pending: Bool) {
        sendLock.lock()
        scopeVerification.exchange(pending ? 1 : 0)
        sendLock.unlock()
    }
    func setHostSourceVerificationPending(_ pending: Bool, confirmedAt: UInt64? = nil) {
        sendLock.lock()
        defer { sendLock.unlock() }
        let generation = hostSourceVerification.value
        guard (generation & 1 != 0) != pending else { return }
        if !pending, let confirmedAt {
            lock.lock()
            sourceVerificationCutoff = max(sourceVerificationCutoff, confirmedAt)
            lock.unlock()
        }
        // Even generations admit; odd generations quarantine. Never reuse a generation,
        // so a callback spanning a complete close/reopen cycle cannot publish stale PCM.
        guard generation < UInt32.max else { return }
        hostSourceVerification.exchange(generation + 1)
    }

    /// Only the runtime's never-offered startup epoch may use this. The separate host gate
    /// remains closed throughout; already-running copies finish before all PCM is erased.
    func discardUnsentStartupAudio() -> MeetingAudioGap? {
        controlLock.lock()
        defer { controlLock.unlock() }
        lock.lock()
        defer { lock.unlock() }
        guard hostSourceVerification.value & 1 != 0 else { return nil }
        consumeDropsLocked()
        let gap = blockCount > 0 ? MeetingAudioGap(source: source, epoch: epoch,
            startNanoseconds: blocks[blockHead].start,
            endNanoseconds: blocks[(blockHead + blockCount - 1) % blocks.count].end,
            reason: .sourceVerification) : nil
        for index in 0..<sampleCapacity { samples[index] = 0 }
        for index in blocks.indices { blocks[index] = Block() }
        sampleTail = 0
        usedSamples = 0
        blockHead = 0
        blockCount = 0
        return gap
    }

    /// Control-plane only. Scope verification and actual request initiation are ordered at
    /// this boundary, after packet copying/encoding. Audio callbacks never take this lock.
    func withSendAdmission(_ initiate: () throws -> Void) rethrows -> Bool {
        sendLock.lock()
        defer { sendLock.unlock() }
        let fault = failure
        guard !isScopeVerificationPending, fault != .invalidSelection,
              fault == nil || closed.value != 0 else { return false }
        // Closed epochs may drain valid pre-fault samples after explicit Resume/Stop. A
        // scope fault never gains that exception because its retained audio is uncertain.
        try initiate()
        return true
    }
    private let displayLevel: OpaquePointer
    private let droppedCallbacks: OpaquePointer
    private var captureGaps = [MeetingAudioGap?](repeating: nil, count: 64)
    private var captureGapCount = 0
    private let controlLock = NSLock()
    private let samples: UnsafeMutablePointer<Float>
    private let sampleCapacity: Int
    private var blocks: [Block]
    private var sampleTail = 0
    private var usedSamples = 0
    private var blockHead = 0
    private var blockCount = 0
    private var nextSequence: UInt64 = 0
    private var sampleOrigin: Double?
    private var nextSampleTime: Double?
    private var clockOrigin: UInt64 = 0
    private let permitsStartupClockRecovery: Bool
    private let monotonicNow: () -> UInt64
    private let startupClockBeganAt: UInt64
    private var recoveredStartupClock = false
    private var previousMappedEnd: UInt64 = 0
    private var previousObservedEnd: UInt64 = 0
    private var startupGapEnd: UInt64?
    private var rate: Double?
    private var sampleDiscontinuities: UInt32 = 0
    private var maximumHostClockDifferenceNanoseconds: UInt64 = 0
    private var accepting = true
    private var storedFailure: MeetingAudioFailure?

    init(source: MeetingAudioSource, epoch: UInt64, originNanoseconds: UInt64,
         sampleCapacity: Int = 2_097_152, blockCapacity: Int = 4096, lease: MeetingAudioLease? = nil,
         permitsStartupClockRecovery: Bool = false,
         monotonicNow: @escaping () -> UInt64 = MeetingCaptureClock.now) throws {
        guard epoch > 0, sampleCapacity > 0, sampleCapacity <= 11_520_000,
              blockCapacity > 0, blockCapacity <= 16384 else { throw MeetingAudioFailure.invalidSelection }
        guard let mailbox = MeetingAudioDropMailboxCreate() else { throw MeetingAudioFailure.bufferFull }
        guard let level = MeetingAudioLevelCreate() else {
            MeetingAudioDropMailboxDestroy(mailbox)
            throw MeetingAudioFailure.bufferFull
        }
        displayLevel = level
        droppedCallbacks = mailbox
        self.source = source
        self.epoch = epoch
        origin = originNanoseconds
        self.lease = lease
        self.permitsStartupClockRecovery = permitsStartupClockRecovery && source == .microphone
        self.monotonicNow = monotonicNow
        startupClockBeganAt = monotonicNow()
        self.sampleCapacity = sampleCapacity
        samples = .allocate(capacity: sampleCapacity)
        samples.initialize(repeating: 0, count: sampleCapacity)
        blocks = Array(repeating: Block(), count: blockCapacity)
    }

    /// Synthetic compatibility path. Real devices supply mSampleTime, never infer it from host jitter.
    func receive(hostTimeNanoseconds start: UInt64, sampleRate: Double, frameCount: Int,
                 sampleAt: (Int) -> Float) {
        receive(sampleTime: (Double(start) * sampleRate / 1_000_000_000).rounded(),
                hostTimeNanoseconds: start, sampleRate: sampleRate, frameCount: frameCount, sampleAt: sampleAt)
    }

    func receive(sampleTime: Double, hostTimeNanoseconds host: UInt64, sampleRate: Double,
                 frameCount: Int, sampleAt: (Int) -> Float) {
        guard closed.value == 0 else { return }
        let admissionGeneration = hostSourceVerification.value
        if admissionGeneration & 1 != 0 {
            enqueueDrop(sampleTime: sampleTime, hostTimeNanoseconds: host, sampleRate: sampleRate, frameCount: frameCount, cause: 1)
            return
        }
        guard lock.try() else {
            drop(sampleTime: sampleTime, hostTimeNanoseconds: host, sampleRate: sampleRate, frameCount: frameCount)
            return
        }
        defer { lock.unlock() }
        guard accepting, closed.value == 0, storedFailure == nil, callbackFailures.value == 0 else { return }
        guard hostSourceVerification.value == admissionGeneration else {
            enqueueDrop(sampleTime: sampleTime, hostTimeNanoseconds: host, sampleRate: sampleRate, frameCount: frameCount, cause: 1)
            return
        }
        guard consumeDropsLocked() else {
            // An earlier producer has not published its drop yet. Never advance newer PCM
            // past that ordering frontier; publish this callback as a bounded drop instead.
            drop(sampleTime: sampleTime, hostTimeNanoseconds: host, sampleRate: sampleRate, frameCount: frameCount)
            return
        }
        guard storedFailure == nil,
              let interval = advanceClockLocked(sampleTime: sampleTime, host: host, rate: sampleRate, frames: frameCount, allowStartupRecovery: true) else { return }
        // Native render can have begun before verification but reach receive after reopening.
        // Both clock views must prove the complete callback belongs after confirmation.
        guard host >= sourceVerificationCutoff, interval.start >= sourceVerificationCutoff else {
            appendCaptureGapLocked(.init(source: source, epoch: epoch, startNanoseconds: interval.start,
                endNanoseconds: interval.end, reason: .sourceVerification))
            return
        }
        guard frameCount <= sampleCapacity - usedSamples, blockCount < blocks.count,
              blockCount == 0 || (interval.end - blocks[blockHead].start <= Self.maximumAgeNanoseconds &&
                (host < blocks[blockHead].observedStart || host - blocks[blockHead].observedStart < Self.maximumAgeNanoseconds)),
              nextSequence < UInt64.max else { failLocked(.bufferFull, diagnostic: .init(.bufferCapacity)); return }
        var peak: Float = 0
        for index in 0..<frameCount {
            let value = sampleAt(index)
            guard value.isFinite else { failLocked(.invalidFormat, diagnostic: .init(.bufferSample)); return }
            samples[(sampleTail + index) % sampleCapacity] = value
            peak = max(peak, abs(value))
        }
        // A close or scope/format fault during copying cannot publish an in-flight callback.
        guard closed.value == 0, callbackFailures.value == 0 else { return }
        guard hostSourceVerification.value == admissionGeneration else {
            appendCaptureGapLocked(.init(source: source, epoch: epoch, startNanoseconds: interval.start,
                endNanoseconds: interval.end, reason: .sourceVerification))
            return
        }
        blocks[(blockHead + blockCount) % blocks.count] = Block(
            start: interval.start, rate: sampleRate, frames: frameCount, position: sampleTail, sequence: nextSequence,
            sampleOffset: interval.offset, clockOrigin: clockOrigin, observedStart: host
        )
        sampleTail = (sampleTail + frameCount) % sampleCapacity
        usedSamples += frameCount
        blockCount += 1
        nextSequence += 1
        MeetingAudioLevelStore(displayLevel, peak, host)
    }

    /// UI-only snapshot; closed/faulted epochs never display retained pre-pause audio as live.
    func capturedLevel(at now: UInt64) -> Float {
        guard closed.value == 0, callbackFailures.value == 0, !isScopeVerificationPending else { return 0 }
        return MeetingAudioLevelRead(displayLevel, now)
    }

    func drop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int) {
        enqueueDrop(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate,
            frameCount: frameCount, cause: hostSourceVerification.value & 1 != 0 ? 1 : 0)
    }

    private func enqueueDrop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double,
                             frameCount: Int, cause: UInt32) {
        guard closed.value == 0 else { return }
        guard frameCount > 0, frameCount <= Self.maximumCallbackFrames else { fail(.invalidFormat, diagnostic: .init(.bufferDropFrames)); return }
        guard sampleRate.isFinite, (8000...192000).contains(sampleRate), sampleRate.rounded() == sampleRate else {
            fail(.invalidFormat, diagnostic: .init(.bufferFormat)); return
        }
        guard sampleTime.isFinite, sampleTime.rounded() == sampleTime,
              abs(sampleTime) <= 9_007_199_254_732_800, hostTimeNanoseconds >= origin,
              let duration = MeetingAudioSampleClock.nanoseconds(frames: UInt64(frameCount), sampleRate: sampleRate),
              hostTimeNanoseconds <= UInt64.max - duration else {
            fail(.invalidTimestamp, diagnostic: .init(.bufferTimestamp)); return
        }
        let record = MeetingAudioDropRecord(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds,
                                           sampleRate: sampleRate, frameCount: UInt32(frameCount),
            cause: cause, maximumFrameCount: UInt32(frameCount), observedEndNanoseconds: 0, firstFrameCount: UInt32(frameCount))
        if !MeetingAudioDropMailboxPush(droppedCallbacks, record) {
            callbackDiagnostic.store(.init(.bufferDropMailbox))
            callbackFailures.insert(8)
        }
    }

    /// The first measured hardware timestamp anchors the sample clock to the monotonic host clock.
    /// All later boundaries use cumulative samples. Host scheduling jitter is not lost audio.
    /// Observed host timestamps are retained separately and also constrain Stop trimming.
    private func advanceClockLocked(sampleTime: Double, host: UInt64, rate sampleRate: Double,
                                    frames: Int, maximumFrameCount: Int? = nil, firstFrameCount: Int? = nil, measuredEnd: UInt64? = nil, allowStartupRecovery: Bool = false) -> (start: UInt64, end: UInt64, offset: UInt64)? {
        guard sampleRate.isFinite, (8000...192000).contains(sampleRate), sampleRate.rounded() == sampleRate,
              frames > 0,
              maximumFrameCount.map({ $0 > 0 && $0 <= Self.maximumCallbackFrames && frames >= $0 && frames <= 11_520_000 })
                ?? (frames <= Self.maximumCallbackFrames),
              firstFrameCount.map({ $0 > 0 && $0 <= (maximumFrameCount ?? frames) }) ?? true else { failLocked(.invalidFormat, diagnostic: .init(.bufferFormat)); return nil }
        guard sampleTime.isFinite, sampleTime.rounded() == sampleTime,
              abs(sampleTime) <= 9_007_199_254_732_800, host >= origin,
              let duration = MeetingAudioSampleClock.nanoseconds(frames: UInt64(frames), sampleRate: sampleRate),
              host <= UInt64.max - duration else { failLocked(.invalidTimestamp, diagnostic: .init(.bufferTimestamp)); return nil }
        let observedEnd = max(host + duration, measuredEnd ?? 0)
        let callbackDuration = MeetingAudioSampleClock.nanoseconds(
            frames: UInt64(firstFrameCount ?? frames), sampleRate: sampleRate)!
        // All arithmetic, authorization and trusted-clock checks precede recoverable
        // classification. A valid rate alone cannot turn malformed timing into a restart.
        let now = monotonicNow()
        guard now >= startupClockBeganAt else {
            failLocked(.invalidTimestamp, diagnostic: .init(.bufferTimestamp)); return nil
        }
        let changesClock = (rate.map { $0 != sampleRate } ?? false) ||
            (nextSampleTime.map { $0 != sampleTime } ?? false)
        if changesClock, let lease, observedEnd > lease.deadline {
            failLocked(.leaseExpired, diagnostic: .init(.bufferLease)); return nil
        }
        if let rate, rate != sampleRate {
            guard host >= previousObservedEnd else {
                failLocked(.invalidTimestamp, diagnostic: .init(.bufferTimestamp)); return nil
            }
            // The old counter cannot be mapped using the new rate. Only the valid
            // observed interval is evidence here; fresh PCM needs a new epoch.
            failLocked(.sourceReconfigured, diagnostic: .init(.bufferFormat)); return nil
        }
        if let first = sampleOrigin, sampleTime >= first {
            let offset = UInt64(sampleTime - first)
            guard let endOffset = MeetingAudioSampleClock.nanoseconds(frames: offset + UInt64(frames), sampleRate: sampleRate),
                  clockOrigin <= UInt64.max - endOffset else {
                failLocked(.invalidTimestamp, diagnostic: .init(.bufferClockRange)); return nil
            }
        }
        if sampleOrigin == nil {
            var segmentOrigin = host
            if let gapEnd = startupGapEnd {
                // The successor starts a separate clock segment. Never move already accepted
                // audio, overlap the discarded callback, or reinterpret its sample counter.
                let now = monotonicNow()
                guard now >= startupClockBeganAt, now - startupClockBeganAt <= 500_000_000,
                      Self.withinStartupSlack(host: host, boundary: gapEnd, callbackDuration: callbackDuration),
                      max(host, gapEnd) - origin <= 500_000_000 else {
                    failLocked(.invalidTimestamp, diagnostic: .init(.bufferSampleContinuity)); return nil
                }
                segmentOrigin = max(host, gapEnd)
                if segmentOrigin > gapEnd {
                    appendCaptureGapLocked(.init(source: source, epoch: epoch, startNanoseconds: gapEnd,
                        endNanoseconds: segmentOrigin, reason: .startupTimestamp))
                }
                startupGapEnd = nil
            }
            sampleOrigin = sampleTime
            clockOrigin = segmentOrigin
        }
        guard nextSampleTime.map({ sampleTime == $0 }) ?? true,
              let first = sampleOrigin, sampleTime >= first else {
            if sampleDiscontinuities < UInt32.max { sampleDiscontinuities += 1 }
            if allowStartupRecovery, recoverStartupClockLocked(host: host, observedEnd: observedEnd, callbackDuration: callbackDuration) { return nil }
            // A new epoch may anchor a valid reset; it must never reinterpret this
            // epoch's audio or relax the startup-only in-place recovery window.
            failLocked(host >= previousObservedEnd ? .sourceReconfigured : .invalidTimestamp,
                diagnostic: .init(.bufferSampleContinuity))
            return nil
        }
        let offset = UInt64(sampleTime - first)
        guard let startOffset = MeetingAudioSampleClock.nanoseconds(frames: offset, sampleRate: sampleRate),
              let endOffset = MeetingAudioSampleClock.nanoseconds(frames: offset + UInt64(frames), sampleRate: sampleRate),
              clockOrigin <= UInt64.max - endOffset else { failLocked(.invalidTimestamp, diagnostic: .init(.bufferClockRange)); return nil }
        if let lease {
            let deadline = lease.deadline
            guard observedEnd <= deadline, clockOrigin + endOffset <= deadline else {
                failLocked(.leaseExpired, diagnostic: .init(.bufferLease))
                return nil
            }
        }
        let mappedStart = clockOrigin + startOffset
        let clockDifference = host >= mappedStart ? host - mappedStart : mappedStart - host
        maximumHostClockDifferenceNanoseconds = max(maximumHostClockDifferenceNanoseconds, clockDifference)
        rate = sampleRate
        nextSampleTime = sampleTime + Double(frames)
        previousMappedEnd = clockOrigin + endOffset
        previousObservedEnd = max(previousObservedEnd, observedEnd)
        return (clockOrigin + startOffset, clockOrigin + endOffset, offset)
    }

    /// One otherwise-valid microphone counter reset may occur while the device settles.
    /// Both a trusted monotonic clock and the observed callback bound this to 500 ms;
    /// all format, range, lease, closed-admission and subsequent continuity checks remain strict.
    private static func withinStartupSlack(host: UInt64, boundary: UInt64, callbackDuration: UInt64) -> Bool {
        host >= boundary || boundary - host <= min(callbackDuration, 20_000_000)
    }

    var hasRecoveredStartupClock: Bool {
        lock.lock()
        defer { lock.unlock() }
        return recoveredStartupClock
    }

    private func recoverStartupClockLocked(host: UInt64, observedEnd: UInt64, callbackDuration: UInt64) -> Bool {
        guard permitsStartupClockRecovery, !recoveredStartupClock else { return false }
        let began = startupClockBeganAt
        let now = monotonicNow()
        let boundary = max(previousMappedEnd, previousObservedEnd)
        guard now >= began, now - began <= 500_000_000,
              host >= origin, observedEnd - origin <= 500_000_000,
              Self.withinStartupSlack(host: host, boundary: boundary, callbackDuration: callbackDuration),
              max(boundary, observedEnd) - origin <= 500_000_000,
              lease.map({ max(boundary, observedEnd) <= $0.deadline }) ?? true else { return false }
        recoveredStartupClock = true
        sampleOrigin = nil
        nextSampleTime = nil
        let end = max(boundary, observedEnd)
        startupGapEnd = end
        if end > previousMappedEnd {
            appendCaptureGapLocked(.init(source: source, epoch: epoch, startNanoseconds: previousMappedEnd,
                endNanoseconds: end, reason: .startupTimestamp))
        }
        return true
    }

    private func appendCaptureGapLocked(_ gap: MeetingAudioGap) {
        if captureGapCount > 0, let previous = captureGaps[captureGapCount - 1],
           let merged = Self.coalescedGap(previous, gap, toleranceNanoseconds: 0) {
            captureGaps[captureGapCount - 1] = merged
        } else if captureGapCount < captureGaps.count {
            captureGaps[captureGapCount] = gap
            captureGapCount += 1
        } else { failLocked(.bufferFull, diagnostic: .init(.bufferGapCapacity)) }
    }

    /// Called only with the admission lock. The C mailbox has one consumer and bounded producers.
    @discardableResult private func consumeDropsLocked() -> Bool {
        var record = MeetingAudioDropRecord()
        for _ in 0..<64 {
            let status = MeetingAudioDropMailboxPopForClock(droppedCallbacks, nextSampleTime ?? 0, nextSampleTime != nil, &record)
            if status == 0 { return true }
            if status != 1 { return false }
            guard storedFailure == nil,
                  let interval = advanceClockLocked(sampleTime: record.sampleTime, host: record.hostTimeNanoseconds,
                                                    rate: record.sampleRate, frames: Int(record.frameCount),
                                                    maximumFrameCount: Int(record.maximumFrameCount), firstFrameCount: Int(record.firstFrameCount), measuredEnd: record.observedEndNanoseconds,
                                                    allowStartupRecovery: true) else { continue }
            let gap = MeetingAudioGap(source: source, epoch: epoch, startNanoseconds: interval.start,
                                      endNanoseconds: interval.end, reason: record.cause == 1 ? .sourceVerification : .callbackContention)
            appendCaptureGapLocked(gap)
        }
        return false
    }

    /// Control plane, including after close: a dropped final callback remains visible without a successor.
    func drainCaptureGaps(cutoffNanoseconds: UInt64? = nil) -> [MeetingAudioGap] {
        lock.lock()
        defer { lock.unlock() }
        consumeDropsLocked()
        var result: [MeetingAudioGap] = []
        for index in 0..<captureGapCount {
            if let gap = captureGaps[index] {
                let end = min(gap.endNanoseconds, cutoffNanoseconds ?? UInt64.max)
                if gap.startNanoseconds < end {
                    result.append(MeetingAudioGap(source: source, epoch: epoch,
                        startNanoseconds: gap.startNanoseconds, endNanoseconds: end, reason: gap.reason))
                }
            }
            captureGaps[index] = nil
        }
        captureGapCount = 0
        return result
    }

    func fail(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic) {
        if failure == .invalidSelection { scopeDiagnostic.store(diagnostic) }
        else if failure == .sourceReconfigured { recoveryDiagnostic.store(diagnostic) }
        else { callbackDiagnostic.store(diagnostic) }
        fail(failure)
    }

    func fail(_ failure: MeetingAudioFailure) {
        // Reporting a real fault is independent of lock availability. Scope failure always wins.
        let bit: UInt32
        switch failure {
        case .invalidSelection: bit = 1
        case .invalidFormat: bit = 2
        case .invalidTimestamp: bit = 4
        case .bufferFull: bit = 8
        case .deviceFailure: bit = 16
        case .invalidTransition: bit = 32
        case .cleanupFailed: bit = 64
        case .leaseExpired: bit = 128
        case .sourceReconfigured: bit = 256
        }
        callbackFailures.insert(bit)
        guard lock.try() else { return }
        defer { lock.unlock() }
        failLocked(failure)
    }

    private func failLocked(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic? = nil) {
        if let diagnostic {
            if failure == .sourceReconfigured { recoveryDiagnostic.store(diagnostic) }
            else { callbackDiagnostic.store(diagnostic) }
        }
        if storedFailure == nil || (storedFailure == .sourceReconfigured && failure != .sourceReconfigured) {
            storedFailure = failure
        }
        accepting = false
    }

    var failure: MeetingAudioFailure? {
        lock.lock()
        defer { lock.unlock() }
        if startupGapEnd != nil, closed.value == 0, storedFailure == nil {
            let now = monotonicNow()
            if now < startupClockBeganAt || now - startupClockBeganAt > 500_000_000 {
                failLocked(.invalidTimestamp, diagnostic: .init(.bufferSampleContinuity))
            }
        }
        let flags = callbackFailures.value
        if flags & 1 != 0 { return .invalidSelection }
        if let storedFailure, storedFailure != .sourceReconfigured { return storedFailure }
        if flags & 2 != 0 { return .invalidFormat }
        if flags & 4 != 0 { return .invalidTimestamp }
        if flags & 8 != 0 { return .bufferFull }
        if flags & 16 != 0 { return .deviceFailure(operation: "audio-callback", status: -1) }
        if flags & 32 != 0 { return .invalidTransition }
        if flags & 64 != 0 { return .cleanupFailed }
        if flags & 128 != 0 { return .leaseExpired }
        if flags & 256 != 0 || storedFailure == .sourceReconfigured { return .sourceReconfigured }
        return nil
    }

    /// Gaps use the same immutable mapped clock as accepted PCM. Observed host
    /// timing separately constrains cutoff admission; jitter cannot overlap the tail.
    var recoveryBoundaryNanoseconds: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return max(origin, previousMappedEnd)
    }

    struct Diagnostics: Equatable {
        let sampleRate: Double?
        let effectiveCapacityNanoseconds: UInt64?
        let bufferedSamples: Int
        let bufferedCallbacks: Int
        let acceptedCallbacks: UInt64
        let droppedCallbacks: UInt32
        let dropMailboxOverflows: UInt32
        let sampleDiscontinuities: UInt32
        let maximumHostClockDifferenceNanoseconds: UInt64
    }

    /// Content-free counters, read off the realtime path. Active-producer counts are approximate.
    var diagnostics: Diagnostics {
        lock.lock()
        defer { lock.unlock() }
        let drops = MeetingAudioDropMailboxReadCounts(droppedCallbacks)
        return Diagnostics(sampleRate: rate,
            effectiveCapacityNanoseconds: rate.map { Self.effectiveCapacityNanoseconds(sampleRate: $0, sampleCapacity: sampleCapacity) },
            bufferedSamples: usedSamples, bufferedCallbacks: blockCount, acceptedCallbacks: nextSequence,
            droppedCallbacks: drops.accepted, dropMailboxOverflows: drops.rejected,
            sampleDiscontinuities: sampleDiscontinuities,
            maximumHostClockDifferenceNanoseconds: maximumHostClockDifferenceNanoseconds)
    }

    /// Closes admission before the caller stops the device; later callbacks cannot refill the ring.
    func close() {
        closed.insert(1)
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
        var discontinuity = false
        for offset in 0..<blockCount {
            let block = blocks[(blockHead + offset) % blocks.count]
            guard block.clockOrigin == first.clockOrigin,
                  block.sampleOffset == first.sampleOffset + UInt64(total) else { discontinuity = true; break }
            var count = block.frames
            if let cutoff = cutoffNanoseconds {
                guard cutoff > block.start, cutoff > block.observedStart else { break }
                let available = (Double(cutoff - block.observedStart) * block.rate / 1_000_000_000).rounded(.down)
                if available < Double(count) { count = max(0, Int(available)) }
                while count > 0 {
                    let end = first.clockOrigin + MeetingAudioSampleClock.nanoseconds(
                        frames: first.sampleOffset + UInt64(total + count), sampleRate: first.rate)!
                    let observedEnd = block.observedStart + MeetingAudioSampleClock.nanoseconds(
                        frames: UInt64(count), sampleRate: block.rate)!
                    if end <= cutoff && observedEnd <= cutoff { break }
                    count -= 1
                }
            }
            guard count > 0 else { break }
            selected.append((block, count))
            total += count
            if total >= targetFrames || count < block.frames { break }
        }
        lock.unlock()
        guard total > 0, allowPartial || discontinuity || total >= targetFrames, let last = selected.last else { return nil }
        var copy = [Float]()
        copy.reserveCapacity(total)
        for (block, count) in selected {
            for index in 0..<count { copy.append(samples[(block.position + index) % sampleCapacity]) }
        }
        return Chunk(packet: MeetingAudioPacket(source: source, epoch: epoch, sequence: first.sequence,
            startNanoseconds: first.start, sampleRate: first.rate, samples: copy,
            timelineOriginNanoseconds: first.clockOrigin, sampleOffset: first.sampleOffset), throughSequence: last.0.sequence)
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

    /// Never bridge a real discontinuity or epoch. Callers choose rounding tolerance explicitly.
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
        let warning = min(Self.warningAgeNanoseconds,
                          Self.effectiveCapacityNanoseconds(sampleRate: blocks[blockHead].rate, sampleCapacity: sampleCapacity) / 2)
        return now - blocks[blockHead].start >= warning || usedSamples >= sampleCapacity - sampleCapacity / 4 ||
            blockCount >= blocks.count - blocks.count / 4
    }

    static func effectiveCapacityNanoseconds(sampleRate: Double, sampleCapacity: Int = 2_097_152) -> UInt64 {
        guard sampleCapacity > 0,
              let capacity = MeetingAudioSampleClock.nanoseconds(frames: UInt64(sampleCapacity), sampleRate: sampleRate) else { return 0 }
        return min(maximumAgeNanoseconds, capacity)
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
        MeetingAudioLevelDestroy(displayLevel)
        MeetingAudioDropMailboxDestroy(droppedCallbacks)
        samples.deinitialize(count: sampleCapacity)
        samples.deallocate()
    }
}
