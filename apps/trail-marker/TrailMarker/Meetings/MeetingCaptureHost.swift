import AppKit
import AudioToolbox
import Combine
import Foundation

/// App-lifetime host. Construction and activation links are inert; preparation is a user action.
/// Capture can start only from a new explicit browser Record generation in this live session.
@MainActor
final class MeetingCaptureHost: ObservableObject {
    enum Phase: String { case unprepared, preparing, awaitingApproval, ready, recording, paused, stopping, stopped, error }
    @Published private(set) var phase: Phase = .unprepared
    @Published private(set) var message = "Open a meeting in Moss, then prepare this Mac."
    @Published private(set) var activation: MeetingActivation?
    @Published private(set) var inventory: MeetingCaptureInventory?
    @Published private(set) var sourceDescription = "No audio sources selected"
    @Published private(set) var cleanupBlocked = false
    @Published private(set) var gapCount = 0
    @Published private(set) var gapCoverageIncomplete = false

    private let connection: ConnectionRuntime
    private let reader = MeetingCaptureInventoryReader()
    private let runtime: MeetingCaptureRuntime
    private var client: MeetingCaptureClient?
    private var credential: String?
    private var grantId: String?
    private var grantExpiry: Date?
    private var task: Task<Void, Never>?
    private var uploadTask: URLSessionDataTask?
    private var timer: Timer?
    private var sessionGeneration = 0
    private var fence = MeetingCommandFence()
    private var observed = MeetingCaptureObserved(generation: 0, phase: "idle", errorCode: nil)
    private var remote: MeetingRemoteCapture?
    private var selected: MeetingInventorySnapshot.Resolved?
    private var choice: MeetingCaptureChoice?
    private var originNanoseconds: UInt64?
    private var lastStatusNanoseconds: UInt64 = 0
    private var uploadAdmitted = false
    private var stoppedByUser = false
    private var controlInFlight = false
    private var controlOutbox = MeetingControlOutbox()
    private var pauseStartedNanoseconds: UInt64?
    private var pauseReason = "paused"
    private var pausedCaptureCutoff: UInt64?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private struct Epoch {
        let remoteEpoch: UInt64
        let generation: Int
        let choice: MeetingCaptureChoice
        let startNanoseconds: UInt64
    }
    private var epochs: [UInt64: Epoch] = [:]
    private var uploadSequencer = MeetingUploadSequencer()
    private var pendingGaps: [MeetingCaptureGap] = []
    private var acknowledgedEnds: [MeetingUploadSequencer.Stream: UInt64] = [:]

    init(connection: ConnectionRuntime, runtime: MeetingCaptureRuntime? = nil, factory: @escaping MeetingCaptureRuntime.DeviceFactory = MeetingCaptureHost.devices) {
        self.connection = connection
        self.runtime = runtime ?? MeetingCaptureRuntime(factory: factory)
    }

    nonisolated static func devices(_ selection: MeetingNativeSelection) throws -> [MeetingAudioSource: MeetingAudioCapturing] {
        var devices: [MeetingAudioSource: MeetingAudioCapturing] = [
            .microphone: MeetingMicrophoneCapture(selectedDeviceID: selection.microphoneDeviceID)
        ]
        if let output = selection.output {
            guard #available(macOS 14.2, *) else { throw MeetingHostError.unavailable }
            devices[.output] = CoreAudioMeetingOutput(scope: output)
        }
        return devices
    }

    var isRecording: Bool { phase == .recording || cleanupBlocked }
    var canPrepare: Bool { activation != nil && [.unprepared, .stopped, .error].contains(phase) && !cleanupBlocked }
    var canStop: Bool { [.recording, .paused, .stopping].contains(phase) || cleanupBlocked }

    func open(_ url: URL) {
        do {
            let next = try MeetingActivation.parse(url)
            guard let identity = connection.identity, identity.instance == next.instance else { throw MeetingHostError.wrongInstance }
            if activation == next { return }
            guard terminate(reason: "Previous meeting capture ended.") else { return }
            activation = next
            phase = .unprepared
            message = "Prepare this Mac, approve it in Moss, then choose sources and press Record."
            inventory = try reader.read().wire
        } catch { if !isRecording { show(error) } }
    }

    func prepareFromUserClick() {
        guard canPrepare, let activation, let identity = connection.identity,
              identity.instance == activation.instance, connection.requestClient() != nil else {
            show(MeetingHostError.wrongInstance); return
        }
        guard terminate(reason: "Preparing this meeting.") else { return }
        phase = .preparing
        gapCount = 0
        gapCoverageIncomplete = false
        sourceDescription = "No audio sources selected"
        stoppedByUser = false
        let generation = sessionGeneration
        task = Task { [weak self] in
            guard let self else { return }
            guard await MeetingCapturePermissions.requestMicrophoneFromUserClick() else {
                guard generation == self.sessionGeneration else { return }
                self.show(MeetingHostError.permissionDenied); return
            }
            guard generation == self.sessionGeneration, !Task.isCancelled else { return }
            do {
                let client = MeetingCaptureClient(instance: activation.instance)
                self.client = client
                self.inventory = try self.reader.read().wire
                guard let (_, bootstrap) = self.connection.requestClient() else { throw MeetingHostError.authorizationExpired }
                let verifier = LinkAttempt.makeVerifier()
                let link = try await client.link(meetingId: activation.meetingId, verifier: verifier, companionCredential: bootstrap)
                guard generation == self.sessionGeneration, !Task.isCancelled,
                      link.meetingId == activation.meetingId, link.deviceId == identity.deviceId,
                      let expiry = ServerTime.parse(link.expiresAt) else { throw MeetingHostError.invalidResponse }
                self.phase = .awaitingApproval
                self.message = "Approve this Mac for this meeting in Moss. Microphone access alone does not record."
                self.openMeetingInBrowser()
                while !Task.isCancelled, generation == self.sessionGeneration, Date() < expiry {
                    guard let (_, currentBootstrap) = self.connection.requestClient() else { throw MeetingHostError.authorizationExpired }
                    let reply = try await client.redeem(meetingId: activation.meetingId, challengeId: link.challengeId,
                        verifier: verifier, companionCredential: currentBootstrap)
                    guard generation == self.sessionGeneration, !Task.isCancelled else { return }
                    if reply.status == "issued" {
                        guard let credential = reply.credential, credential.hasPrefix("mm1_"),
                              let grant = reply.grantId, UUID(uuidString: grant) != nil,
                              let expires = reply.expiresAt.flatMap(ServerTime.parse), expires > Date() else {
                            throw MeetingHostError.invalidResponse
                        }
                        self.credential = credential
                        self.grantId = grant
                        self.grantExpiry = expires
                        self.phase = .ready
                        self.message = "Choose sources and press Record in Moss. Computer audio may ask for macOS permission."
                        self.installServiceTimer()
                        await self.poll(generation: generation)
                        return
                    }
                    guard reply.status == "pending" else { throw MeetingHostError.invalidResponse }
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
                if !Task.isCancelled { throw MeetingHostError.authorizationExpired }
            } catch {
                guard generation == self.sessionGeneration, !Task.isCancelled else { return }
                _ = self.terminate(reason: MeetingHostError.authorizationExpired.message)
                self.show(error)
            }
        }
    }

    private func poll(generation: Int) async {
        while !Task.isCancelled, generation == sessionGeneration {
            do {
                guard let client, let activation, let credential, let grantId, let grantExpiry,
                      Date() < grantExpiry else { throw MeetingHostError.authorizationExpired }
                let fresh = try reader.read()
                inventory = fresh.wire
                validateCurrentSources(fresh)
                let sentObservation = observed
                let requestSent = Self.now()
                let reply = try await client.status(.init(meetingId: activation.meetingId, grantId: grantId,
                    inventory: fresh.wire, observed: sentObservation, gaps: Array(pendingGaps.filter { $0.endMs <= (remote?.elapsedMs ?? 0) }.prefix(32))), credential: credential)
                guard generation == sessionGeneration, !Task.isCancelled else { return }
                guard reply.capture.grantId == grantId, reply.capture.deviceId == connection.identity?.deviceId else {
                    throw MeetingHostError.authorizationExpired
                }
                try reply.capture.validate()
                guard controlOutbox.accepts(generation: reply.capture.generation) else {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    continue
                }
                controlOutbox.reconcile(generation: reply.capture.generation, desired: reply.capture.desired)
                let now = Self.now()
                lastStatusNanoseconds = now
                if originNanoseconds == nil {
                    originNanoseconds = try MeetingCaptureClock(requestSent: requestSent, responseReceived: now,
                        elapsedMilliseconds: reply.capture.elapsedMs).originNanoseconds
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
                if phase == .stopped, reply.capture.desired == "stopped", pendingGaps.isEmpty {
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
                    try apply(reply.capture, inventory: try reader.read(), at: now)
                }
                retryPendingControl()
                // The status request has acknowledged this exact epoch before its first audio send.
                uploadAdmitted = controlOutbox.pending == nil && !controlInFlight && MeetingSendAdmission.permits(phase: phase, desired: reply.capture.desired,
                    submitted: sentObservation, current: observed)
            } catch {
                guard generation == sessionGeneration, !Task.isCancelled else { return }
                if (error as? MeetingHostError) == .authorizationExpired {
                    _ = terminate(reason: MeetingHostError.authorizationExpired.message)
                    return
                }
                interrupt(error: error)
            }
            let delay: UInt64 = [.recording, .paused, .stopping].contains(phase) ? 500_000_000 : 1_000_000_000
            try? await Task.sleep(nanoseconds: delay)
        }
    }

    private func apply(_ next: MeetingRemoteCapture, inventory: MeetingInventorySnapshot, at now: UInt64) throws {
        let start = fence.shouldStart(generation: next.generation, desired: next.desired)
        if next.desired == "revoked" { _ = terminate(reason: MeetingHostError.authorizationExpired.message); return }
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
                try runtime.stop(at: now, captureCutoffNanoseconds: cutoff)
                observed = .init(generation: next.generation, phase: "stopped", errorCode: nil)
                phase = .stopping
                message = "Recording stopped. Finishing only audio captured before Stop."
            }
            return
        }
        if next.desired == "paused", phase == .recording {
            try runtime.pause(at: now)
            pausedCaptureCutoff = try next.epochEndMs.map(nativeTime)
            pauseStartedNanoseconds = pausedCaptureCutoff ?? now
            pauseReason = "paused"
            uploadAdmitted = false
            observed = .init(generation: next.generation, phase: "paused", errorCode: nil)
            phase = .paused
            message = "Paused. No new audio is captured or sent. Press Record in Moss to resume."
        }
        guard start, !stoppedByUser, !controlInFlight, !cleanupBlocked, !gapCoverageIncomplete, let selection = next.selection else { return }
        guard MeetingCapturePermissions.microphone == .granted else { throw MeetingHostError.permissionDenied }
        let resolved = try inventory.resolve(selection)
        let readiness = MeetingNativeReadiness(permissionsGranted: true, processingReady: true,
            noticeAcknowledged: true, meetingDeviceAuthorized: true)
        if runtime.snapshot.state == .paused {
            try runtime.resume(selection: resolved.selection, readiness: readiness, permitRetainedAudio: false, at: now)
        } else {
            recordPauseGap(endingAt: now)
            if [.failed, .finished].contains(runtime.snapshot.state) { try runtime.reset(at: now) }
            try runtime.prepare(selection: resolved.selection, readiness: readiness, at: now)
            try runtime.start(readiness: readiness, at: now)
        }
        // Re-check after source acquisition: a helper appearing during startup is not grandfathered.
        let after = try reader.read().resolve(selection)
        guard after == resolved else {
            guard closeCaptureDiscarding(at: Self.now()) else { throw MeetingHostError.cleanupFailed }
            throw MeetingHostError.sourceChanged
        }
        epochs[runtime.snapshot.epoch] = Epoch(remoteEpoch: next.epoch, generation: next.generation, choice: selection, startNanoseconds: now)
        pauseStartedNanoseconds = nil
        pausedCaptureCutoff = nil
        selected = resolved
        choice = selection
        observed = .init(generation: next.generation, phase: "recording", errorCode: nil)
        phase = .recording
        sourceDescription = Self.describe(selection)
        message = "Recording \(sourceDescription)."
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

    private func service() {
        do {
            let now = Self.now()
            if cleanupBlocked {
                if closeCaptureDiscarding(at: now) { phase = .error; message = "Capture stopped. Prepare this meeting again." }
                return
            }
            guard grantExpiry.map({ Date() < $0 }) == true else {
                _ = terminate(reason: MeetingHostError.authorizationExpired.message); return
            }
            if phase == .recording {
                guard now - lastStatusNanoseconds < 5_000_000_000 else { throw MeetingHostError.network }
                validateCurrentSources(try reader.read())
            }
            let gaps = try runtime.service(at: now)
            for gap in gaps { record(gap) }
            if phase == .recording, runtime.snapshot.state != .recording {
                throw MeetingHostError.sourceChanged
            }
            if phase == .stopping, !controlInFlight, controlOutbox.pending == nil, runtime.snapshot.state == .finished {
                finish(); return
            }
            guard uploadAdmitted, uploadTask == nil, [.recording, .stopping].contains(phase) else { return }
            let generation = sessionGeneration
            var initiationError: Error?
            let latestEnd = try remote.map { try nativeTime($0.elapsedMs) }
            let sent = try runtime.dispatchNextChunk(at: now, latestEndNanoseconds: latestEnd) { packet in
                do { try self.send(packet, sessionGeneration: generation) }
                catch { initiationError = error }
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
        guard MeetingCapturePermissions.microphone == .granted,
              let current = try? fresh.resolve(choice), current == selected else {
            // Drop pending audio on membership change, including newly appearing Moss helpers.
            // This never replaces a failed app-scoped route with computer capture.
            sourceChanged()
            return
        }
    }

    private func send(_ packet: MeetingAudioPacket, sessionGeneration generation: Int) throws {
        guard let client, let activation, let grantId, let credential,
              let epoch = epochs[packet.epoch], let origin = originNanoseconds,
              packet.startNanoseconds >= origin else { throw MeetingHostError.invalidResponse }
        let start = (packet.startNanoseconds - origin) / 1_000_000
        let duration = UInt64((Double(packet.samples.count) * 1000 / packet.sampleRate).rounded(.up))
        guard duration > 0, duration <= 10000 else { throw MeetingHostError.invalidResponse }
        let source = packet.source == .microphone ? epoch.choice.microphone.sourceId : epoch.choice.outputSourceId
        guard let source else { throw MeetingHostError.invalidResponse }
        let identity = uploadSequencer.identity(epoch: epoch.remoteEpoch, source: source, callbackSequence: packet.sequence)
        let key = identity.requestKey
        let body = MeetingCaptureAudioBody(meetingId: activation.meetingId, grantId: grantId, requestKey: key,
            generation: epoch.generation, epoch: epoch.remoteEpoch, sourceId: source, sequence: identity.sequence,
            startMs: start, endMs: start + duration, sampleRateHz: Int(packet.sampleRate),
            pcmBase64: try MeetingPCMEncoder.encode(packet.samples))
        uploadTask = try client.beginAudio(body, credential: credential) { [weak self] result in
            Task { @MainActor in
                guard let self, generation == self.sessionGeneration else { return }
                self.uploadTask = nil
                switch result {
                case .success(let receipt):
                    let terminal = receipt.releasesAudio(matching: key)
                    let failed = terminal && receipt.status == "failed"
                    if failed {
                        // Retain the failure range before deleting its transient audio. A
                        // terminal receipt must never re-enter the Stop/retry upload loop.
                        self.recordGap(source: source, epoch: epoch.remoteEpoch, start: packet.startNanoseconds,
                            end: packet.endNanoseconds, reason: "processing-failed")
                    }
                    if terminal {
                        self.uploadSequencer.acknowledge(epoch: epoch.remoteEpoch, source: source, callbackSequence: packet.sequence)
                        self.acknowledgedEnds[.init(epoch: packet.epoch, source: source)] = packet.endNanoseconds
                    }
                    self.runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: terminal)
                    if failed { self.interrupt(error: MeetingHostError.rejected) }
                    else if receipt.requestKey != key || !["saved", "pending"].contains(receipt.status) {
                        self.interrupt(error: MeetingHostError.invalidResponse)
                    }
                case .failure(let error):
                    self.runtime.completeSend(source: packet.source, epoch: packet.epoch, sequence: packet.sequence, received: false)
                    self.interrupt(error: error)
                }
            }
        }
    }

    func pauseFromUserClick() { localControl("pause") }
    func stopFromUserClick() {
        if cleanupBlocked { _ = terminate(reason: "Recording stopped."); return }
        localControl("stop")
    }

    private func localControl(_ command: String) {
        guard let activation, let grantId, let remote,
              phase == .recording || (command == "stop" && [.paused, .stopping].contains(phase)) else { return }
        if command == "stop", phase == .stopping { retryPendingControl(); return }
        uploadAdmitted = false
        do {
            if command == "pause" {
                let now = Self.now()
                try runtime.pause(at: now)
                pauseStartedNanoseconds = now
                pauseReason = "paused"
                phase = .paused
            }
            else {
                if ![.idle, .ready, .finished].contains(runtime.snapshot.state) {
                    recordPauseGap(endingAt: Self.now())
                    if ![.idle, .ready, .finished].contains(runtime.snapshot.state) {
                        try runtime.stop(at: Self.now(), captureCutoffNanoseconds: pausedCaptureCutoff)
                    }
                }
                phase = .stopping
                stoppedByUser = true
            }
        } catch { interrupt(error: error); return }
        observed = .init(generation: remote.generation, phase: command == "pause" ? "paused" : "stopped", errorCode: nil)
        message = command == "pause" ? "Paused. No new audio is captured or sent." : "Recording stopped. Finishing captured audio."
        controlOutbox.stage(command: command, meetingId: activation.meetingId, grantId: grantId,
            generation: remote.generation)
        retryPendingControl()
    }

    private func retryPendingControl() {
        guard !controlInFlight, let body = controlOutbox.pending, let client, let credential else { return }
        controlInFlight = true
        uploadAdmitted = false
        let generation = sessionGeneration
        Task { [weak self] in
            guard let self else { return }
            defer { if generation == self.sessionGeneration { self.controlInFlight = false } }
            do {
                let reply = try await client.control(body, credential: credential)
                guard generation == self.sessionGeneration else { return }
                guard reply.capture.grantId == self.grantId, reply.capture.deviceId == self.connection.identity?.deviceId else {
                    throw MeetingHostError.authorizationExpired
                }
                try reply.capture.validate()
                self.controlOutbox.received(requestKey: body.requestKey, desired: reply.capture.desired)
                guard self.controlOutbox.accepts(generation: reply.capture.generation) else { return }
                self.controlOutbox.reconcile(generation: reply.capture.generation, desired: reply.capture.desired)
                self.remote = reply.capture
                if body.command == "pause" { self.pausedCaptureCutoff = try reply.capture.epochEndMs.map(self.nativeTime) }
                _ = self.fence.shouldStart(generation: reply.capture.generation, desired: reply.capture.desired)
                if body.command == "stop", let cutoff = [reply.capture.stopCutoffMs, reply.capture.epochEndMs].compactMap({ $0 }).min(), self.runtime.snapshot.stopCutoffNanoseconds != nil {
                    try self.runtime.tightenStopCutoff(to: self.nativeTime(cutoff))
                }
                self.observed = .init(generation: reply.capture.generation,
                    phase: self.stoppedByUser ? "stopped" : "paused", errorCode: nil)
                // A later status must acknowledge this observation before any final flush.
                self.uploadAdmitted = false
            } catch {
                guard generation == self.sessionGeneration else { return }
                if (error as? MeetingHostError) == .authorizationExpired {
                    _ = self.terminate(reason: MeetingHostError.authorizationExpired.message)
                } else {
                    // Keep the request and UUID. The polling loop reconciles conflicts and
                    // retries delivery; a new explicit Record can never override pending Stop.
                    self.uploadAdmitted = false
                    self.message = body.command == "stop" ? "Recording stopped on this Mac. Waiting to confirm Stop with Moss." : "Paused on this Mac. Waiting to confirm Pause with Moss."
                }
            }
        }
    }

    private func interrupt(error: Error) {
        uploadAdmitted = false
        fence.interrupt()
        if runtime.snapshot.state == .recording {
            do {
                let now = Self.now()
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
        if runtime.snapshot.state == .failed { _ = closeCaptureDiscarding(at: Self.now()) }
        if cleanupBlocked {
            phase = .error
            message = MeetingHostError.cleanupFailed.message
            observed = .init(generation: remote?.generation ?? 0, phase: "error", errorCode: "native_cleanup_failed")
            return
        }
        if !stoppedByUser { phase = .paused }
        observed = .init(generation: remote?.generation ?? 0, phase: "paused", errorCode: "native_capture_interrupted")
        message = (error as? MeetingHostError)?.message ?? "Audio capture paused. Check the selected source and microphone/system-audio permissions in macOS Settings, then press Record again."
    }

    /// Synchronous barrier before identity changes, Pause All or process termination.
    /// Receivers close and sends are disabled before task cancellation or credential removal.
    @discardableResult
    func terminate(reason: String) -> Bool {
        uploadAdmitted = false
        var clean = true
        do { try runtime.terminate(at: Self.now()) } catch { clean = false }
        sessionGeneration += 1
        task?.cancel(); task = nil
        uploadTask?.cancel(); uploadTask = nil
        client?.close(); client = nil
        credential = nil; grantId = nil; grantExpiry = nil
        timer?.invalidate(); timer = nil
        for (center, observer) in observers { center.removeObserver(observer) }
        observers.removeAll()
        choice = nil; selected = nil; remote = nil; originNanoseconds = nil
        pauseStartedNanoseconds = nil; pausedCaptureCutoff = nil; pauseReason = "paused"
        epochs.removeAll(); pendingGaps.removeAll(); acknowledgedEnds.removeAll(); uploadSequencer = MeetingUploadSequencer(); fence = MeetingCommandFence(); controlInFlight = false; controlOutbox = MeetingControlOutbox()
        observed = .init(generation: 0, phase: "idle", errorCode: nil)
        cleanupBlocked = !clean
        phase = clean ? .stopped : .error
        message = clean ? reason : MeetingHostError.cleanupFailed.message
        return clean
    }

    func beforeConnectionEvent(_ event: ConnectionEvent) -> Bool {
        switch event {
        case .userDisconnect, .userLogout, .userQuit:
            return terminate(reason: "Meeting capture ended. Open and prepare it again to record.")
        case .linkCompleted(let identity, _, _) where identity != connection.identity:
            return terminate(reason: "Account changed. Prepare this meeting again.")
        case .heartbeatFailed(let error, let generation) where generation == connection.currentGeneration:
            if error == .credentialInvalid {
                _ = terminate(reason: MeetingHostError.authorizationExpired.message)
            } else if case .accountBlocked = error {
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
        let now = Self.now()
        recordDiscardedTail(at: now, reason: "source-unavailable")
        pauseStartedNanoseconds = now
        pauseReason = "interrupted"
        _ = closeCaptureDiscarding(at: now)
        interrupt(error: MeetingHostError.sourceChanged)
    }

    private func closeCaptureDiscarding(at now: UInt64) -> Bool {
        uploadAdmitted = false
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
        guard let start = pauseStartedNanoseconds, let epoch = epochs[runtime.snapshot.epoch] else { return }
        pauseStartedNanoseconds = nil
        for source in [epoch.choice.microphone.sourceId, epoch.choice.outputSourceId].compactMap({ $0 }) {
            recordGap(source: source, epoch: epoch.remoteEpoch, start: start, end: end, reason: pauseReason)
        }
    }

    private func record(_ gap: MeetingAudioGap) {
        guard let epoch = epochs[gap.epoch] else { return }
        let source = gap.source == .microphone ? epoch.choice.microphone.sourceId : epoch.choice.outputSourceId
        guard let source else { return }
        let reason: String
        switch gap.reason {
        case .paused: reason = pauseReason
        case .expired: reason = "expired"
        case .bufferFull: reason = "buffer-full"
        case .captureFailure: reason = "source-unavailable"
        case .retentionDeclined, .cutoffChanged: reason = "discarded"
        }
        recordGap(source: source, epoch: epoch.remoteEpoch, start: gap.startNanoseconds, end: gap.endNanoseconds, reason: reason)
    }

    private func recordDiscardedTail(at now: UInt64, reason: String) {
        let localEpoch = runtime.snapshot.epoch
        guard let epoch = epochs[localEpoch] else { return }
        let sources = [epoch.choice.microphone.sourceId, epoch.choice.outputSourceId].compactMap { $0 }
        for source in sources {
            let start = acknowledgedEnds[.init(epoch: localEpoch, source: source)] ?? epoch.startNanoseconds
            recordGap(source: source, epoch: epoch.remoteEpoch, start: start, end: now, reason: reason)
        }
    }

    private func recordGap(source: String, epoch: UInt64, start: UInt64, end: UInt64, reason: String) {
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
            _ = closeCaptureDiscarding(at: Self.now())
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

    private func finish() {
        if let cutoff = remote?.stopCutoffMs, let boundary = try? nativeTime(cutoff) {
            recordPauseGap(endingAt: boundary)
        }
        uploadAdmitted = false
        phase = .stopped
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

    private func nativeTime(_ milliseconds: UInt64) throws -> UInt64 {
        guard let origin = originNanoseconds, milliseconds <= (UInt64.max - origin) / 1_000_000 else {
            throw MeetingHostError.invalidResponse
        }
        return origin + milliseconds * 1_000_000
    }
    private static func now() -> UInt64 { AudioConvertHostTimeToNanos(AudioGetCurrentHostTime()) }
    private static func describe(_ selection: MeetingCaptureChoice) -> String {
        switch selection.mode {
        case "microphone-only": return "microphone only"
        case "selected-app": return "microphone and selected app"
        default: return "microphone and computer audio"
        }
    }
}
