import AppKit
import AudioToolbox
import Combine
import Foundation

/// App-lifetime capture host. The shared connection advertises sources without opening them.
/// Initial capture requires a fresh browser Start; native Resume retains that claimed session.
@MainActor
final class MeetingCaptureHost: ObservableObject {
    enum Phase: String { case unprepared, ready, recording, paused, stopping, stopped, error }
    @Published private(set) var phase: Phase = .unprepared {
        didSet { refreshRecordingPresentation() }
    }
    @Published private(set) var recordingPresentation = MeetingRecordingPresentation()
    @Published private(set) var message = "Choose sources and press Start meeting in Moss."
    @Published private(set) var processingMessage: String?
    @Published private(set) var connectivityMessage: String?
    @Published private(set) var backlogMessage: String?
    @Published private(set) var outputMessage: String?
    @Published private(set) var diagnostics: [String] = []
    @Published private(set) var activation: MeetingActivation?
    @Published private(set) var inventory: MeetingCaptureInventory?
    @Published private(set) var sourceDescription = "No audio sources selected"
    @Published private(set) var cleanupBlocked = false
    @Published private(set) var gapCount = 0
    @Published private(set) var gapCoverageIncomplete = false

    private let connection: ConnectionRuntime
    private let ports: MeetingCaptureHostPorts
    private let runtime: MeetingCaptureRuntime
    private var client: MeetingCaptureClient?
    private var credential: String?
    private var grantId: String?
    private var grantExpiry: Date?
    private var pollTask: Task<Void, Never>?
    private var controlTask: Task<Void, Never>?
    private var uploadTasks: [MeetingAudioSource: URLSessionDataTask] = [:]
    private var uploadRetry = MeetingCaptureUploadRetry()
    private var startCommandDeadline: Date?
    private var initialStartGeneration: Int?
    private var leaseDeadlineNanoseconds: UInt64 = 0
    private lazy var recordingConnection = MeetingRecordingConnection(connection: connection, activate: { [weak self] command, claim, credential, origin in
        try self?.acceptStart(command, claim: claim, credential: credential, origin: origin)
    }, report: { [weak self] text in
        guard let self else { return }
        self.connectivityMessage = text
    })
    private var timer: Timer?
    private var sessionGeneration = 0
    private var fence = MeetingCommandFence()
    private var observed = MeetingCaptureObserved(generation: 0, phase: "idle", errorCode: nil)
    @Published private(set) var remote: MeetingRemoteCapture?
    private var selected: MeetingInventorySnapshot.Resolved?
    private var choice: MeetingCaptureChoice?
    private var recordingDuration = MeetingRecordingDuration()
    private var uploadAdmitted = false
    private var stoppedByUser = false
    @Published private(set) var controlInFlight = false
    private var controlRetryAtNanoseconds: UInt64 = 0
    @Published private(set) var controlOutbox = MeetingControlOutbox()
    private var pausedCaptureCutoff: UInt64?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    @Published private(set) var sourceSelectionError: String?
    private var sourceChangeIntent: MeetingSourceChangeIntent?
    private var sourceChangeTask: Task<Void, Never>?
    private var sourceChangeRevision = 0

    private var timeline = MeetingCaptureTimeline()
    private var diagnosticLog = MeetingCaptureDiagnostics()

    init(connection: ConnectionRuntime, runtime: MeetingCaptureRuntime? = nil, ports: MeetingCaptureHostPorts? = nil, factory: @escaping MeetingCaptureRuntime.DeviceFactory = MeetingCaptureHost.devices) {
        self.connection = connection
        self.ports = ports ?? .live(connection: connection)
        self.runtime = runtime ?? MeetingCaptureRuntime(factory: factory)
    }

    // Read-only progress and completion waits never expose a task cancellation handle.
    var sourceChangePending: Bool { sourceChangeIntent != nil }
    var sourceChangeAcknowledged: Bool { sourceChangeIntent?.acknowledged == true }
    var sourceChangeInFlight: Bool { sourceChangeTask != nil }
    var pendingGaps: [MeetingCaptureGap] { timeline.pendingGaps }
    var uploadsInFlight: Bool { !uploadTasks.isEmpty }
    var sourceChangeCompletion: MeetingCaptureTaskProgress? { sourceChangeTask.map(MeetingCaptureTaskProgress.init) }
    var controlCompletion: MeetingCaptureTaskProgress? { controlTask.map(MeetingCaptureTaskProgress.init) }
    var pollCompletion: MeetingCaptureTaskProgress? { pollTask.map(MeetingCaptureTaskProgress.init) }

    var isRecording: Bool { phase == .recording || cleanupBlocked }
    var canStop: Bool { [.recording, .paused, .stopping].contains(phase) || (phase == .ready && grantId != nil) || cleanupBlocked }

    var canResumeFromUserClick: Bool {
        sourceChangeIntent == nil && phase == .paused && remote?.desired == "paused" && remote?.selection == choice &&
            !timeline.epochs.isEmpty && !stoppedByUser && !cleanupBlocked && !gapCoverageIncomplete &&
            controlOutbox.pending == nil && !controlInFlight && credential != nil &&
            grantExpiry.map({ ports.wallNow() < $0 }) == true && self.now() < leaseDeadlineNanoseconds
    }

    func hideRecordingPill() { recordingPresentation.hide() }
    func showRecordingPill() { recordingPresentation.show() }
    private func refreshRecordingPresentation() {
        let now = self.now()
        recordingPresentation.update(phase: phase, reconnecting: connectivityMessage != nil,
            elapsedMilliseconds: recordingDuration.milliseconds(at: now), level: runtime.capturedLevel(at: now))
    }

    func startConnection() { recordingConnection.start() }
    @discardableResult func shutdown(reason: String) -> Bool {
        recordingConnection.stop()
        return terminate(reason: reason)
    }

    func open(_ url: URL) {
        do {
            let next = try MeetingActivation.parse(url)
            guard let identity = ports.identity(), identity.instance == next.instance else { throw MeetingHostError.wrongInstance }
            guard !canStop, !cleanupBlocked else { return }
            activation = next
            inventory = try ports.readInventory().wire
            message = "Choose sources and press Start meeting in the browser you are using."
        } catch { if !canStop { show(error) } }
    }

    func acceptStart(_ command: MeetingRecordingCommand, claim: MeetingRecordingClaimReply, credential: String, origin: UInt64) throws {
        if grantId == claim.grantId { return }
        guard !canStop, !cleanupBlocked, ports.connectionAvailable(), let identity = ports.identity(),
              claim.capture.deviceId == identity.deviceId,
              let expires = ServerTime.parse(claim.expiresAt), expires > self.ports.wallNow(),
              let deadline = ServerTime.parse(command.expiresAt) else { throw MeetingAudioFailure.invalidTransition }
        guard terminate(reason: "Starting the meeting requested in Moss.") else { throw MeetingHostError.cleanupFailed }
        activation = MeetingActivation(instance: identity.instance, meetingId: claim.meetingId)
        client = ports.makeClient(identity.instance)
        self.credential = credential
        grantId = claim.grantId
        grantExpiry = expires
        leaseDeadlineNanoseconds = self.now() + min(30000, claim.capture.leaseMs ?? 30000) * 1_000_000
        startCommandDeadline = deadline
        initialStartGeneration = claim.capture.generation
        timeline.originNanoseconds = origin
        stoppedByUser = false
        gapCount = 0
        recordingDuration = MeetingRecordingDuration()
        gapCoverageIncomplete = false
        processingMessage = nil
        connectivityMessage = nil
        phase = .ready
        if ["recording", "paused"].contains(claim.capture.desired) { recordingPresentation.acceptedStart() }
        refreshRecordingPresentation()
        fence.acceptFreshStart(generation: claim.capture.generation)
        remote = claim.capture
        if deadline <= self.ports.wallNow() { localControl("stop") }
        installServiceTimer()
        let generation = sessionGeneration
        pollTask = Task { [weak self] in await self?.poll(generation: generation) }
    }

    private func poll(generation: Int) async {
        var nextDelay: UInt64 = 0
        while !Task.isCancelled, generation == sessionGeneration {
            if nextDelay > 0 { try? await Task.sleep(nanoseconds: nextDelay * 1_000_000) }
            guard !Task.isCancelled, generation == sessionGeneration else { return }
            nextDelay = 2000
            if sourceChangeIntent?.awaitingControl == true {
                retrySourceChange()
                continue
            }
            let sourceRevision = sourceChangeRevision
            do {
                guard let client, let activation, let credential, let grantId, let grantExpiry,
                      self.ports.wallNow() < grantExpiry else { throw MeetingHostError.authorizationExpired }
                let fresh = try ports.readInventory()
                inventory = fresh.wire
                validateCurrentSources(fresh)
                let sentObservation = observed
                let requestSent = self.now()
                let reply = try await client.status(.init(meetingId: activation.meetingId, grantId: grantId,
                    inventory: fresh.wire, observed: sentObservation, gaps: gapsForStatus(),
                    finalized: phase == .stopped && timeline.pendingGaps.isEmpty ? true : nil,
                    recordedDurationMs: recordingDuration.milliseconds(at: requestSent)), credential: credential)
                guard generation == sessionGeneration, !Task.isCancelled else { return }
                guard sourceRevision == sourceChangeRevision else { continue }
                guard reply.capture.grantId == grantId, reply.capture.deviceId == ports.identity()?.deviceId else {
                    throw MeetingHostError.authorizationExpired
                }
                try reply.capture.validate()
                try reconcileSourceChangeStatus(reply.capture)
                guard controlOutbox.accepts(generation: reply.capture.generation) else {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    continue
                }
                try reconcileClosedSourceEpoch(reply.capture)
                controlOutbox.reconcile(generation: reply.capture.generation, desired: reply.capture.desired,
                    retainedSourceMatches: reply.capture.selection == choice)
                let now = self.now()
                let lease = min(30000, reply.capture.leaseMs ?? 30000)
                guard lease >= 15000 else { throw MeetingHostError.invalidResponse }
                leaseDeadlineNanoseconds = requestSent + lease * 1_000_000
                runtime.updateCaptureLease(until: leaseDeadlineNanoseconds)
                connectivityMessage = nil
                if reply.capture.processing?.status == "delayed" { processingMessage = "Transcription delayed. Audio capture continues." }
                else if gapCount == 0 { processingMessage = nil }
                noteDiagnostic("status", duration: now - requestSent)
                try timeline.synchronizeOrigin(requestSent: requestSent, responseReceived: now, elapsedMs: reply.capture.elapsedMs)
                timeline.acknowledgeGaps(reply.capture)
                if reply.capture.gapLimitReached == true, !gapCoverageIncomplete {
                    gapCoverageIncomplete = true
                    if phase == .recording { interrupt(error: MeetingHostError.rejected) }
                    if !cleanupBlocked {
                        message = "The meeting reached its audio-gap limit. Coverage is incomplete; Stop and review the transcript in Moss."
                    }
                }
                if phase == .stopped, reply.capture.desired == "stopped", timeline.pendingGaps.isEmpty, reply.capture.finalization == "complete" {
                    _ = terminate(reason: message)
                    return
                }
                remote = reply.capture
                timeline.clipGaps(at: reply.capture.stopCutoffMs)
                if !controlInFlight, controlOutbox.pending == nil {
                    try await apply(reply.capture, inventory: try ports.readInventory(), at: now)
                }
                guard generation == sessionGeneration, !Task.isCancelled else { return }
                retryPendingControl()
                // The status request has acknowledged this exact epoch before its first audio send.
                uploadAdmitted = sourceChangeIntent == nil && reply.capture.selection == choice &&
                    (phase == .stopping || timeline.epochs[runtime.snapshot.epoch]?.remoteEpoch == reply.capture.epoch) &&
                    controlOutbox.pending == nil && !controlInFlight && MeetingSendAdmission.permits(phase: phase, desired: reply.capture.desired,
                    submitted: sentObservation, current: observed)
            } catch {
                guard generation == sessionGeneration, !Task.isCancelled else { return }
                guard sourceRevision == sourceChangeRevision else { continue }
                if (error as? MeetingHostError) == .authorizationExpired {
                    _ = terminate(reason: MeetingHostError.authorizationExpired.message)
                    return
                }
                uploadAdmitted = false
                connectivityMessage = "Connection delayed. Audio is retained within the current lease and memory limit."
                if let milliseconds = (error as? MeetingHostError)?.retryDelayMilliseconds { nextDelay = milliseconds }
                else if (error as? MeetingHostError) != .network { interrupt(error: error) }
                noteDiagnostic("status-failed", duration: 0)
            }
        }
    }

    private func apply(_ next: MeetingRemoteCapture, inventory: MeetingInventorySnapshot, at now: UInt64) async throws {
        let start = fence.shouldStart(generation: next.generation, desired: next.desired)
        if next.desired == "revoked" { _ = terminate(reason: next.revocationMessage); return }
        if next.desired == "stopped" {
            stoppedByUser = true
            if [.idle, .ready, .finished].contains(runtime.snapshot.state), !cleanupBlocked {
                observed = .init(generation: next.generation, phase: "stopped", errorCode: nil)
                finish()
                return
            }
            if [.recording, .paused, .stopping].contains(phase) {
                let cutoff = try [next.stopCutoffMs, next.epochEndMs].compactMap { $0 }.min().map(timeline.nativeTime)
                recordPauseGap(endingAt: try next.stopCutoffMs.map(timeline.nativeTime) ?? now)
                if runtime.snapshot.state == .finished, !cleanupBlocked { finish(); return }
                recordingDuration.pause(at: min(now, cutoff ?? now))
                try runtime.stop(at: now, captureCutoffNanoseconds: cutoff)
                observed = .init(generation: next.generation, phase: "stopped", errorCode: nil)
                phase = .stopping
                message = "Recording stopped. Finishing only audio captured before Stop."
            }
            return
        }
        if next.desired == "paused" {
            startCommandDeadline = nil
            if next.selection != choice, !timeline.epochs.isEmpty { try adoptPausedSourceChoice(next) }
        }
        if next.desired == "paused", phase == .ready {
            observed = .init(generation: next.generation, phase: "paused", errorCode: nil)
            phase = .paused
            message = "Start is paused. Check the selected sources and press Resume in Moss."
        }
        if next.desired == "paused", phase == .recording {
            pausedCaptureCutoff = try next.epochEndMs.map(timeline.nativeTime)
            recordingDuration.pause(at: min(now, pausedCaptureCutoff ?? now))
            try runtime.pause(at: now, captureCutoffNanoseconds: pausedCaptureCutoff)
            timeline.pauseStartedNanoseconds = pausedCaptureCutoff ?? now
            timeline.pauseReason = "paused"
            uploadAdmitted = false
            observed = .init(generation: next.generation, phase: "paused", errorCode: nil)
            phase = .paused
            message = "Paused. No new audio is captured or sent. Press Resume in Moss."
        }
        if next.desired == "paused", phase == .paused, !cleanupBlocked, observed.generation != next.generation {
            // A native fault may have already closed capture before Moss advances Pause.
            // Acknowledge that version without reopening/stopping devices or losing the cause.
            if let cutoff = try next.epochEndMs.map(timeline.nativeTime) {
                pausedCaptureCutoff = min(pausedCaptureCutoff ?? cutoff, cutoff)
                runtime.tightenPauseCutoff(to: cutoff)
            }
            observed = .init(generation: next.generation, phase: "paused", errorCode: observed.errorCode)
        }
        guard start, !stoppedByUser, !controlInFlight, !cleanupBlocked, !gapCoverageIncomplete, let selection = next.selection else { return }
        if next.generation != initialStartGeneration { startCommandDeadline = nil }
        let generation = sessionGeneration
        if selection.microphone != nil, ports.microphonePermission() != .granted {
            let permissionFence = MeetingStartPermissionFence(sessionGeneration: generation, captureGeneration: next.generation,
                grantId: next.grantId, deviceId: next.deviceId, expiresAt: startCommandDeadline)
            let permissionStarted = self.now()
            let granted = await ports.requestMicrophone()
            guard generation == sessionGeneration, !Task.isCancelled, !stoppedByUser else { return }
            noteDiagnostic("microphone-permission", duration: self.now() - permissionStarted)
            guard granted else { throw MeetingHostError.permissionDenied }
            // The OS dialog may outlive Start, browser Stop or expiry. Revalidate authority
            // after it returns; granting an OS permission alone can never open a device.
            guard startCommandDeadline.map({ self.ports.wallNow() < $0 }) ?? true else { localControl("stop"); return }
            guard let client, let activation, let credential, let grantId else { throw MeetingHostError.authorizationExpired }
            let permissionCheckSent = self.now()
            let check = try await client.status(.init(meetingId: activation.meetingId, grantId: grantId,
                inventory: try ports.readInventory().wire, observed: observed), credential: credential)
            guard generation == sessionGeneration, !Task.isCancelled, !stoppedByUser else { return }
            try check.capture.validate()
            guard check.capture.grantId == grantId, check.capture.deviceId == ports.identity()?.deviceId else {
                throw MeetingHostError.authorizationExpired
            }
            try timeline.synchronizeOrigin(requestSent: permissionCheckSent, responseReceived: self.now(), elapsedMs: check.capture.elapsedMs)
            leaseDeadlineNanoseconds = permissionCheckSent + min(30000, check.capture.leaseMs ?? 30000) * 1_000_000
            runtime.updateCaptureLease(until: leaseDeadlineNanoseconds)
            remote = check.capture
            guard permissionFence.permits(session: sessionGeneration, capture: check.capture, now: self.ports.wallNow(),
                cancelled: Task.isCancelled, stopped: stoppedByUser) else { return }
        }
        let now = self.now()
        guard startCommandDeadline.map({ self.ports.wallNow() < $0 }) ?? true else {
            localControl("stop")
            return
        }
        guard now < leaseDeadlineNanoseconds else { throw MeetingHostError.network }
        let resolved = try ports.readInventory().resolve(selection)
        let readiness = MeetingNativeReadiness(permissionsGranted: true, processingReady: true,
            meetingDeviceAuthorized: true)
        if let previousEpoch = timeline.pauseGapSelection?.epoch ?? timeline.epochs[runtime.snapshot.epoch]?.remoteEpoch,
           next.epoch > previousEpoch { try adoptPausedSourceChoice(next) }
        if runtime.snapshot.state == .paused {
            try runtime.resume(selection: resolved.selection, readiness: readiness, permitRetainedAudio: true, at: now)
        } else {
            if timeline.pauseGapSelection == nil { recordPauseGap(endingAt: now) }
            if [.failed, .finished].contains(runtime.snapshot.state) { try runtime.reset(at: now) }
            try runtime.prepare(selection: resolved.selection, readiness: readiness, at: now)
            try runtime.start(readiness: readiness, at: now)
        }
        noteDiagnostic("devices-start", duration: self.now() - now)
        // Re-check after source acquisition: a helper appearing during startup is not grandfathered.
        let after = try ports.readInventory().resolve(selection)
        guard after == resolved else {
            guard closeCaptureDiscarding(at: self.now()) else { throw MeetingHostError.cleanupFailed }
            throw MeetingHostError.sourceChanged
        }
        if timeline.pauseGapSelection != nil { recordPauseGap(endingAt: now) }
        recordingDuration.start(at: self.now())
        timeline.epochs[runtime.snapshot.epoch] = MeetingCaptureTimeline.Epoch(remoteEpoch: next.epoch, generation: next.generation, choice: selection, startNanoseconds: now)
        timeline.pauseStartedNanoseconds = nil
        pausedCaptureCutoff = nil
        startCommandDeadline = nil
        selected = resolved
        choice = selection
        observed = .init(generation: next.generation, phase: "recording", errorCode: nil)
        phase = .recording
        sourceDescription = Self.describe(selection, inventory: inventory.wire)
        message = "Recording \(sourceDescription)."
        outputMessage = runtime.isAwaitingOutputAudio ? "Waiting for output audio" : nil
        uploadAdmitted = false
    }

    private func installServiceTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.service() }
        }
        let workspace = NSWorkspace.shared.notificationCenter
        let sleep = workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.interrupt(error: MeetingHostError.sourceChanged) }
        }
        observers.append((workspace, sleep))
    }

    func service() {
        defer { refreshRecordingPresentation() }
        do {
            let now = self.now()
            if cleanupBlocked {
                if closeCaptureDiscarding(at: now) { phase = .error; message = "Capture stopped. Press Start meeting in Moss again." }
                return
            }
            guard grantExpiry.map({ self.ports.wallNow() < $0 }) == true else {
                _ = terminate(reason: MeetingHostError.authorizationExpired.message); return
            }
            if leaseDeadlineNanoseconds > 0, now >= leaseDeadlineNanoseconds {
                _ = terminate(reason: "Recording stopped because its connection lease expired. Press Start in Moss again.")
                return
            }
            if phase == .recording {
                validateCurrentSources(try ports.readInventory())
            }
            let gaps = try runtime.service(at: now)
            recordingDuration.observeCaptureState(runtime.snapshot.state, at: now)
            backlogMessage = runtime.isBacklogged(at: now)
                ? "Audio is waiting to upload and memory is nearing its limit. Capture will pause if it fills."
                : nil
            outputMessage = phase == .recording && runtime.isAwaitingOutputAudio ? "Waiting for output audio" : nil
            if let lines = diagnosticLog.recordAudio(runtime.audioDiagnostics) { diagnostics = lines }
            for gap in gaps { record(gap) }
            if phase == .recording, runtime.snapshot.state != .recording {
                if gaps.contains(where: { $0.reason == .captureFailure(.leaseExpired) }) {
                    _ = terminate(reason: "Recording stopped because its connection lease expired. Press Start in Moss again.")
                    return
                }
                if gaps.contains(where: { $0.reason == .bufferFull || $0.reason == .expired }) { throw MeetingHostError.bufferExhausted }
                throw MeetingHostError.sourceChanged
            }
            if phase == .stopping, !controlInFlight, controlOutbox.pending == nil, runtime.snapshot.state == .finished {
                finish(); return
            }
            guard uploadAdmitted, [.recording, .stopping].contains(phase) else { return }
            let generation = sessionGeneration
            var initiationError: Error?
            var unrepresentableTail: MeetingAudioPacket?
            var deferredPacket: MeetingAudioPacket?
            let latestEnd = try remote.map { try timeline.nativeTime($0.elapsedMs) }
            let eligible = Set(MeetingAudioSource.allCases.filter { uploadTasks[$0] == nil && uploadRetry.permits($0, at: now) })
            let sent = try runtime.dispatchNextChunkWithAdmission(at: now, latestEndNanoseconds: latestEnd, eligibleSources: eligible) { packet, admission in
                do {
                    switch try self.send(packet, sessionGeneration: generation, admission: admission) {
                    case .started: break
                    case .tooShort: unrepresentableTail = packet
                    case .deferred: deferredPacket = packet
                    }
                }
                catch { initiationError = error }
            }
            if let packet = deferredPacket {
                runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: false)
            }
            if let packet = unrepresentableTail {
                // A sub-millisecond final tail cannot form a valid wire interval. Mark it as
                // a tiny visible gap and retire locally, outside the runtime's admission closure.
                runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: true)
                record(MeetingAudioGap(source: packet.source, epoch: packet.epoch, startNanoseconds: packet.startNanoseconds,
                    endNanoseconds: packet.endNanoseconds, reason: .retentionDeclined))
            }
            if let initiationError { throw initiationError }
            if !sent, phase == .stopping {
                do { try runtime.finish(at: now); finish() }
                catch MeetingAudioFailure.invalidTransition { /* A partial request remains in flight. */ }
            }
        } catch { interrupt(error: error) }
    }

    private func validateCurrentSources(_ fresh: MeetingInventorySnapshot) {
        guard phase == .recording, let choice, let selected else { return }
        guard choice.microphone == nil || ports.microphonePermission() == .granted,
              let current = try? fresh.resolve(choice), current == selected else {
            // Drop pending audio on membership change, including newly appearing Moss helpers.
            // This never replaces a failed app-scoped route with computer capture.
            sourceChanged()
            return
        }
    }

    private enum SendResult { case started, tooShort, deferred }
    private func send(_ packet: MeetingAudioPacket, sessionGeneration generation: Int,
                      admission: MeetingAudioBuffer) throws -> SendResult {
        guard let client, let activation, let grantId, let credential else { throw MeetingHostError.invalidResponse }
        guard let body = try timeline.audioBody(for: packet, meetingId: activation.meetingId, grantId: grantId) else { return .tooShort }
        let sentAt = self.now()
        let admitted = try admission.withSendAdmission {
            uploadTasks[packet.source] = try client.beginAudio(body, credential: credential) { [weak self] result in
                Task { @MainActor in
                    guard let self, generation == self.sessionGeneration else { return }
                    self.uploadTasks[packet.source] = nil
                    self.noteDiagnostic("audio", duration: self.now() - sentAt)
                    switch result {
                    case .success(let receipt):
                        let terminal = receipt.releasesAudio(matching: body.requestKey)
                        let failed = terminal && receipt.status == "failed"
                        if failed {
                            // Replay the server's retained gap with the exact upload identity and
                            // wire bounds; remapping native time would create a conflicting range.
                            self.queueGap(.init(id: body.requestKey, sourceId: body.sourceId, epoch: body.epoch,
                                startMs: body.startMs, endMs: body.endMs,
                                reason: receipt.code == "meeting_capture_interrupted" && receipt.reason == "audio-expired"
                                    ? "interrupted" : "processing-failed"))
                        }
                        if terminal {
                            self.timeline.acknowledge(packet, body: body)
                        }
                        self.runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: terminal)
                        if terminal {
                            self.uploadRetry.acknowledge(packet.source)
                        } else { self.uploadRetry.schedule(packet.source, after: receipt.retryAfterMs, now: self.now()) }
                        if failed { self.processingMessage = "Transcription missed a chunk. Recording continues; the gap is marked." }
                        if receipt.requestKey != body.requestKey || !["saved", "pending", "failed"].contains(receipt.status) {
                            self.processingMessage = "Transcription returned an unexpected receipt. This audio will retry within its memory limit."
                            self.noteDiagnostic("audio-receipt-invalid", duration: 0)
                        }
                    case .failure(let error):
                        self.runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: false)
                        if (error as? MeetingHostError) == .authorizationExpired { self.interrupt(error: error) }
                        else {
                            let delay: UInt64?
                            if let milliseconds = (error as? MeetingHostError)?.retryDelayMilliseconds { delay = milliseconds } else { delay = nil }
                            self.uploadRetry.schedule(packet.source, after: delay, now: self.now())
                            self.processingMessage = "Transcription delayed. Recording continues within the memory limit."
                        }
                    }
                }
            }
        }
        return admitted ? .started : .deferred
    }

    func interrupt(error: Error) {
        recordingDuration.pause(at: self.now())
        outputMessage = nil
        uploadAdmitted = false
        fence.interrupt()
        if runtime.snapshot.state == .recording {
            do {
                let now = self.now()
                recordingDuration.pause(at: now)
                try runtime.pause(at: now)
                timeline.pauseStartedNanoseconds = now
                timeline.pauseReason = "interrupted"
            }
            catch { cleanupBlocked = true }
        }
        if (error as? MeetingHostError) == .authorizationExpired {
            _ = terminate(reason: MeetingHostError.authorizationExpired.message); return
        }
        if (error as? MeetingAudioFailure) == .cleanupFailed { cleanupBlocked = true }
        if runtime.snapshot.state == .failed { _ = closeCaptureDiscarding(at: self.now()) }
        if cleanupBlocked {
            phase = .error
            message = MeetingHostError.cleanupFailed.message
            observed = .init(generation: remote?.generation ?? 0, phase: "error", errorCode: "native_cleanup_failed")
            return
        }
        if !stoppedByUser { phase = .paused }
        observed = .init(generation: remote?.generation ?? 0, phase: "paused", errorCode: (error as? MeetingHostError) == .bufferExhausted ? "native_buffer_full" : "native_capture_interrupted")
        message = (error as? MeetingHostError)?.message ?? "Audio capture paused. Check the selected source and microphone/system-audio permissions in macOS Settings, then press Resume in Moss."
    }

    /// Synchronous barrier before identity changes, Pause All or process termination.
    /// Receivers close and sends are disabled before task cancellation or credential removal.
    @discardableResult
    func terminate(reason: String) -> Bool {
        recordingPresentation.stop()
        cancelSourceChange()
        sourceSelectionError = nil
        uploadAdmitted = false
        var clean = true
        recordingDuration.pause(at: self.now())
        do { try runtime.terminate(at: self.now()) } catch { clean = false }
        sessionGeneration += 1
        pollTask?.cancel(); pollTask = nil
        controlTask?.cancel(); controlTask = nil
        uploadTasks.values.forEach { $0.cancel() }; uploadTasks.removeAll()
        uploadRetry = MeetingCaptureUploadRetry(); diagnosticLog.resetAudio()
        client?.close(); client = nil
        backlogMessage = nil
        outputMessage = nil
        credential = nil; grantId = nil; grantExpiry = nil; startCommandDeadline = nil; initialStartGeneration = nil; leaseDeadlineNanoseconds = 0
        timer?.invalidate(); timer = nil
        for (center, observer) in observers { center.removeObserver(observer) }
        observers.removeAll()
        choice = nil; selected = nil; remote = nil; timeline = MeetingCaptureTimeline()
        pausedCaptureCutoff = nil
        fence = MeetingCommandFence(); controlInFlight = false; controlRetryAtNanoseconds = 0; controlOutbox = MeetingControlOutbox()
        observed = .init(generation: 0, phase: "idle", errorCode: nil)
        cleanupBlocked = !clean
        phase = clean ? .stopped : .error
        message = clean ? reason : MeetingHostError.cleanupFailed.message
        return clean
    }

    func beforeConnectionEvent(_ event: ConnectionEvent) -> Bool {
        switch event {
        case .userLogout:
            recordingConnection.stop()
            _ = terminate(reason: "Meeting capture ended. Waiting for Moss to confirm Unlink.")
            // Admission and buffers close even if a driver retains a handle. Do not let a
            // cleanup failure prevent the server from revoking this Mac's authority.
            return true
        case .userDisconnect, .userQuit:
            recordingConnection.stop()
            return terminate(reason: "Meeting capture ended. Start a new meeting in Moss to record.")
        case .linkCompleted(_, _, let generation) where generation == connection.currentGeneration:
            recordingConnection.stop()
            return terminate(reason: "Account changed. Press Start meeting in Moss again.")
        case .heartbeatFailed(let error, let generation) where generation == connection.currentGeneration:
            if error == .credentialInvalid {
                recordingConnection.stop()
                _ = terminate(reason: MeetingHostError.authorizationExpired.message)
            } else if case .accountBlocked = error {
                recordingConnection.stop()
                _ = terminate(reason: MeetingHostError.authorizationExpired.message)
            }
            return true
        default: return true
        }
    }

    func openMeetingInBrowser() {
        guard let activation else { connection.openInstanceInBrowser(); return }
        guard let url = activation.browserURL else { show(MeetingHostError.invalidActivation); return }
        NSWorkspace.shared.open(url)
    }

    /// Source churn is an admission failure. Retained resource handles survive a failed teardown,
    /// and both Stop and the service tick can retry them without reopening any source.
    func sourceChanged() {
        if sourceChangeIntent != nil { failSourceChange(MeetingHostError.sourceChanged) }
        if let pending = controlOutbox.pending, pending.command == "record" {
            // Cancel queued Resume, or follow an already-dispatched Resume with Pause.
            controlOutbox.stage(command: "pause", meetingId: pending.meetingId, grantId: pending.grantId,
                generation: pending.expectedGeneration)
            controlRetryAtNanoseconds = 0
        }
        let now = self.now()
        recordDiscardedTail(at: now, reason: "source-unavailable")
        timeline.pauseStartedNanoseconds = now
        timeline.pauseReason = "interrupted"
        _ = closeCaptureDiscarding(at: now)
        interrupt(error: MeetingHostError.sourceChanged)
    }

    private func closeCaptureDiscarding(at now: UInt64) -> Bool {
        uploadAdmitted = false
        recordingDuration.pause(at: now)
        do {
            try runtime.terminate(at: now)
            cleanupBlocked = false
            return true
        } catch {
            cleanupBlocked = true
            return false
        }
    }

    private func recordPauseGap(endingAt end: UInt64) {
        for gap in timeline.endPause(at: end, localEpoch: runtime.snapshot.epoch) { queueGap(gap) }
    }

    private func record(_ gap: MeetingAudioGap) {
        if let mapped = timeline.map(gap) { queueGap(mapped) }
    }

    private func recordDiscardedTail(at now: UInt64, reason: String) {
        guard timeline.epochs[runtime.snapshot.epoch] != nil else { return }
        for gap in timeline.discardedTail(localEpoch: runtime.snapshot.epoch, at: now, reason: reason) { queueGap(gap) }
        if timeline.pauseGapSelection != nil { recordPauseGap(endingAt: now) }
    }

    /// Bounded metadata admission, separate from clock mapping so its terminal UI state can be
    /// exercised with generated ranges and no capture device or authenticated transport.
    func queueGap(_ gap: MeetingCaptureGap) {
        gapCount += 1
        if gapCoverageIncomplete { return }
        guard timeline.pendingGaps.count < 256 else {
            uploadAdmitted = false
            _ = closeCaptureDiscarding(at: self.now())
            gapCoverageIncomplete = true
            fence.interrupt()
            observed = .init(generation: remote?.generation ?? 0, phase: cleanupBlocked ? "error" : "paused", errorCode: "native_gap_limit")
            phase = cleanupBlocked ? .error : .paused
            message = cleanupBlocked ? MeetingHostError.cleanupFailed.message
                : "Too many audio gaps are waiting to be saved. Coverage is incomplete; Stop and review this meeting in Moss."
            return
        }
        timeline.pendingGaps.append(gap)
    }

    private func noteDiagnostic(_ stage: String, duration: UInt64) {
        diagnostics = diagnosticLog.note(stage, duration: duration)
    }

    private func finish() {
        if let cutoff = remote?.stopCutoffMs, let boundary = try? timeline.nativeTime(cutoff) {
            recordPauseGap(endingAt: boundary)
        }
        uploadAdmitted = false
        phase = .stopped
        outputMessage = nil
        observed = .init(generation: remote?.generation ?? observed.generation, phase: "stopped", errorCode: nil)
        if gapCoverageIncomplete {
            message = "Recording stopped. Gap details reached their limit; transcript coverage is incomplete. Review it in Moss."
        } else {
            message = gapCount == 0 ? "Recording stopped. Open Moss to review the transcript." : "Recording stopped with \(gapCount) audio gap(s). Review the transcript in Moss."
        }
    }

    private func show(_ error: Error) {
        phase = .error
        if cleanupBlocked { message = MeetingHostError.cleanupFailed.message; return }
        message = (error as? MeetingHostError)?.message ?? "Capture is unavailable. Check this meeting in Moss."
    }

    private func now() -> UInt64 { ports.now() }

    // Native controls and source transitions share this file to keep mutation private.

    func resumeFromUserClick() {
        guard canResumeFromUserClick, let activation, let grantId, let remote else { return }
        uploadAdmitted = false
        controlRetryAtNanoseconds = 0
        controlOutbox.stage(command: "record", meetingId: activation.meetingId, grantId: grantId,
            generation: remote.generation)
        message = "Paused. Waiting for Moss to confirm Resume."
        retryPendingControl()
    }

    func pauseFromUserClick() { localControl("pause") }
    func stopFromUserClick() {
        cancelSourceChange()
        if cleanupBlocked { _ = terminate(reason: "Recording stopped."); return }
        localControl("stop")
    }

    private func localControl(_ command: String) {
        guard let activation, let grantId, let remote,
              phase == .recording || (command == "stop" && [.ready, .paused, .stopping].contains(phase)) else { return }
        if command == "stop", phase == .stopping { retryPendingControl(); return }
        uploadAdmitted = false
        do {
            if command == "pause" {
                let now = self.now()
                recordingDuration.pause(at: now)
                try runtime.pause(at: now)
                timeline.pauseStartedNanoseconds = now
                timeline.pauseReason = "paused"
                phase = .paused
            }
            else {
                if ![.idle, .ready, .finished].contains(runtime.snapshot.state) {
                    recordPauseGap(endingAt: self.now())
                    if ![.idle, .ready, .finished].contains(runtime.snapshot.state) {
                        recordingDuration.pause(at: self.now())
                        try runtime.stop(at: self.now(), captureCutoffNanoseconds: pausedCaptureCutoff)
                    }
                }
                phase = .stopping
                stoppedByUser = true
            }
        } catch { interrupt(error: error); return }
        observed = .init(generation: remote.generation, phase: command == "pause" ? "paused" : "stopped", errorCode: nil)
        outputMessage = nil
        message = command == "pause" ? "Paused. No new audio is captured or sent." : "Recording stopped. Finishing captured audio."
        controlRetryAtNanoseconds = 0
        controlOutbox.stage(command: command, meetingId: activation.meetingId, grantId: grantId,
            generation: remote.generation)
        retryPendingControl()
    }

    private func retryPendingControl() {
        guard !controlInFlight, self.now() >= controlRetryAtNanoseconds, let body = controlOutbox.pending, let client, let credential else { return }
        controlInFlight = true
        uploadAdmitted = false
        let generation = sessionGeneration
        controlTask = Task { [weak self] in
            guard let self, generation == self.sessionGeneration, !Task.isCancelled else { return }
            defer {
                if generation == self.sessionGeneration {
                    self.controlInFlight = false
                    self.controlTask = nil
                }
            }
            do {
                guard body.command != "record" || self.controlOutbox.pending?.requestKey == body.requestKey else { return }
                let reply = try await client.control(body, credential: credential)
                guard generation == self.sessionGeneration else { return }
                guard reply.capture.grantId == self.grantId, reply.capture.deviceId == self.ports.identity()?.deviceId else {
                    throw MeetingHostError.authorizationExpired
                }
                try reply.capture.validate()
                self.controlRetryAtNanoseconds = 0
                self.controlOutbox.received(requestKey: body.requestKey, desired: reply.capture.desired)
                guard self.controlOutbox.accepts(generation: reply.capture.generation) else { return }
                if body.command == "pause" || body.command == "stop" { try self.reconcileClosedSourceEpoch(reply.capture) }
                self.controlOutbox.reconcile(generation: reply.capture.generation, desired: reply.capture.desired,
                    retainedSourceMatches: reply.capture.selection == self.choice)
                self.remote = reply.capture
                if body.command == "pause" {
                    self.pausedCaptureCutoff = try reply.capture.epochEndMs.map(self.timeline.nativeTime)
                    if let cutoff = self.pausedCaptureCutoff { self.runtime.tightenPauseCutoff(to: cutoff) }
                }
                // Resume acknowledgment does not open hardware or consume the recording fence.
                // Keep the prior paused observation until the normal status/apply path starts
                // the acknowledged epoch, then a later status admits its first audio upload.
                if body.command != "record" {
                    _ = self.fence.shouldStart(generation: reply.capture.generation, desired: reply.capture.desired)
                    self.observed = .init(generation: reply.capture.generation,
                        phase: self.stoppedByUser ? "stopped" : "paused", errorCode: nil)
                }
                if body.command == "stop", let cutoff = [reply.capture.stopCutoffMs, reply.capture.epochEndMs].compactMap({ $0 }).min(), self.runtime.snapshot.stopCutoffNanoseconds != nil {
                    try self.runtime.tightenStopCutoff(to: self.timeline.nativeTime(cutoff))
                }
                // A later status must acknowledge this observation before any final flush.
                self.uploadAdmitted = false
            } catch {
                guard generation == self.sessionGeneration else { return }
                if (error as? MeetingHostError) == .authorizationExpired {
                    _ = self.terminate(reason: MeetingHostError.authorizationExpired.message)
                } else if body.command == "record", (error as? MeetingHostError) == .rejected {
                    if self.controlOutbox.rejectResume(requestKey: body.requestKey) {
                        self.message = "Resume was not accepted. Check the selected sources in Moss, then press Resume again."
                    }
                } else {
                    // Keep the request and UUID. The polling loop reconciles conflicts and
                    // retries delivery; a new explicit Start can never override pending Stop.
                    self.uploadAdmitted = false
                    self.controlRetryAtNanoseconds = self.now() + ((error as? MeetingHostError)?.retryDelayMilliseconds ?? 2000) * 1_000_000
                    if body.command == "record" {
                        self.message = "Paused. Resume is not confirmed. Waiting for Moss."
                    } else {
                        self.message = body.command == "stop" ? "Recording stopped on this Mac. Waiting to confirm Stop with Moss." : "Paused on this Mac. Waiting to confirm Pause with Moss."
                    }
                }
            }
        }
    }

    /// A control conflict can disclose an epoch we have not seen yet. Keep its old gaps local
    /// until status (or the Stop/Pause receipt) supplies the authoritative source boundary.
    private func gapsForStatus() -> [MeetingCaptureGap] {
        guard sourceChangeIntent == nil, controlOutbox.pending == nil, !controlInFlight else { return [] }
        return Array(timeline.pendingGaps.filter { $0.endMs <= (remote?.elapsedMs ?? 0) }.prefix(32))
    }

    private func reconcileClosedSourceEpoch(_ capture: MeetingRemoteCapture) throws {
        guard runtime.snapshot.state != .recording,
              let oldEpoch = timeline.pauseGapSelection?.epoch ?? timeline.epochs[runtime.snapshot.epoch]?.remoteEpoch,
              capture.epoch > max(oldEpoch, timeline.sourceBoundaryEpoch) else { return }
        try adoptPausedSourceChoice(capture)
    }

    var currentSourceChoice: MeetingCaptureChoice? { choice ?? remote?.selection }
    var canChangeSourcesFromUserClick: Bool {
        ((phase == .recording && remote?.desired == "recording") ||
            (phase == .paused && remote?.desired == "paused")) &&
            sourceChangeIntent == nil && !controlInFlight && controlOutbox.pending == nil &&
            !stoppedByUser && !cleanupBlocked && !gapCoverageIncomplete && !timeline.epochs.isEmpty &&
            credential != nil && grantExpiry.map({ ports.wallNow() < $0 }) == true && now() < leaseDeadlineNanoseconds
    }

    func dismissSourceSelectionError() { sourceSelectionError = nil }

    func selectMicrophoneFromUserClick(_ microphone: MeetingCaptureChoice.Microphone?) {
        guard canChangeSourcesFromUserClick, let current = currentSourceChoice else { return }
        do { try changeSourcesFromUserClick(MeetingSourceChoice.microphone(microphone, in: current)) }
        catch { sourceSelectionError = MeetingSourceChoice.message(error) }
    }

    func setComputerAudioFromUserClick(_ enabled: Bool) {
        guard canChangeSourcesFromUserClick, let current = currentSourceChoice else { return }
        do {
            let fresh = try ports.readInventory()
            try changeSourcesFromUserClick(MeetingSourceChoice.computerAudio(enabled, in: current, inventory: fresh.wire))
        } catch { sourceSelectionError = MeetingSourceChoice.message(error) }
    }

    func changeSourcesFromUserClick(_ selection: MeetingCaptureChoice) throws {
        guard canChangeSourcesFromUserClick, let activation, let grantId, let remote else { return }
        // Validate the entire advertised identity and scope before closing devices or networking.
        let fresh = try ports.readInventory()
        _ = try fresh.resolve(selection)
        guard selection != currentSourceChoice else { return }
        let intent = MeetingSourceChangeIntent(body: .init(meetingId: activation.meetingId,
            grantId: grantId, requestKey: UUID().uuidString.lowercased(), expectedGeneration: remote.generation,
            command: "change-sources", expectedEpoch: remote.epoch, selection: selection), desired: remote.desired)
        sourceSelectionError = nil
        uploadAdmitted = false
        sourceChangeRevision += 1
        do {
            let boundary = now()
            if runtime.snapshot.state == .recording {
                recordingDuration.pause(at: boundary)
                try runtime.pause(at: boundary)
                timeline.pauseStartedNanoseconds = boundary
                timeline.pauseReason = "interrupted"
            }
            // pause() closes receivers and releases every old device synchronously.
            sourceChangeIntent = intent
            phase = .paused
            observed = .init(generation: remote.generation, phase: "paused", errorCode: nil)
            message = "Paused while Moss confirms the new audio sources."
            retrySourceChange()
        } catch {
            interrupt(error: error)
            sourceSelectionError = cleanupBlocked ? MeetingHostError.cleanupFailed.message : MeetingSourceChoice.message(error)
        }
    }

    private func retrySourceChange() {
        guard sourceChangeTask == nil, var intent = sourceChangeIntent, intent.awaitingControl,
              now() >= intent.retryAtNanoseconds, let client, let credential else { return }
        guard intent.attempts < 3, !stoppedByUser, !cleanupBlocked,
              grantExpiry.map({ ports.wallNow() < $0 }) == true, now() < leaseDeadlineNanoseconds else {
            failSourceChange(MeetingHostError.network)
            return
        }
        intent.attempts += 1
        sourceChangeIntent = intent
        let body = intent.body
        let generation = sessionGeneration
        sourceChangeTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == self.sessionGeneration, self.sourceChangeIntent?.body.requestKey == body.requestKey {
                    self.sourceChangeTask = nil
                }
            }
            do {
                guard !Task.isCancelled, self.sourceChangeIntent?.body.requestKey == body.requestKey else { return }
                let reply = try await client.control(body, credential: credential)
                guard generation == self.sessionGeneration, !Task.isCancelled,
                      self.sourceChangeIntent?.body.requestKey == body.requestKey else { return }
                guard reply.capture.grantId == self.grantId, reply.capture.deviceId == self.ports.identity()?.deviceId else {
                    throw MeetingHostError.authorizationExpired
                }
                try reply.capture.validate()
                guard intent.matches(reply.capture) else { throw MeetingHostError.rejected }
                self.sourceChangeIntent?.acknowledged = true
                // The control acknowledgment never opens hardware or updates the observation.
                // Ordinary status must confirm this same selection and epoch before apply().
                self.remote = reply.capture
                self.uploadAdmitted = false
            } catch {
                guard generation == self.sessionGeneration, !Task.isCancelled,
                      self.sourceChangeIntent?.body.requestKey == body.requestKey else { return }
                if (error as? MeetingHostError) == .authorizationExpired {
                    _ = self.terminate(reason: MeetingHostError.authorizationExpired.message)
                } else if ((error as? MeetingHostError) == .network || (error as? MeetingHostError)?.retryDelayMilliseconds != nil),
                          intent.attempts < 3 {
                    let delay = min(5000, (error as? MeetingHostError)?.retryDelayMilliseconds ?? 2000)
                    self.sourceChangeIntent?.retryAtNanoseconds = self.now() + delay * 1_000_000
                    self.message = "Paused. Waiting to confirm the new audio sources with Moss."
                } else { self.failSourceChange(error) }
            }
        }
    }

    /// Called only by ordinary status, after the local revision fence rejected older replies.
    private func reconcileSourceChangeStatus(_ capture: MeetingRemoteCapture) throws {
        guard let intent = sourceChangeIntent else { return }
        guard intent.acknowledged, intent.matches(capture) else {
            failSourceChange(MeetingHostError.rejected)
            throw MeetingHostError.rejected
        }
        try adoptPausedSourceChoice(capture)
        sourceChangeIntent = nil
        sourceChangeTask = nil
    }

    /// This only mirrors an authoritative paused choice. It cannot resume a failed intent.
    /// A lost final control reply may still have committed; the next explicit click uses the
    /// choice that ordinary status confirms after the failure has converged to Pause.
    private func adoptPausedSourceChoice(_ capture: MeetingRemoteCapture) throws {
        guard let selection = capture.selection else { throw MeetingHostError.invalidResponse }
        guard capture.epoch > timeline.sourceBoundaryEpoch else { return }
        let boundary = try timeline.nativeTime(capture.epochStartMs)
        runtime.tightenPauseCutoff(to: boundary)
        runtime.clearPauseGapForSourceChange()
        for gap in timeline.adoptPausedSources(capture, selection: selection, boundary: boundary,
            localEpoch: runtime.snapshot.epoch, stoppedByUser: stoppedByUser) { queueGap(gap) }
        choice = selection
        selected = nil
        let currentInventory = try ports.readInventory().wire
        sourceDescription = Self.describe(selection, inventory: currentInventory)
    }

    private func cancelSourceChange() {
        guard sourceChangeIntent != nil || sourceChangeTask != nil else { return }
        sourceChangeRevision += 1
        sourceChangeIntent = nil
        sourceChangeTask?.cancel()
        sourceChangeTask = nil
        uploadAdmitted = false
    }

    private func failSourceChange(_ error: Error) {
        guard let intent = sourceChangeIntent else { return }
        cancelSourceChange()
        fence.interrupt()
        sourceSelectionError = MeetingSourceChoice.message(error)
        message = sourceSelectionError ?? MeetingHostError.rejected.message
        // An uncertain source command may have committed. Converge to Pause through the
        // ordinary outbox; never resume that intent or mint another source-change UUID.
        if !stoppedByUser, !cleanupBlocked {
            phase = .paused
            controlOutbox.stage(command: "pause", meetingId: intent.body.meetingId,
                grantId: intent.body.grantId, generation: remote?.generation ?? intent.body.expectedGeneration)
            controlRetryAtNanoseconds = 0
            retryPendingControl()
        }
    }

}
