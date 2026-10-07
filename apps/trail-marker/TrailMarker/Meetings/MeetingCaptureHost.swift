import AppKit
import AudioToolbox
import Combine
import Foundation

/// App-lifetime capture host. The shared connection advertises sources without opening them.
/// Initial capture requires a fresh browser Start; native Resume retains that claimed session.
@MainActor
final class MeetingCaptureHost: ObservableObject {
    enum Phase: String { case unprepared, ready, recording, paused, stopping, stopped, error }
    @Published var phase: Phase = .unprepared {
        didSet { refreshRecordingPresentation() }
    }
    @Published var recordingPresentation = MeetingRecordingPresentation()
    @Published var message = "Choose sources and press Start meeting in Moss."
    @Published var processingMessage: String?
    @Published var connectivityMessage: String?
    @Published var backlogMessage: String?
    @Published var outputMessage: String?
    @Published var diagnostics: [String] = []
    @Published var activation: MeetingActivation?
    @Published var inventory: MeetingCaptureInventory?
    @Published var sourceDescription = "No audio sources selected"
    @Published var cleanupBlocked = false
    @Published var gapCount = 0
    @Published var gapCoverageIncomplete = false

    let connection: ConnectionRuntime
    let ports: MeetingCaptureHostPorts
    let runtime: MeetingCaptureRuntime
    var client: MeetingCaptureClient?
    var credential: String?
    var grantId: String?
    var grantExpiry: Date?
    var pollTask: Task<Void, Never>?
    var controlTask: Task<Void, Never>?
    var uploadTasks: [MeetingAudioSource: URLSessionDataTask] = [:]
    var uploadRetryAt: [MeetingAudioSource: UInt64] = [:]
    var uploadFailures: [MeetingAudioSource: Int] = [:]
    var lastAudioDiagnostics: [MeetingAudioSource: String] = [:]
    var startCommandDeadline: Date?
    var initialStartGeneration: Int?
    var leaseDeadlineNanoseconds: UInt64 = 0
    lazy var recordingConnection = MeetingRecordingConnection(connection: connection, activate: { [weak self] command, claim, credential, origin in
        try self?.acceptStart(command, claim: claim, credential: credential, origin: origin)
    }, report: { [weak self] text in
        guard let self else { return }
        self.connectivityMessage = text
    })
    var timer: Timer?
    var sessionGeneration = 0
    var fence = MeetingCommandFence()
    var observed = MeetingCaptureObserved(generation: 0, phase: "idle", errorCode: nil)
    @Published var remote: MeetingRemoteCapture?
    var selected: MeetingInventorySnapshot.Resolved?
    var choice: MeetingCaptureChoice?
    var originNanoseconds: UInt64?
    var recordingDuration = MeetingRecordingDuration()
    var uploadAdmitted = false
    var stoppedByUser = false
    @Published var controlInFlight = false
    var controlRetryAtNanoseconds: UInt64 = 0
    @Published var controlOutbox = MeetingControlOutbox()
    var pauseStartedNanoseconds: UInt64?
    var pauseReason = "paused"
    var pausedCaptureCutoff: UInt64?
    var observers: [(NotificationCenter, NSObjectProtocol)] = []
    struct Epoch {
        let remoteEpoch: UInt64
        let generation: Int
        let choice: MeetingCaptureChoice
        let startNanoseconds: UInt64
        var endNanoseconds: UInt64? = nil
    }
    var epochs: [UInt64: Epoch] = [:]
    var uploadSequencer = MeetingUploadSequencer()
    var pendingGaps: [MeetingCaptureGap] = []
    @Published var sourceSelectionError: String?
    var sourceChangeIntent: MeetingSourceChangeIntent?
    var sourceChangeTask: Task<Void, Never>?
    var sourceChangeRevision = 0
    var pauseGapSelection: (epoch: UInt64, choice: MeetingCaptureChoice)?
    var sourceBoundaryEpoch: UInt64 = 0
    var acknowledgedEnds: [MeetingUploadSequencer.Stream: UInt64] = [:]

    init(connection: ConnectionRuntime, runtime: MeetingCaptureRuntime? = nil, ports: MeetingCaptureHostPorts? = nil, factory: @escaping MeetingCaptureRuntime.DeviceFactory = MeetingCaptureHost.devices) {
        self.connection = connection
        self.ports = ports ?? .live(connection: connection)
        self.runtime = runtime ?? MeetingCaptureRuntime(factory: factory)
    }

    nonisolated static func devices(_ selection: MeetingNativeSelection) throws -> [MeetingAudioSource: MeetingAudioCapturing] {
        try selection.validate()
        var devices: [MeetingAudioSource: MeetingAudioCapturing] = [:]
        if let microphone = selection.microphoneDeviceID {
            devices[.microphone] = MeetingMicrophoneCapture(selectedDeviceID: microphone)
        }
        if let output = selection.output {
            guard #available(macOS 14.2, *) else { throw MeetingHostError.unavailable }
            devices[.output] = CoreAudioMeetingOutput(scope: output)
        }
        return devices
    }

    var isRecording: Bool { phase == .recording || cleanupBlocked }
    var canStop: Bool { [.recording, .paused, .stopping].contains(phase) || (phase == .ready && grantId != nil) || cleanupBlocked }

    var canResumeFromUserClick: Bool {
        sourceChangeIntent == nil && phase == .paused && remote?.desired == "paused" && remote?.selection == choice &&
            !epochs.isEmpty && !stoppedByUser && !cleanupBlocked && !gapCoverageIncomplete &&
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
        originNanoseconds = origin
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
                    finalized: phase == .stopped && pendingGaps.isEmpty ? true : nil,
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
                if epochs.isEmpty {
                    let candidate = try MeetingCaptureClock(requestSent: requestSent, responseReceived: now,
                        elapsedMilliseconds: reply.capture.elapsedMs).originNanoseconds
                    originNanoseconds = max(originNanoseconds ?? candidate, candidate)
                }
                let acknowledgedGapIDs = Set((reply.capture.gaps ?? []).map(\.id))
                pendingGaps = MeetingGapDelivery.remaining(pendingGaps, acknowledgedIDs: acknowledgedGapIDs,
                    limitReached: reply.capture.gapLimitReached == true)
                if reply.capture.gapLimitReached == true, !gapCoverageIncomplete {
                    gapCoverageIncomplete = true
                    if phase == .recording { interrupt(error: MeetingHostError.rejected) }
                    if !cleanupBlocked {
                        message = "The meeting reached its audio-gap limit. Coverage is incomplete; Stop and review the transcript in Moss."
                    }
                }
                if phase == .stopped, reply.capture.desired == "stopped", pendingGaps.isEmpty, reply.capture.finalization == "complete" {
                    _ = terminate(reason: message)
                    return
                }
                remote = reply.capture
                if let cutoff = reply.capture.stopCutoffMs {
                    pendingGaps = pendingGaps.compactMap { gap in
                        guard gap.startMs < cutoff else { return nil }
                        return MeetingCaptureGap(id: gap.id, sourceId: gap.sourceId, epoch: gap.epoch,
                            startMs: gap.startMs, endMs: min(gap.endMs, cutoff), reason: gap.reason)
                    }
                }
                if !controlInFlight, controlOutbox.pending == nil {
                    try await apply(reply.capture, inventory: try ports.readInventory(), at: now)
                }
                guard generation == sessionGeneration, !Task.isCancelled else { return }
                retryPendingControl()
                // The status request has acknowledged this exact epoch before its first audio send.
                uploadAdmitted = sourceChangeIntent == nil && reply.capture.selection == choice &&
                    (phase == .stopping || epochs[runtime.snapshot.epoch]?.remoteEpoch == reply.capture.epoch) &&
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
                let cutoff = try [next.stopCutoffMs, next.epochEndMs].compactMap { $0 }.min().map(nativeTime)
                recordPauseGap(endingAt: try next.stopCutoffMs.map(nativeTime) ?? now)
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
            if next.selection != choice, !epochs.isEmpty { try adoptPausedSourceChoice(next) }
        }
        if next.desired == "paused", phase == .ready {
            observed = .init(generation: next.generation, phase: "paused", errorCode: nil)
            phase = .paused
            message = "Start is paused. Check the selected sources and press Resume in Moss."
        }
        if next.desired == "paused", phase == .recording {
            pausedCaptureCutoff = try next.epochEndMs.map(nativeTime)
            recordingDuration.pause(at: min(now, pausedCaptureCutoff ?? now))
            try runtime.pause(at: now, captureCutoffNanoseconds: pausedCaptureCutoff)
            pauseStartedNanoseconds = pausedCaptureCutoff ?? now
            pauseReason = "paused"
            uploadAdmitted = false
            observed = .init(generation: next.generation, phase: "paused", errorCode: nil)
            phase = .paused
            message = "Paused. No new audio is captured or sent. Press Resume in Moss."
        }
        if next.desired == "paused", phase == .paused, !cleanupBlocked, observed.generation != next.generation {
            // A native fault may have already closed capture before Moss advances Pause.
            // Acknowledge that version without reopening/stopping devices or losing the cause.
            if let cutoff = try next.epochEndMs.map(nativeTime) {
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
            if epochs.isEmpty {
                let candidate = try MeetingCaptureClock(requestSent: permissionCheckSent, responseReceived: self.now(),
                    elapsedMilliseconds: check.capture.elapsedMs).originNanoseconds
                originNanoseconds = max(originNanoseconds ?? candidate, candidate)
            }
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
        if let previousEpoch = pauseGapSelection?.epoch ?? epochs[runtime.snapshot.epoch]?.remoteEpoch,
           next.epoch > previousEpoch { try adoptPausedSourceChoice(next) }
        if runtime.snapshot.state == .paused {
            try runtime.resume(selection: resolved.selection, readiness: readiness, permitRetainedAudio: true, at: now)
        } else {
            if pauseGapSelection == nil { recordPauseGap(endingAt: now) }
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
        if pauseGapSelection != nil { recordPauseGap(endingAt: now) }
        recordingDuration.start(at: self.now())
        epochs[runtime.snapshot.epoch] = Epoch(remoteEpoch: next.epoch, generation: next.generation, choice: selection, startNanoseconds: now)
        pauseStartedNanoseconds = nil
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
            recordAudioDiagnostics()
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
            let latestEnd = try remote.map { try nativeTime($0.elapsedMs) }
            let eligible = Set(MeetingAudioSource.allCases.filter { uploadTasks[$0] == nil && now >= (uploadRetryAt[$0] ?? 0) })
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
        guard let client, let activation, let grantId, let credential,
              let epoch = epochs[packet.epoch], let origin = originNanoseconds,
              packet.startNanoseconds >= origin else { throw MeetingHostError.invalidResponse }
        if MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: packet.endNanoseconds - origin)
            == MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: packet.startNanoseconds - origin) { return .tooShort }
        let bounds = try MeetingWireAudioBoundary(packet: packet, originNanoseconds: origin)
        let start = bounds.startMs
        let end = bounds.endMs
        let source = packet.source == .microphone ? epoch.choice.microphone?.sourceId : epoch.choice.outputSourceId
        guard let source else { throw MeetingHostError.invalidResponse }
        let identity = uploadSequencer.identity(epoch: epoch.remoteEpoch, source: source, callbackSequence: packet.sequence)
        let key = identity.requestKey
        let body = MeetingCaptureAudioBody(meetingId: activation.meetingId, grantId: grantId, requestKey: key,
            generation: epoch.generation, epoch: epoch.remoteEpoch, sourceId: source, sequence: identity.sequence,
            startMs: start, endMs: end, sampleRateHz: Int(packet.sampleRate),
            pcmBase64: try MeetingPCMEncoder.encode(packet.samples))
        let sentAt = self.now()
        let admitted = try admission.withSendAdmission {
            uploadTasks[packet.source] = try client.beginAudio(body, credential: credential) { [weak self] result in
                Task { @MainActor in
                    guard let self, generation == self.sessionGeneration else { return }
                    self.uploadTasks[packet.source] = nil
                    self.noteDiagnostic("audio", duration: self.now() - sentAt)
                    switch result {
                    case .success(let receipt):
                        let terminal = receipt.releasesAudio(matching: key)
                        let failed = terminal && receipt.status == "failed"
                        if failed {
                            // Replay the server's retained gap with the exact upload identity and
                            // wire bounds; remapping native time would create a conflicting range.
                            self.queueGap(.init(id: key, sourceId: source, epoch: epoch.remoteEpoch,
                                startMs: start, endMs: end,
                                reason: receipt.code == "meeting_capture_interrupted" && receipt.reason == "audio-expired"
                                    ? "interrupted" : "processing-failed"))
                        }
                        if terminal {
                            self.uploadSequencer.acknowledge(epoch: epoch.remoteEpoch, source: source, callbackSequence: packet.sequence)
                            self.acknowledgedEnds[.init(epoch: packet.epoch, source: source)] = packet.endNanoseconds
                        }
                        self.runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: terminal)
                        if terminal {
                            self.uploadFailures[packet.source] = 0
                            self.uploadRetryAt[packet.source] = nil
                        } else { self.scheduleAudioRetry(packet.source, after: receipt.retryAfterMs) }
                        if failed { self.processingMessage = "Transcription missed a chunk. Recording continues; the gap is marked." }
                        if receipt.requestKey != key || !["saved", "pending", "failed"].contains(receipt.status) {
                            self.processingMessage = "Transcription returned an unexpected receipt. This audio will retry within its memory limit."
                            self.noteDiagnostic("audio-receipt-invalid", duration: 0)
                        }
                    case .failure(let error):
                        self.runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: false)
                        if (error as? MeetingHostError) == .authorizationExpired { self.interrupt(error: error) }
                        else {
                            let delay: UInt64?
                            if let milliseconds = (error as? MeetingHostError)?.retryDelayMilliseconds { delay = milliseconds } else { delay = nil }
                            self.scheduleAudioRetry(packet.source, after: delay)
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
                pauseStartedNanoseconds = now
                pauseReason = "interrupted"
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
        uploadRetryAt.removeAll(); uploadFailures.removeAll(); lastAudioDiagnostics.removeAll()
        client?.close(); client = nil
        backlogMessage = nil
        outputMessage = nil
        credential = nil; grantId = nil; grantExpiry = nil; startCommandDeadline = nil; initialStartGeneration = nil; leaseDeadlineNanoseconds = 0
        timer?.invalidate(); timer = nil
        for (center, observer) in observers { center.removeObserver(observer) }
        observers.removeAll()
        choice = nil; selected = nil; remote = nil; originNanoseconds = nil
        pauseStartedNanoseconds = nil; pausedCaptureCutoff = nil; pauseReason = "paused"; pauseGapSelection = nil; sourceBoundaryEpoch = 0
        epochs.removeAll(); pendingGaps.removeAll(); acknowledgedEnds.removeAll(); uploadSequencer = MeetingUploadSequencer(); fence = MeetingCommandFence(); controlInFlight = false; controlRetryAtNanoseconds = 0; controlOutbox = MeetingControlOutbox()
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
        pauseStartedNanoseconds = now
        pauseReason = "interrupted"
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

    func recordPauseGap(endingAt end: UInt64) {
        guard let start = pauseStartedNanoseconds else { return }
        let context = pauseGapSelection ?? epochs[runtime.snapshot.epoch].map { (epoch: $0.remoteEpoch, choice: $0.choice) }
        guard let context else { return }
        pauseStartedNanoseconds = nil
        pauseGapSelection = nil
        for source in [context.choice.microphone?.sourceId, context.choice.outputSourceId].compactMap({ $0 }) {
            recordGap(source: source, epoch: context.epoch, start: start, end: end, reason: pauseReason)
        }
    }

    private func record(_ gap: MeetingAudioGap) {
        guard let epoch = epochs[gap.epoch] else { return }
        let source = gap.source == .microphone ? epoch.choice.microphone?.sourceId : epoch.choice.outputSourceId
        guard let source else { return }
        let reason: String
        switch gap.reason {
        case .paused: reason = pauseReason
        case .expired: reason = "expired"
        case .bufferFull: reason = "buffer-full"
        case .captureFailure: reason = "source-unavailable"
        case .callbackContention: reason = "interrupted"
        case .retentionDeclined, .cutoffChanged: reason = "discarded"
        }
        recordGap(source: source, epoch: epoch.remoteEpoch, start: gap.startNanoseconds,
            end: min(gap.endNanoseconds, epoch.endNanoseconds ?? gap.endNanoseconds), reason: reason)
    }

    private func recordDiscardedTail(at now: UInt64, reason: String) {
        let localEpoch = runtime.snapshot.epoch
        guard let epoch = epochs[localEpoch] else { return }
        let sources = [epoch.choice.microphone?.sourceId, epoch.choice.outputSourceId].compactMap { $0 }
        for source in sources {
            let start = acknowledgedEnds[.init(epoch: localEpoch, source: source)] ?? epoch.startNanoseconds
            recordGap(source: source, epoch: epoch.remoteEpoch, start: start,
                end: min(now, epoch.endNanoseconds ?? now), reason: reason)
        }
        if pauseGapSelection != nil { recordPauseGap(endingAt: now) }
    }

    func recordGap(source: String, epoch: UInt64, start: UInt64, end: UInt64, reason: String) {
        guard let origin = originNanoseconds, end > start, start >= origin else { return }
        queueGap(.init(id: UUID().uuidString.lowercased(), sourceId: source, epoch: epoch,
            startMs: (start - origin) / 1_000_000, endMs: (end - origin + 999_999) / 1_000_000, reason: reason))
    }

    /// Bounded metadata admission, separate from clock mapping so its terminal UI state can be
    /// exercised with generated ranges and no capture device or authenticated transport.
    func queueGap(_ gap: MeetingCaptureGap) {
        gapCount += 1
        if gapCoverageIncomplete { return }
        guard pendingGaps.count < 256 else {
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
        pendingGaps.append(gap)
    }

    private func scheduleAudioRetry(_ source: MeetingAudioSource, after requested: UInt64?) {
        let failures = min(5, (uploadFailures[source] ?? 0) + 1)
        uploadFailures[source] = failures
        let delay = min(86400000, max(1000, requested ?? UInt64(1 << failures) * 500))
        uploadRetryAt[source] = self.now() + delay * 1_000_000
    }

    private func recordAudioDiagnostics() {
        for (source, value) in runtime.audioDiagnostics {
            let line = "\(source.rawValue): dropped=\(value.droppedCallbacks), overflow=\(value.dropMailboxOverflows), discontinuities=\(value.sampleDiscontinuities), clockDifferenceNs=\(value.maximumHostClockDifferenceNanoseconds), capacityMs=\((value.effectiveCapacityNanoseconds ?? 0) / 1_000_000)"
            guard line != lastAudioDiagnostics[source] else { continue }
            lastAudioDiagnostics[source] = line
            diagnostics.append(line)
            if diagnostics.count > 32 { diagnostics.removeFirst(diagnostics.count - 32) }
        }
    }

    /// Only stage and bounded timing enter diagnostics, never credentials, PCM, URLs or text.
    func noteDiagnostic(_ stage: String, duration: UInt64) {
        diagnostics.append("\(stage): \(duration / 1_000_000) ms")
        if diagnostics.count > 32 { diagnostics.removeFirst(diagnostics.count - 32) }
    }

    private func finish() {
        if let cutoff = remote?.stopCutoffMs, let boundary = try? nativeTime(cutoff) {
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

    func nativeTime(_ milliseconds: UInt64) throws -> UInt64 {
        guard let origin = originNanoseconds, milliseconds <= (UInt64.max - origin) / 1_000_000 else {
            throw MeetingHostError.invalidResponse
        }
        return origin + milliseconds * 1_000_000
    }
    func now() -> UInt64 { ports.now() }
    static func describe(_ selection: MeetingCaptureChoice, inventory: MeetingCaptureInventory) -> String {
        let microphone = selection.microphone.map { requested in
            inventory.microphones.first { $0.deviceId == requested.deviceId && $0.sourceId == requested.sourceId }?.label ?? "Selected microphone"
        }
        guard let microphone else { return "Computer audio" }
        switch selection.mode {
        case "microphone-only": return microphone
        case "selected-app":
            let application = inventory.applications.first { $0.appProcessTreeId == selection.appProcessTreeId }?.label ?? "Selected app"
            return "\(microphone) and \(application)"
        default: return "\(microphone) and computer audio"
        }
    }
}
