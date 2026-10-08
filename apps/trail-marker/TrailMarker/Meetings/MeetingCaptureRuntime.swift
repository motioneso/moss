import Foundation

/// Serial lifecycle with synchronous send admission.
/// Host wiring must call service regularly to surface callback faults and expiry; it must also
/// connect device/process changes, Pause All, account changes and termination before enabling Start.
final class MeetingCaptureRuntime {
    typealias DeviceFactory = (MeetingNativeSelection) throws -> [MeetingAudioSource: MeetingAudioCapturing]
    private struct PendingSource {
        let buffer: MeetingAudioBuffer
        var cutoff: UInt64?
        var inFlightSequence: UInt64?
        var offeredChunk: MeetingAudioBuffer.Chunk?
    }

    private let queue = DispatchQueue(label: "com.moss.meeting.capture-control")
    private let factory: DeviceFactory
    private let reportCaptureFailure: (String) -> Void
    private let captureLease = MeetingAudioLease()
    private var machine = MeetingCaptureMachine()
    private var devices: [MeetingAudioSource: MeetingAudioCapturing] = [:]
    private var pending: [PendingSource] = []
    private var retainedGaps: [MeetingAudioGap] = []
    private var epochStart: UInt64 = 0
    private var currentEpochEverOffered = false
    private var startupSourceRecheckUsed = false
    private var nextSessionEpoch: UInt64 = 1
    private var dispatchCursor = 0
    private var hadExpiredAudio = false
    private var pauseBoundary: (at: UInt64, epoch: UInt64, sources: [MeetingAudioSource])?

    convenience init(factory: @escaping DeviceFactory) {
        self.init(factory: factory, reportCaptureFailure: MeetingAudioFailureDiagnostic.log)
    }

    init(factory: @escaping DeviceFactory, reportCaptureFailure: @escaping (String) -> Void) {
        self.factory = factory
        self.reportCaptureFailure = reportCaptureFailure
    }

    func updateCaptureLease(until deadline: UInt64) { captureLease.update(deadline: deadline) }

    var snapshot: MeetingCaptureMachine { queue.sync { machine } }
    var isAwaitingOutputAudio: Bool {
        queue.sync {
            guard machine.state == .recording, machine.selection?.output != nil else { return false }
            guard let output = pending.first(where: { $0.buffer.epoch == machine.epoch && $0.buffer.source == .output }) else { return true }
            return output.buffer.diagnostics.acceptedCallbacks == 0
        }
    }
    /// Read by the presentation tick only. Never enters upload bodies or diagnostics.
    func capturedLevel(at now: UInt64) -> Float {
        queue.sync {
            guard machine.state == .recording else { return 0 }
            return pending.filter { $0.buffer.epoch == machine.epoch && $0.cutoff == nil }
                .map { $0.buffer.capturedLevel(at: now) }.max() ?? 0
        }
    }
    var audioDiagnostics: [MeetingAudioSource: MeetingAudioBuffer.Diagnostics] {
        queue.sync {
            Dictionary(uniqueKeysWithValues: pending.filter { $0.buffer.epoch == machine.epoch }
                .map { ($0.buffer.source, $0.buffer.diagnostics) })
        }
    }

    func isBacklogged(at now: UInt64) -> Bool {
        queue.sync { pending.contains { $0.buffer.isBacklogged(nowNanoseconds: now) } }
    }

    func prepare(selection: MeetingNativeSelection, readiness: MeetingNativeReadiness, at: UInt64) throws {
        try queue.sync { try machine.prepare(selection: selection, readiness: readiness, at: at) }
    }

    func start(readiness: MeetingNativeReadiness, at: UInt64) throws {
        try queue.sync {
            var candidate = machine
            try candidate.start(readiness: readiness, at: at, initialEpoch: nextSessionEpoch)
            try startDevices(candidate: candidate, at: at)
        }
    }

    func resume(selection: MeetingNativeSelection, readiness: MeetingNativeReadiness,
                permitRetainedAudio: Bool, at: UInt64) throws {
        try queue.sync {
            guard devices.isEmpty else { throw MeetingAudioFailure.cleanupFailed }
            var candidate = machine
            try candidate.resume(selection: selection, readiness: readiness, permitRetainedAudio: permitRetainedAudio, at: at)
            if !permitRetainedAudio {
                for entry in pending {
                    if let gap = entry.buffer.discard(reason: .retentionDeclined) { retainedGaps.append(gap) }
                }
                pending.removeAll()
            }
            try startDevices(candidate: candidate, at: at)
            if let pause = pauseBoundary, at > pause.at {
                retainedGaps.append(contentsOf: pause.sources.map { source in
                    MeetingAudioGap(source: source, epoch: pause.epoch, startNanoseconds: pause.at,
                                    endNanoseconds: at, reason: .paused)
                })
            }
            pauseBoundary = nil
        }
    }

    private func startDevices(candidate: MeetingCaptureMachine, at: UInt64) throws {
        guard devices.isEmpty, let selection = candidate.selection else { throw MeetingAudioFailure.invalidTransition }
        // At most sixteen retained source rings: 128 MiB of preallocated Float32 sample storage.
        // Empty acknowledged epochs are pruned before allocating another pair.
        pruneClosedSources()
        guard pending.count <= 14 else { throw MeetingAudioFailure.bufferFull }
        let created = try factory(selection)
        let expected = selection.sources
        guard Set(created.keys) == expected else { throw MeetingAudioFailure.invalidSelection }
        let sourceOrder = MeetingAudioSource.allCases.filter { expected.contains($0) }
        let fresh = try sourceOrder.map { source in
            PendingSource(buffer: try MeetingAudioBuffer(source: source, epoch: candidate.epoch, originNanoseconds: at, lease: captureLease,
                permitsStartupClockRecovery: source == .microphone),
                          cutoff: nil, inFlightSequence: nil, offeredChunk: nil)
        }
        devices = created
        var startingSource: MeetingAudioSource?
        do {
            for entry in fresh {
                guard let device = devices[entry.buffer.source] else { throw MeetingAudioFailure.invalidSelection }
                startingSource = entry.buffer.source
                try device.start(into: entry.buffer)
                if let failure = entry.buffer.failure { throw failure }
            }
            pending.append(contentsOf: fresh)
            machine = candidate
            epochStart = at
            startupSourceRecheckUsed = false
            currentEpochEverOffered = false
        } catch {
            if let source = startingSource, let entry = fresh.first(where: { $0.buffer.source == source }) {
                reportCaptureFailure(MeetingAudioFailureDiagnostic.message(source: source, failure: error,
                    diagnostic: entry.buffer.failureDiagnostic ?? .init(.captureStart)))
            }
            fresh.forEach { $0.buffer.close(); $0.buffer.discard() }
            machine.fail()
            do { try stopDevices() } catch { throw MeetingAudioFailure.cleanupFailed }
            throw error
        }
    }

    /// One missing-metadata retry is allowed only before this startup epoch ever offered PCM.
    /// Positive source changes are rejected by the host before reaching this quarantine.
    func beginStartupSourceRecheck(at: UInt64) -> Bool {
        queue.sync {
            guard machine.state == .recording, !startupSourceRecheckUsed,
                  at >= epochStart, at - epochStart <= 500_000_000,
                  !currentEpochEverOffered else { return false }
            startupSourceRecheckUsed = true
            let current = pending.filter { $0.buffer.epoch == machine.epoch && $0.cutoff == nil }
            guard !current.isEmpty, current.allSatisfy({ $0.buffer.failure == nil }) else { return false }
            current.forEach { $0.buffer.setHostSourceVerificationPending(true) }
            for entry in current {
                if let gap = entry.buffer.discardUnsentStartupAudio() { retainedGaps.append(gap) }
            }
            return current.allSatisfy { $0.buffer.failure == nil }
        }
    }

    func finishStartupSourceRecheck(at: UInt64, unchanged: Bool) -> Bool {
        queue.sync {
            let current = pending.filter { $0.buffer.epoch == machine.epoch && $0.cutoff == nil }
            guard unchanged, startupSourceRecheckUsed, machine.state == .recording, at >= epochStart, at - epochStart <= 500_000_000,
                  !current.isEmpty, current.allSatisfy({ $0.buffer.failure == nil }) else { return false }
            current.forEach { $0.buffer.setHostSourceVerificationPending(false, confirmedAt: at) }
            return true
        }
    }

    func pause(at: UInt64, captureCutoffNanoseconds: UInt64? = nil) throws {
        try queue.sync {
            try machine.pause(at: at)
            let cutoff = min(at, captureCutoffNanoseconds ?? at)
            rememberPause(at: cutoff)
            closeCurrentEpoch(at: cutoff)
            applyCutoff(cutoff, epoch: machine.epoch)
            do { try stopDevices() } catch { machine.fail(); throw error }
        }
    }

    func stop(at: UInt64, finalizationNanoseconds: UInt64 = 60_000_000_000,
              captureCutoffNanoseconds: UInt64? = nil) throws {
        try queue.sync {
            let alreadyStopped = machine.stopCutoffNanoseconds != nil
            try machine.stop(at: at, finalizationNanoseconds: finalizationNanoseconds,
                             captureCutoffNanoseconds: captureCutoffNanoseconds)
            if alreadyStopped, let cutoff = captureCutoffNanoseconds { try machine.tightenStopCutoff(to: cutoff) }
            if !alreadyStopped || captureCutoffNanoseconds != nil,
               let cutoff = machine.stopCutoffNanoseconds { applyStopCutoff(cutoff) }
            // A replay still retries incomplete device cleanup, without extending the cutoff.
            try stopDevices()
        }
    }

    /// A server's authoritative cutoff may arrive after local Stop. It may only tighten scope.
    func tightenStopCutoff(to cutoff: UInt64) throws {
        try queue.sync {
            try machine.tightenStopCutoff(to: cutoff)
            if let actual = machine.stopCutoffNanoseconds { applyStopCutoff(actual) }
        }
    }

    func tightenPauseCutoff(to cutoff: UInt64) {
        queue.sync {
            guard machine.state == .paused || machine.state == .stopping else { return }
            applyCutoff(cutoff, epoch: machine.epoch)
            if let pause = pauseBoundary { pauseBoundary = (min(pause.at, cutoff), pause.epoch, pause.sources) }
        }
    }

    private func applyStopCutoff(_ cutoff: UInt64) { applyCutoff(cutoff, epoch: nil) }

    private func applyCutoff(_ cutoff: UInt64, epoch: UInt64?) {
        for index in pending.indices where epoch == nil || pending[index].buffer.epoch == epoch {
            pending[index].buffer.close()
            pending[index].cutoff = min(pending[index].cutoff ?? cutoff, cutoff)
            if let offered = pending[index].offeredChunk, offered.packet.endNanoseconds > cutoff {
                // Never retry different bytes under an already-offered identity. In-flight work
                // cannot be recalled; the server independently enforces its authoritative cutoff.
                _ = pending[index].buffer.acknowledge(sequence: offered.packet.sequence,
                                                     throughSequence: offered.throughSequence)
                retainedGaps.append(MeetingAudioGap(source: offered.packet.source, epoch: offered.packet.epoch,
                    startNanoseconds: offered.packet.startNanoseconds, endNanoseconds: offered.packet.endNanoseconds,
                    reason: .cutoffChanged))
                pending[index].offeredChunk = nil
                pending[index].inFlightSequence = nil
            }
        }
    }

    /// The host splits the pause gap at the authoritative source-selection boundary.
    /// No old-source gap may extend into the replacement selection's epoch.
    func clearPauseGapForSourceChange() { queue.sync { pauseBoundary = nil } }

    private func rememberPause(at: UInt64) {
        let sources = MeetingAudioSource.allCases.filter { machine.selection?.sources.contains($0) == true }
        pauseBoundary = (at, machine.epoch, sources)
    }

    private func closeCurrentEpoch(at: UInt64) {
        for index in pending.indices where pending[index].cutoff == nil {
            pending[index].buffer.close()
            pending[index].cutoff = at
        }
    }

    private func pruneClosedSources() {
        pending.removeAll { entry in
            guard entry.cutoff != nil, entry.buffer.peek(cutoffNanoseconds: entry.cutoff) == nil else { return false }
            entry.buffer.discard()
            return true
        }
    }

    private func stopDevices() throws {
        var failed = false
        // Always attempt both sources, even when one refuses to stop. Retain failed handles.
        for source in MeetingAudioSource.allCases.reversed() {
            if let device = devices[source] {
                do { try device.stop(); devices[source] = nil } catch { failed = true }
            }
        }
        if failed { throw MeetingAudioFailure.cleanupFailed }
    }

    /// Called on the host's bounded service tick and before every send. Returns events for UI/storage.
    /// No reconnect or service tick can activate a source or resume recording.
    func service(at: UInt64) throws -> [MeetingAudioGap] {
        try queue.sync { try serviceLocked(at: at) }
    }

    private func serviceLocked(at: UInt64) throws -> [MeetingAudioGap] {
        try machine.observeTime(at)
        var gaps = retainedGaps
        retainedGaps.removeAll(keepingCapacity: true)
        if machine.state == .recording,
           let failed = pending.first(where: { $0.cutoff == nil && $0.buffer.failure != nil }),
           let reason = failed.buffer.failure {
            reportCaptureFailure(MeetingAudioFailureDiagnostic.message(source: failed.buffer.source, failure: reason,
                diagnostic: failed.buffer.failureDiagnostic))
            try machine.pause(at: at)
            rememberPause(at: at)
            closeCurrentEpoch(at: at)
            gaps.append(MeetingAudioGap(source: failed.buffer.source, epoch: failed.buffer.epoch,
                startNanoseconds: epochStart, endNanoseconds: at,
                reason: reason == .bufferFull ? .bufferFull : .captureFailure(reason)))
            if failed.buffer.source == .output, reason == .invalidSelection {
                // The new process may have rendered before its list notification. Do not
                // flush queued audio from an exclusion scope whose membership is uncertain.
                for entry in pending where entry.buffer.epoch == machine.epoch { entry.buffer.discard() }
                pending.removeAll { $0.buffer.epoch == machine.epoch }
            }
            do { try stopDevices() } catch {
                machine.fail()
                retainedGaps = gaps
                throw error
            }
        }
        var lostUnknownReceipt = false
        for index in pending.indices {
            gaps.append(contentsOf: pending[index].buffer.drainCaptureGaps(cutoffNanoseconds: pending[index].cutoff))
            let expired = pending[index].buffer.expire(nowNanoseconds: at)
            if !expired.isEmpty { hadExpiredAudio = true }
            gaps.append(contentsOf: expired)
            if let offered = pending[index].offeredChunk,
               pending[index].buffer.peek(cutoffNanoseconds: pending[index].cutoff)?.sequence != offered.packet.sequence {
                // Receipt outcome is unknown after expiry. A later packet cannot reuse or
                // guess the server's sequence cursor. Retire this source's remaining tail,
                // visibly; explicit Resume creates a new source epoch with a fresh cursor.
                lostUnknownReceipt = true
                if let gap = pending[index].buffer.discard(reason: .retentionDeclined) { gaps.append(gap) }
                pending[index].cutoff = min(pending[index].cutoff ?? at, at)
                pending[index].inFlightSequence = nil
                pending[index].offeredChunk = nil
            }
        }
        if lostUnknownReceipt, machine.state == .recording {
            try machine.pause(at: at)
            rememberPause(at: at)
            closeCurrentEpoch(at: at)
            do { try stopDevices() } catch { machine.fail(); retainedGaps = gaps; throw error }
        }
        pruneClosedSources()
        if machine.state == .stopping, let deadline = machine.finalizationDeadlineNanoseconds, at >= deadline {
            let drained = pending.allSatisfy { $0.buffer.peek(cutoffNanoseconds: $0.cutoff) == nil }
            guard devices.isEmpty else { retainedGaps = gaps; throw MeetingAudioFailure.cleanupFailed }
            try machine.finish(at: at, drained: drained, expiredAudio: hadExpiredAudio)
            pending.forEach { $0.buffer.discard() }
            pending.removeAll()
        }
        return gaps
    }

    /// The closure must initiate a send synchronously and return; never await or call this runtime
    /// from it. Queue serialization makes Pause and NEW send initiation mutually ordered.
    /// Caller may keep the bounded packet for an in-flight request only; received receipts release it.
    func dispatchNext(at: UInt64, initiate: (MeetingAudioPacket) -> Void) throws -> Bool {
        try dispatch(at: at, targetDurationNanoseconds: nil, latestEndNanoseconds: nil,
                     eligibleSources: Set(MeetingAudioSource.allCases), initiate: { packet, _ in initiate(packet) })
    }

    /// Real upload path: coalesce five seconds by default, retaining the exact packet on retry.
    /// Whole callbacks may extend the target by at most 8192 frames (1.024s at 8kHz), below
    /// the ten-second wire cap. The 2,097,152-sample ring leaves receipt/clock headroom even
    /// at 192kHz; it is still a byte cap, not a promise of sixty seconds of retained audio.
    func dispatchNextChunk(at: UInt64, targetDurationNanoseconds: UInt64 = 5_000_000_000,
                           latestEndNanoseconds: UInt64? = nil, eligibleSources: Set<MeetingAudioSource> = Set(MeetingAudioSource.allCases), initiate: (MeetingAudioPacket) -> Void) throws -> Bool {
        guard (1...5_000_000_000).contains(targetDurationNanoseconds) else {
            throw MeetingAudioFailure.invalidSelection
        }
        return try dispatch(at: at, targetDurationNanoseconds: targetDurationNanoseconds,
                            latestEndNanoseconds: latestEndNanoseconds, eligibleSources: eligibleSources, initiate: { packet, _ in initiate(packet) })
    }

    func dispatchNextChunkWithAdmission(at: UInt64, targetDurationNanoseconds: UInt64 = 5_000_000_000,
                                        latestEndNanoseconds: UInt64? = nil,
                                        eligibleSources: Set<MeetingAudioSource> = Set(MeetingAudioSource.allCases),
                                        initiate: (MeetingAudioPacket, MeetingAudioBuffer) -> Void) throws -> Bool {
        guard (1...5_000_000_000).contains(targetDurationNanoseconds) else { throw MeetingAudioFailure.invalidSelection }
        return try dispatch(at: at, targetDurationNanoseconds: targetDurationNanoseconds,
                            latestEndNanoseconds: latestEndNanoseconds, eligibleSources: eligibleSources, initiate: initiate)
    }

    private func dispatch(at: UInt64, targetDurationNanoseconds: UInt64?, latestEndNanoseconds: UInt64?,
                          eligibleSources: Set<MeetingAudioSource>, initiate: (MeetingAudioPacket, MeetingAudioBuffer) -> Void) throws -> Bool {
        try queue.sync {
            let gaps = try serviceLocked(at: at)
            retainedGaps = gaps
            guard !pending.isEmpty else { return false }
            // Recovery makes a short first clock segment sendable. Hold it (and its paired
            // source) until startup ends, so a same-Start inventory omission can still be
            // quarantined before any uncertain epoch audio has escaped.
            let holdStartupOffers = machine.state == .recording && at >= epochStart && at - epochStart < 500_000_000 &&
                pending.contains { $0.buffer.epoch == machine.epoch && $0.buffer.source == .microphone && $0.buffer.hasRecoveredStartupClock }
            for offset in pending.indices {
                let index = (dispatchCursor + offset) % pending.count
                if holdStartupOffers, pending[index].buffer.epoch == machine.epoch { continue }
                guard pending[index].inFlightSequence == nil,
                      !pending[index].buffer.isScopeVerificationPending,
                      eligibleSources.contains(pending[index].buffer.source) else { continue }
                // Retained tails precede newer epochs of the same track. An unknown old
                // receipt cannot be overtaken by a replacement device's first packet.
                guard !pending.prefix(index).contains(where: {
                    $0.buffer.source == pending[index].buffer.source &&
                    ($0.inFlightSequence != nil || $0.buffer.peek(cutoffNanoseconds: $0.cutoff) != nil)
                }) else { continue }
                // A retained old epoch may send a short tail only after explicit retained-audio
                // consent on Resume, or Stop. Pause itself never admits a new send.
                let chunk = pending[index].offeredChunk ?? pending[index].buffer.peekChunk(
                    targetDurationNanoseconds: targetDurationNanoseconds,
                    cutoffNanoseconds: pending[index].cutoff, allowPartial: pending[index].cutoff != nil)
                guard let chunk,
                      latestEndNanoseconds.map({ chunk.packet.endNanoseconds <= $0 }) ?? true,
                      machine.permitsSend(epoch: chunk.packet.epoch, endNanoseconds: chunk.packet.endNanoseconds,
                                          now: at) else { continue }
                // A callback may have created this short segment while peekChunk ran.
                // Recheck after obtaining it, before the first offer becomes irrevocable.
                if chunk.packet.epoch == machine.epoch, machine.state == .recording,
                   at >= epochStart, at - epochStart < 500_000_000,
                   pending.contains(where: { $0.buffer.epoch == machine.epoch && $0.buffer.source == .microphone && $0.buffer.hasRecoveredStartupClock }) { continue }
                if chunk.packet.epoch == machine.epoch { currentEpochEverOffered = true }
                pending[index].offeredChunk = chunk
                pending[index].inFlightSequence = chunk.packet.sequence
                dispatchCursor = (index + 1) % pending.count
                initiate(chunk.packet, pending[index].buffer)
                return true
            }
            return false
        }
    }

    func completeSend(source: MeetingAudioSource, epoch: UInt64, sequence: UInt64, received: Bool) {
        queue.sync {
            guard let index = pending.firstIndex(where: { $0.buffer.source == source && $0.buffer.epoch == epoch }),
                  pending[index].inFlightSequence == sequence else { return }
            if received {
                _ = pending[index].buffer.acknowledge(sequence: sequence,
                    throughSequence: pending[index].offeredChunk?.throughSequence)
                pending[index].offeredChunk = nil
            }
            pending[index].inFlightSequence = nil
        }
    }

    func finish(at: UInt64) throws {
        try queue.sync {
            guard devices.isEmpty else { throw MeetingAudioFailure.cleanupFailed }
            let drained = pending.allSatisfy { $0.buffer.peek(cutoffNanoseconds: $0.cutoff) == nil }
            try machine.finish(at: at, drained: drained, expiredAudio: hadExpiredAudio)
            pending.forEach { $0.buffer.discard() }
            pending.removeAll()
        }
    }
    /// Privacy barrier for logout, revocation, Pause All and termination. It never flushes audio.
    /// Admission closes before teardown, even if a driver refuses release. Retry to release handles.
    func terminate(at: UInt64) throws {
        try queue.sync { try terminateLocked(at: at) }
    }

    private func terminateLocked(at: UInt64) throws {
        machine.terminate(at: at)
        pending.forEach { $0.buffer.close() }
        pending.forEach { $0.buffer.discard() }
        pending.removeAll()
        retainedGaps.removeAll()
        currentEpochEverOffered = false
        pauseBoundary = nil
        try stopDevices()
    }

    /// Failed or completed sessions may be cleared only after all owned devices are released.
    /// This does not prepare or restart capture; the caller still needs a new explicit Start.
    func reset(at: UInt64) throws {
        try queue.sync {
            guard machine.state == .failed || machine.state == .finished else {
                throw MeetingAudioFailure.invalidTransition
            }
            guard machine.epoch < UInt64.max else { throw MeetingAudioFailure.invalidTransition }
            let freshEpoch = max(nextSessionEpoch, machine.epoch + 1)
            try terminateLocked(at: at)
            nextSessionEpoch = freshEpoch
            machine = MeetingCaptureMachine()
            try machine.observeTime(at)
            epochStart = 0
            hadExpiredAudio = false
        }
    }

    deinit {
        // No callback owns the runtime. Close all receivers before best-effort resource release;
        // adapters retain callback storage themselves when the OS refuses cleanup.
        pending.forEach { $0.buffer.close() }
        for device in devices.values { try? device.stop() }
        pending.forEach { $0.buffer.discard() }
    }

}
