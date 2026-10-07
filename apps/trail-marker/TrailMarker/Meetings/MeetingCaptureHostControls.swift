import Foundation

/// Explicit native controls share the host lifecycle and the immutable control outbox.
extension MeetingCaptureHost {
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

    func localControl(_ command: String) {
        guard let activation, let grantId, let remote,
              phase == .recording || (command == "stop" && [.ready, .paused, .stopping].contains(phase)) else { return }
        if command == "stop", phase == .stopping { retryPendingControl(); return }
        uploadAdmitted = false
        do {
            if command == "pause" {
                let now = self.now()
                recordingDuration.pause(at: now)
                try runtime.pause(at: now)
                pauseStartedNanoseconds = now
                pauseReason = "paused"
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

    func retryPendingControl() {
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
                    self.pausedCaptureCutoff = try reply.capture.epochEndMs.map(self.nativeTime)
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
                    try self.runtime.tightenStopCutoff(to: self.nativeTime(cutoff))
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

}
