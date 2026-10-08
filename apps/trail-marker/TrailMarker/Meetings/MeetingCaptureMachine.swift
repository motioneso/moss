import Foundation

struct MeetingNativeReadiness {
    /// Microphone grant and explicit user authorization for a possible system-audio prompt.
    /// macOS has no public read-only system-audio preflight; output Start must still succeed.
    let permissionsGranted: Bool
    let processingReady: Bool
    /// A snapshot from the separately scoped authorization path, never inferred from tm1_.
    let meetingDeviceAuthorized: Bool

    func validate() throws {
        guard permissionsGranted, processingReady, meetingDeviceAuthorized else {
            throw MeetingAudioFailure.invalidTransition
        }
    }
}

/// Pure decisions. This does not authenticate the caller or perform platform preflight.
struct MeetingCaptureMachine {
    enum State: Equatable { case idle, ready, recording, paused, stopping, finished, failed }
    private(set) var state: State = .idle
    private(set) var selection: MeetingNativeSelection?
    private(set) var epoch: UInt64 = 0
    private(set) var originNanoseconds: UInt64?
    private(set) var lastTransitionNanoseconds: UInt64 = 0
    private(set) var stopCutoffNanoseconds: UInt64?
    private(set) var finalizationDeadlineNanoseconds: UInt64?
    private(set) var retainedAudioPermitted = false
    private(set) var finalizationExpired = false

    mutating func prepare(selection: MeetingNativeSelection, readiness: MeetingNativeReadiness, at: UInt64) throws {
        guard state == .idle || state == .ready else { throw MeetingAudioFailure.invalidTransition }
        try chronology(at)
        try selection.validate()
        try readiness.validate()
        self.selection = selection
        state = .ready
        lastTransitionNanoseconds = at
    }

    mutating func start(readiness: MeetingNativeReadiness, at: UInt64, initialEpoch: UInt64 = 1) throws {
        guard state == .ready, selection != nil, initialEpoch > 0 else { throw MeetingAudioFailure.invalidTransition }
        try chronology(at)
        try readiness.validate()
        state = .recording
        epoch = initialEpoch
        originNanoseconds = at
        lastTransitionNanoseconds = at
    }

    mutating func pause(at: UInt64) throws {
        guard state == .recording else { throw MeetingAudioFailure.invalidTransition }
        try chronology(at)
        state = .paused
        retainedAudioPermitted = false
        lastTransitionNanoseconds = at
    }

    mutating func resume(selection: MeetingNativeSelection, readiness: MeetingNativeReadiness,
                         permitRetainedAudio: Bool, at: UInt64) throws {
        guard state == .paused, epoch < UInt64.max else { throw MeetingAudioFailure.invalidTransition }
        try chronology(at)
        try selection.validate()
        try readiness.validate()
        self.selection = selection
        epoch += 1
        retainedAudioPermitted = permitRetainedAudio
        state = .recording
        lastTransitionNanoseconds = at
    }

    mutating func stop(at: UInt64, finalizationNanoseconds: UInt64, captureCutoffNanoseconds: UInt64? = nil) throws {
        if stopCutoffNanoseconds != nil { return }
        guard state == .recording || state == .paused || state == .failed else {
            throw MeetingAudioFailure.invalidTransition
        }
        try chronology(at)
        guard finalizationNanoseconds <= 60_000_000_000, at <= UInt64.max - finalizationNanoseconds else {
            throw MeetingAudioFailure.invalidTimestamp
        }
        stopCutoffNanoseconds = min(at, captureCutoffNanoseconds ?? at)
        finalizationDeadlineNanoseconds = at + finalizationNanoseconds
        lastTransitionNanoseconds = at
        state = .stopping
    }

    mutating func tightenStopCutoff(to cutoff: UInt64) throws {
        guard let existing = stopCutoffNanoseconds else { throw MeetingAudioFailure.invalidTransition }
        stopCutoffNanoseconds = min(existing, cutoff)
    }

    mutating func finish(at: UInt64, drained: Bool, expiredAudio: Bool = false) throws {
        guard state == .stopping, let deadline = finalizationDeadlineNanoseconds,
              drained || at >= deadline else { throw MeetingAudioFailure.invalidTransition }
        try chronology(at)
        finalizationExpired = !drained || expiredAudio
        state = .finished
        lastTransitionNanoseconds = at
    }

    mutating func fail() { state = .failed; retainedAudioPermitted = false }

    mutating func terminate(at: UInt64) {
        // Privacy teardown must still close admission if a caller supplies a stale clock.
        lastTransitionNanoseconds = max(at, lastTransitionNanoseconds)
        retainedAudioPermitted = false
        state = .finished
    }

    func permitsSend(epoch: UInt64, endNanoseconds: UInt64, now: UInt64) -> Bool {
        guard epoch > 0, epoch <= self.epoch, now >= lastTransitionNanoseconds, now >= endNanoseconds else { return false }
        switch state {
        case .recording: return epoch == self.epoch || retainedAudioPermitted
        case .stopping:
            guard let cutoff = stopCutoffNanoseconds, let deadline = finalizationDeadlineNanoseconds else { return false }
            return endNanoseconds <= cutoff && now < deadline
        default: return false
        }
    }

    mutating func observeTime(_ at: UInt64) throws {
        try chronology(at)
        lastTransitionNanoseconds = at
    }

    private func chronology(_ at: UInt64) throws {
        guard at >= lastTransitionNanoseconds else { throw MeetingAudioFailure.invalidTimestamp }
    }
}
