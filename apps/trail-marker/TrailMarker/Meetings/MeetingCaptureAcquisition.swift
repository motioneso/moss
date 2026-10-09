import Foundation

struct MeetingCaptureAcquisitionTicket: Equatable {
    let id: UUID
    let epoch: UInt64
}

enum MeetingCaptureAcquisitionEvent {
    case ready(MeetingCaptureAcquisitionTicket)
    case failed(MeetingCaptureAcquisitionTicket, MeetingAudioFailure)
    case cleanupComplete(MeetingCaptureAcquisitionTicket)
    case cleanupFailed(MeetingCaptureAcquisitionTicket)
}

/// A new device receives only this gate until the control plane adopts its epoch. Quarantine
/// deliberately ignores PCM AND drops: neither may seed the fresh buffer's sample clock.
/// Faults remain observable, including those delivered after cancellation or a softer fault.
final class MeetingCaptureAcquisitionReceiver: MeetingAudioReceiving {
    let buffer: MeetingAudioBuffer
    private let state = MeetingAudioAtomicState() // 0 quarantined, 1 admitted, 2 closed
    private let scopePending = MeetingAudioAtomicState()
    private let admittedAt = MeetingAudioLease()
    private let lease: MeetingAudioLease
    private let monotonicNow: () -> UInt64

    init(buffer: MeetingAudioBuffer, lease: MeetingAudioLease, monotonicNow: @escaping () -> UInt64) {
        self.buffer = buffer
        self.lease = lease
        self.monotonicNow = monotonicNow
        buffer.setHostSourceVerificationPending(true)
    }

    func admit(at: UInt64) {
        admittedAt.update(deadline: at)
        buffer.setHostSourceVerificationPending(false, confirmedAt: at)
        _ = state.replace(0, with: 1)
    }

    func close() {
        state.exchange(2)
        buffer.close()
    }

    private func permits(_ host: UInt64) -> Bool {
        guard state.value == 1, host >= admittedAt.deadline else { return false }
        guard monotonicNow() < lease.deadline else { buffer.fail(.leaseExpired); return false }
        return true
    }

    func receive(hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int, sampleAt: (Int) -> Float) {
        guard permits(hostTimeNanoseconds) else { return }
        buffer.receive(hostTimeNanoseconds: hostTimeNanoseconds, sampleRate: sampleRate,
                       frameCount: frameCount, sampleAt: sampleAt)
    }

    func receive(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double,
                 frameCount: Int, sampleAt: (Int) -> Float) {
        guard permits(hostTimeNanoseconds) else { return }
        buffer.receive(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds,
                       sampleRate: sampleRate, frameCount: frameCount, sampleAt: sampleAt)
    }

    func drop(sampleTime: Double, hostTimeNanoseconds: UInt64, sampleRate: Double, frameCount: Int) {
        guard permits(hostTimeNanoseconds) else { return }
        buffer.drop(sampleTime: sampleTime, hostTimeNanoseconds: hostTimeNanoseconds,
                    sampleRate: sampleRate, frameCount: frameCount)
    }

    func fail(_ failure: MeetingAudioFailure) { buffer.fail(failure) }
    func fail(_ failure: MeetingAudioFailure, diagnostic: MeetingAudioFailureDiagnostic) {
        buffer.fail(failure, diagnostic: diagnostic)
    }
    var isScopeVerificationPending: Bool { scopePending.value != 0 }
    func setScopeVerificationPending(_ pending: Bool) {
        scopePending.exchange(pending ? 1 : 0)
        buffer.setScopeVerificationPending(pending)
    }
}

/// Owns every staged device until adoption or successful disposal. Only ownerQueue may call
/// factory/start/stop. Control-plane methods take only a short lock and close atomic gates;
/// none waits for native acquisition or disposal. Failed handles stay owned for Stop retry.
final class MeetingCaptureAcquisition {
    struct Adopted {
        let devices: [MeetingAudioSource: MeetingAudioCapturing]
        let receivers: [MeetingCaptureAcquisitionReceiver]
        let startupDiagnostic: String?
    }
    private enum Phase: Equatable { case starting, ready, cancelled, cleanupFailed, cleaned, committed }
    private enum Aborted: Error { case cancelled }

    let ticket: MeetingCaptureAcquisitionTicket
    let selection: MeetingNativeSelection
    let previousEpoch: UInt64
    let readiness: MeetingNativeReadiness
    let permitRetainedAudio: Bool
    let deadline: UInt64
    private let origin: UInt64
    private let previousEvidence: [MeetingAudioBuffer]
    private let lease: MeetingAudioLease
    private let monotonicNow: () -> UInt64
    private let factory: MeetingCaptureRuntime.DeviceFactory
    private let reportDiagnostic: (String) -> Void
    private let emit: (MeetingCaptureAcquisitionEvent) -> Void
    private let ownerQueue = DispatchQueue(label: "com.moss.meeting.capture-acquisition")
    private let lock = NSLock()
    private var phase: Phase = .starting
    private var cleanupScheduled = false
    private var cleanupInProgress = false
    private var cleanupRetryRequested = false
    private var failureReported = false
    private var receivers: [MeetingCaptureAcquisitionReceiver] = []
    // Only the owner queue touches devices until adopt transfers them under lock.
    private var devices: [MeetingAudioSource: MeetingAudioCapturing] = [:]
    private var startupDiagnostic: String?

    init(ticket: MeetingCaptureAcquisitionTicket, selection: MeetingNativeSelection, previousEpoch: UInt64,
         readiness: MeetingNativeReadiness, permitRetainedAudio: Bool, deadline: UInt64, origin: UInt64,
         previousEvidence: [MeetingAudioBuffer], lease: MeetingAudioLease, monotonicNow: @escaping () -> UInt64,
         factory: @escaping MeetingCaptureRuntime.DeviceFactory, reportDiagnostic: @escaping (String) -> Void,
         emit: @escaping (MeetingCaptureAcquisitionEvent) -> Void) {
        self.ticket = ticket; self.selection = selection; self.previousEpoch = previousEpoch
        self.readiness = readiness; self.permitRetainedAudio = permitRetainedAudio
        self.deadline = deadline; self.origin = origin; self.previousEvidence = previousEvidence; self.lease = lease
        self.monotonicNow = monotonicNow; self.factory = factory
        self.reportDiagnostic = reportDiagnostic; self.emit = emit
    }

    var cleanupFailed: Bool {
        lock.lock(); defer { lock.unlock() }
        return phase == .cleanupFailed
    }

    var failure: MeetingAudioFailure? {
        lock.lock(); let current = receivers; lock.unlock()
        let faults = current.compactMap { $0.buffer.failure }
        return faults.first { $0 != .sourceReconfigured } ?? faults.first
    }

    func start() { ownerQueue.async { self.acquire() } }

    private func checkActive() throws {
        lock.lock(); let active = phase == .starting || phase == .ready; lock.unlock()
        guard active else { throw Aborted.cancelled }
        guard monotonicNow() < min(deadline, lease.deadline) else { throw MeetingAudioFailure.leaseExpired }
        if let oldFailure = previousEvidence.compactMap({ $0.failure }).first(where: { $0 != .sourceReconfigured }) {
            throw oldFailure
        }
        if let failure { throw failure }
    }

    private func acquire() {
        var startingSource: MeetingAudioSource?
        do {
            try checkActive()
            devices = try factory(selection)
            try checkActive()
            guard Set(devices.keys) == selection.sources else { throw MeetingAudioFailure.invalidSelection }
            for source in MeetingAudioSource.allCases where selection.sources.contains(source) {
                try checkActive()
                let buffer = try MeetingAudioBuffer(source: source, epoch: ticket.epoch, originNanoseconds: origin,
                    lease: lease, permitsStartupClockRecovery: source == .microphone, monotonicNow: monotonicNow)
                let receiver = MeetingCaptureAcquisitionReceiver(buffer: buffer, lease: lease, monotonicNow: monotonicNow)
                lock.lock()
                receivers.append(receiver)
                let cancelled = phase != .starting
                if cancelled { receiver.close() }
                lock.unlock()
                try checkActive()
                guard let device = devices[source] else { throw MeetingAudioFailure.invalidSelection }
                startingSource = source
                try device.start(into: receiver)
                // Cancellation while start is blocked must prevent starting the paired source.
                try checkActive()
            }
            startupDiagnostic = devices[.microphone]?.startupDiagnostic
            lock.lock()
            let ready = phase == .starting
            if ready { phase = .ready }
            lock.unlock()
            if ready { emit(.ready(ticket)) }
        } catch Aborted.cancelled {
            // Cancellation has already queued disposal behind this native call.
        } catch {
            if let source = startingSource {
                let receiver = receivers.first { $0.buffer.source == source }
                reportDiagnostic(MeetingAudioFailureDiagnostic.message(source: source, failure: error,
                    diagnostic: receiver?.buffer.failureDiagnostic ?? .init(.captureStart)))
            }
            reject(error as? MeetingAudioFailure ?? .deviceFailure(operation: "capture-start", status: -1))
        }
    }

    /// Invoked only by the serial runtime control plane after all host checks. Moving handles
    /// is safe once ready: start returned, and cleanup cannot run unless phase is cancelled.
    func adopt(at: UInt64) throws -> Adopted {
        lock.lock(); defer { lock.unlock() }
        guard phase == .ready else { throw MeetingAudioFailure.invalidTransition }
        guard at < min(deadline, lease.deadline), monotonicNow() < min(deadline, lease.deadline) else {
            throw MeetingAudioFailure.leaseExpired
        }
        if let oldFailure = previousEvidence.compactMap({ $0.failure }).first(where: { $0 != .sourceReconfigured }) {
            throw oldFailure
        }
        let faults = receivers.compactMap { $0.buffer.failure }
        if let failure = faults.first(where: { $0 != .sourceReconfigured }) ?? faults.first { throw failure }
        guard receivers.allSatisfy({ !$0.isScopeVerificationPending }) else {
            throw MeetingAudioFailure.invalidSelection
        }
        phase = .committed
        let result = Adopted(devices: devices, receivers: receivers, startupDiagnostic: startupDiagnostic)
        devices.removeAll()
        return result
    }

    func reject(_ failure: MeetingAudioFailure) { requestCancellation(failure: failure) }
    func cancel() { requestCancellation(failure: nil) }

    private func requestCancellation(failure: MeetingAudioFailure?) {
        lock.lock()
        guard phase != .committed, phase != .cleaned else { lock.unlock(); return }
        if failure != nil, phase != .starting && phase != .ready { lock.unlock(); return }
        // A late error from a cancelled start cannot turn cancellation into a new failure.
        let shouldReport = failure != nil && !failureReported && (phase == .starting || phase == .ready)
        if shouldReport { failureReported = true }
        phase = .cancelled
        receivers.forEach { $0.close() }
        // A newer Stop may arrive after the current native stop has already sampled a
        // failure. Keep one retry intent; queued-but-not-started disposal already covers it.
        if cleanupInProgress { cleanupRetryRequested = true }
        let schedule = !cleanupScheduled
        cleanupScheduled = true
        lock.unlock()
        if shouldReport, let failure { emit(.failed(ticket, failure)) }
        if schedule { ownerQueue.async { self.dispose() } }
    }

    private func dispose() {
        // Serialized after factory/start returns. Never stop concurrently with start.
        lock.lock()
        cleanupInProgress = true
        lock.unlock()
        var failed = false
        for source in MeetingAudioSource.allCases.reversed() {
            if let device = devices[source] {
                do { try device.stop(); devices[source] = nil } catch { failed = true }
            }
        }
        lock.lock()
        receivers.forEach { $0.close() }
        let retired = receivers
        let retry = failed && cleanupRetryRequested
        phase = retry ? .cancelled : (failed ? .cleanupFailed : .cleaned)
        cleanupInProgress = false
        cleanupRetryRequested = false
        cleanupScheduled = retry
        lock.unlock()
        retired.forEach { $0.buffer.discard() }
        if retry {
            // Coalesce overlapping requests into one follow-up for retained failed handles.
            // Failure alone never retries: another pass needs a newer explicit request.
            ownerQueue.async { self.dispose() }
        } else { emit(failed ? .cleanupFailed(ticket) : .cleanupComplete(ticket)) }
    }
}
