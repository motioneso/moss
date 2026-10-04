import Foundation

/// Serial lifecycle with synchronous send admission. It is never instantiated by the app yet.
/// Host wiring must call service regularly to surface callback faults and expiry; it must also
/// connect device/process changes, Pause All, account changes and termination before enabling Start.
final class MeetingCaptureRuntime {
    typealias DeviceFactory = (MeetingNativeSelection) throws -> [MeetingAudioSource: MeetingAudioCapturing]
    private struct PendingSource {
        let buffer: MeetingAudioBuffer
        var cutoff: UInt64?
        var inFlightSequence: UInt64?
    }

    private let queue = DispatchQueue(label: "com.moss.meeting.capture-control")
    private let factory: DeviceFactory
    private var machine = MeetingCaptureMachine()
    private var devices: [MeetingAudioSource: MeetingAudioCapturing] = [:]
    private var pending: [PendingSource] = []
    private var retainedGaps: [MeetingAudioGap] = []
    private var epochStart: UInt64 = 0
    private var hadExpiredAudio = false
    private var pauseBoundary: (at: UInt64, epoch: UInt64, sources: [MeetingAudioSource])?

    init(factory: @escaping DeviceFactory) { self.factory = factory }

    var snapshot: MeetingCaptureMachine { queue.sync { machine } }

    func prepare(selection: MeetingNativeSelection, readiness: MeetingNativeReadiness, at: UInt64) throws {
        try queue.sync { try machine.prepare(selection: selection, readiness: readiness, at: at) }
    }

    func start(readiness: MeetingNativeReadiness, at: UInt64) throws {
        try queue.sync {
            var candidate = machine
            try candidate.start(readiness: readiness, at: at)
            try startDevices(candidate: candidate, at: at)
        }
    }

    func resume(selection: MeetingNativeSelection, readiness: MeetingNativeReadiness,
                permitRetainedAudio: Bool, at: UInt64) throws {
        try queue.sync {
            guard devices.isEmpty else { throw MeetingAudioFailure.cleanupFailed }
            var candidate = machine
            try candidate.resume(selection: selection, readiness: readiness, permitRetainedAudio: permitRetainedAudio, at: at)
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
        // At most sixteen retained source rings: 64 MiB of preallocated Float32 sample storage.
        // Empty acknowledged epochs are pruned before allocating another pair.
        pending.removeAll { $0.cutoff != nil && $0.buffer.peek(cutoffNanoseconds: $0.cutoff) == nil }
        guard pending.count <= 14 else { throw MeetingAudioFailure.bufferFull }
        let created = try factory(selection)
        let expected: Set<MeetingAudioSource> = selection.output == nil ? [.microphone] : [.microphone, .output]
        guard Set(created.keys) == expected else { throw MeetingAudioFailure.invalidSelection }
        let sourceOrder = MeetingAudioSource.allCases.filter { expected.contains($0) }
        let fresh = try sourceOrder.map { source in
            PendingSource(buffer: try MeetingAudioBuffer(source: source, epoch: candidate.epoch, originNanoseconds: at),
                          cutoff: nil, inFlightSequence: nil)
        }
        devices = created
        do {
            for entry in fresh {
                guard let device = devices[entry.buffer.source] else { throw MeetingAudioFailure.invalidSelection }
                try device.start(into: entry.buffer)
                if let failure = entry.buffer.failure { throw failure }
            }
            pending.append(contentsOf: fresh)
            machine = candidate
            epochStart = at
        } catch {
            fresh.forEach { $0.buffer.close(); $0.buffer.discard() }
            machine.fail()
            do { try stopDevices() } catch { throw MeetingAudioFailure.cleanupFailed }
            throw error
        }
    }

    func pause(at: UInt64) throws {
        try queue.sync {
            try machine.pause(at: at)
            rememberPause(at: at)
            closeCurrentEpoch(at: at)
            do { try stopDevices() } catch { machine.fail(); throw error }
        }
    }

    func stop(at: UInt64, finalizationNanoseconds: UInt64 = 60_000_000_000) throws {
        try queue.sync {
            let alreadyStopped = machine.stopCutoffNanoseconds != nil
            try machine.stop(at: at, finalizationNanoseconds: finalizationNanoseconds)
            if !alreadyStopped { closeCurrentEpoch(at: at) }
            // A replay still retries incomplete device cleanup, without extending the cutoff.
            try stopDevices()
        }
    }

    private func rememberPause(at: UInt64) {
        let sources: [MeetingAudioSource] = machine.selection?.output == nil ? [.microphone] : [.microphone, .output]
        pauseBoundary = (at, machine.epoch, sources)
    }

    private func closeCurrentEpoch(at: UInt64) {
        for index in pending.indices where pending[index].cutoff == nil {
            pending[index].buffer.close()
            pending[index].cutoff = at
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
            try machine.pause(at: at)
            rememberPause(at: at)
            closeCurrentEpoch(at: at)
            gaps.append(MeetingAudioGap(source: failed.buffer.source, epoch: failed.buffer.epoch,
                startNanoseconds: epochStart, endNanoseconds: at,
                reason: reason == .bufferFull ? .bufferFull : .captureFailure(reason)))
            do { try stopDevices() } catch {
                machine.fail()
                retainedGaps = gaps
                throw error
            }
        }
        for index in pending.indices {
            let expired = pending[index].buffer.expire(nowNanoseconds: at)
            if !expired.isEmpty { hadExpiredAudio = true }
            gaps.append(contentsOf: expired)
            if let inFlight = pending[index].inFlightSequence,
               pending[index].buffer.peek(cutoffNanoseconds: pending[index].cutoff)?.sequence != inFlight {
                pending[index].inFlightSequence = nil
            }
        }
        pending.removeAll { $0.cutoff != nil && $0.buffer.peek(cutoffNanoseconds: $0.cutoff) == nil }
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
        try queue.sync {
            let gaps = try serviceLocked(at: at)
            retainedGaps = gaps
            for index in pending.indices where pending[index].inFlightSequence == nil {
                guard let packet = pending[index].buffer.peek(cutoffNanoseconds: pending[index].cutoff),
                      machine.permitsSend(epoch: packet.epoch, endNanoseconds: packet.endNanoseconds, now: at) else { continue }
                pending[index].inFlightSequence = packet.sequence
                initiate(packet)
                return true
            }
            return false
        }
    }

    func completeSend(source: MeetingAudioSource, epoch: UInt64, sequence: UInt64, received: Bool) {
        queue.sync {
            guard let index = pending.firstIndex(where: { $0.buffer.source == source && $0.buffer.epoch == epoch }),
                  pending[index].inFlightSequence == sequence else { return }
            if received { _ = pending[index].buffer.acknowledge(sequence: sequence) }
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
    deinit {
        // No callback owns the runtime. Close all receivers before best-effort resource release;
        // adapters retain callback storage themselves when the OS refuses cleanup.
        pending.forEach { $0.buffer.close() }
        for device in devices.values { try? device.stop() }
        pending.forEach { $0.buffer.discard() }
    }

}
