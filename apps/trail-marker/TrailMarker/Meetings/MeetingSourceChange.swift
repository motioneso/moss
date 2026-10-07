import Foundation

/// One user click freezes authority and the complete source choice. Retries never rebase it.
struct MeetingSourceChangeIntent {
    let body: MeetingCaptureControlBody
    let desired: String
    var attempts = 0
    var retryAtNanoseconds: UInt64 = 0
    var acknowledged = false
    var awaitingControl: Bool { !acknowledged }

    func matches(_ capture: MeetingRemoteCapture) -> Bool {
        guard let epoch = body.expectedEpoch, epoch < UInt64.max else { return false }
        return capture.grantId == body.grantId && capture.generation == body.expectedGeneration + 1 &&
            capture.epoch == epoch + 1 && capture.selection == body.selection && capture.desired == desired
    }
}

/// The native picker changes only the current recording. It never writes an OS default or
/// saved Moss preference. Existing selected-app scope survives a microphone-only menu click.
enum MeetingSourceChoice {
    static let emptyMessage = "Select a microphone or turn on computer audio."

    static func microphone(_ microphone: MeetingCaptureChoice.Microphone?,
                           in current: MeetingCaptureChoice) throws -> MeetingCaptureChoice {
        guard microphone != nil || current.mode == "computer-audio" else {
            throw MeetingAudioFailure.invalidSelection
        }
        return .init(mode: current.mode, microphone: microphone, outputSourceId: current.outputSourceId,
            appProcessTreeId: current.appProcessTreeId, scope: current.scope, applicationId: current.applicationId)
    }

    static func computerAudio(_ enabled: Bool, in current: MeetingCaptureChoice,
                              inventory: MeetingCaptureInventory) throws -> MeetingCaptureChoice {
        guard enabled || current.microphone != nil else { throw MeetingAudioFailure.invalidSelection }
        if !enabled {
            return .init(mode: "microphone-only", microphone: current.microphone,
                outputSourceId: nil, appProcessTreeId: nil, scope: nil)
        }
        return .init(mode: "computer-audio", microphone: current.microphone,
            outputSourceId: current.outputSourceId ?? "output", appProcessTreeId: nil,
            scope: .init(kind: "process-exclusion", endpointId: nil,
                         excludedProcessTreeIds: inventory.computerAudio.excludedProcessTreeIds))
    }
}

extension MeetingCaptureHost {
    /// A control conflict can disclose an epoch we have not seen yet. Keep its old gaps local
    /// until status (or the Stop/Pause receipt) supplies the authoritative source boundary.
    func gapsForStatus() -> [MeetingCaptureGap] {
        guard sourceChangeIntent == nil, controlOutbox.pending == nil, !controlInFlight else { return [] }
        return Array(pendingGaps.filter { $0.endMs <= (remote?.elapsedMs ?? 0) }.prefix(32))
    }

    func reconcileClosedSourceEpoch(_ capture: MeetingRemoteCapture) throws {
        guard runtime.snapshot.state != .recording,
              let oldEpoch = pauseGapSelection?.epoch ?? epochs[runtime.snapshot.epoch]?.remoteEpoch,
              capture.epoch > max(oldEpoch, sourceBoundaryEpoch) else { return }
        try adoptPausedSourceChoice(capture)
    }

    var currentSourceChoice: MeetingCaptureChoice? { choice ?? remote?.selection }
    var canChangeSourcesFromUserClick: Bool {
        ((phase == .recording && remote?.desired == "recording") ||
            (phase == .paused && remote?.desired == "paused")) &&
            sourceChangeIntent == nil && !controlInFlight && controlOutbox.pending == nil &&
            !stoppedByUser && !cleanupBlocked && !gapCoverageIncomplete && !epochs.isEmpty &&
            credential != nil && grantExpiry.map({ ports.wallNow() < $0 }) == true && now() < leaseDeadlineNanoseconds
    }

    func dismissSourceSelectionError() { sourceSelectionError = nil }

    func selectMicrophoneFromUserClick(_ microphone: MeetingCaptureChoice.Microphone?) {
        guard canChangeSourcesFromUserClick, let current = currentSourceChoice else { return }
        do { try changeSourcesFromUserClick(MeetingSourceChoice.microphone(microphone, in: current)) }
        catch { sourceSelectionError = sourceChoiceMessage(error) }
    }

    func setComputerAudioFromUserClick(_ enabled: Bool) {
        guard canChangeSourcesFromUserClick, let current = currentSourceChoice else { return }
        do {
            let fresh = try ports.readInventory()
            try changeSourcesFromUserClick(MeetingSourceChoice.computerAudio(enabled, in: current, inventory: fresh.wire))
        } catch { sourceSelectionError = sourceChoiceMessage(error) }
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
                pauseStartedNanoseconds = boundary
                pauseReason = "interrupted"
            }
            // pause() closes receivers and releases every old device synchronously.
            sourceChangeIntent = intent
            phase = .paused
            observed = .init(generation: remote.generation, phase: "paused", errorCode: nil)
            message = "Paused while Moss confirms the new audio sources."
            retrySourceChange()
        } catch {
            interrupt(error: error)
            sourceSelectionError = cleanupBlocked ? MeetingHostError.cleanupFailed.message : sourceChoiceMessage(error)
        }
    }

    func retrySourceChange() {
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
    func reconcileSourceChangeStatus(_ capture: MeetingRemoteCapture) throws {
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
    func adoptPausedSourceChoice(_ capture: MeetingRemoteCapture) throws {
        guard let selection = capture.selection else { throw MeetingHostError.invalidResponse }
        guard capture.epoch > sourceBoundaryEpoch else { return }
        let boundary = try nativeTime(capture.epochStartMs)
        runtime.tightenPauseCutoff(to: boundary)
        runtime.clearPauseGapForSourceChange()
        if let old = epochs[runtime.snapshot.epoch] {
            epochs[runtime.snapshot.epoch]?.endNanoseconds = min(old.endNanoseconds ?? boundary, boundary)
        }
        var tails: Set<MeetingSourceGapTail> = []
        pendingGaps = pendingGaps.compactMap { gap in
            guard gap.epoch < capture.epoch, gap.endMs > capture.epochStartMs else { return gap }
            if ["paused", "interrupted"].contains(gap.reason) {
                tails.insert(.init(startMs: max(gap.startMs, capture.epochStartMs), endMs: gap.endMs, reason: gap.reason))
            }
            guard gap.startMs < capture.epochStartMs else { return nil }
            return .init(id: gap.id, sourceId: gap.sourceId, epoch: gap.epoch,
                startMs: gap.startMs, endMs: capture.epochStartMs, reason: gap.reason)
        }
        for tail in tails {
            for source in [selection.microphone?.sourceId, selection.outputSourceId].compactMap({ $0 }) {
                queueGap(.init(id: UUID().uuidString.lowercased(), sourceId: source, epoch: capture.epoch,
                    startMs: tail.startMs, endMs: tail.endMs, reason: tail.reason))
            }
        }
        let remainingPauseStart = max(pauseStartedNanoseconds ?? boundary, boundary)
        recordPauseGap(endingAt: boundary)
        // Old identities end at this boundary; the replacement owns the remaining gap,
        // including a source change made while already paused.
        pauseStartedNanoseconds = stoppedByUser ? nil : remainingPauseStart
        pauseGapSelection = (capture.epoch, selection)
        sourceBoundaryEpoch = capture.epoch
        pauseReason = "interrupted"
        choice = selection
        selected = nil
        let currentInventory = try ports.readInventory().wire
        sourceDescription = Self.describe(selection, inventory: currentInventory)
    }

    func cancelSourceChange() {
        guard sourceChangeIntent != nil || sourceChangeTask != nil else { return }
        sourceChangeRevision += 1
        sourceChangeIntent = nil
        sourceChangeTask?.cancel()
        sourceChangeTask = nil
        uploadAdmitted = false
    }

    func failSourceChange(_ error: Error) {
        guard let intent = sourceChangeIntent else { return }
        cancelSourceChange()
        fence.interrupt()
        sourceSelectionError = sourceChoiceMessage(error)
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

    private func sourceChoiceMessage(_ error: Error) -> String {
        if (error as? MeetingAudioFailure) == .invalidSelection { return MeetingSourceChoice.emptyMessage }
        if (error as? MeetingHostError) == .network || (error as? MeetingHostError)?.retryDelayMilliseconds != nil {
            return "The source change could not be confirmed. Recording is paused. Check the connection and choose your sources again."
        }
        if (error as? MeetingHostError) == .rejected {
            return "The recording changed before these sources were confirmed. Recording is paused. Choose your sources again."
        }
        return (error as? MeetingHostError)?.message ?? MeetingHostError.unavailable.message
    }
}

private struct MeetingSourceGapTail: Hashable {
    let startMs: UInt64
    let endMs: UInt64
    let reason: String
}
