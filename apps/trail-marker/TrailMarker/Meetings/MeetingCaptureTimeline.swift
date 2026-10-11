import Foundation

/// Value-only epoch and gap bookkeeping. The host alone owns admission, devices and transport.
struct MeetingCaptureTimeline {
    struct Epoch {
        let remoteEpoch: UInt64
        let generation: Int
        let choice: MeetingCaptureChoice
        let startNanoseconds: UInt64
        var endNanoseconds: UInt64? = nil
    }
    var epochs: [UInt64: Epoch] = [:]
    var originNanoseconds: UInt64?
    var pauseStartedNanoseconds: UInt64?
    var pauseReason = "paused"
    var pendingGaps: [MeetingCaptureGap] = []
    var pauseGapSelection: (epoch: UInt64, choice: MeetingCaptureChoice)?
    var sourceBoundaryEpoch: UInt64 = 0
    var acknowledgedEnds: [MeetingUploadSequencer.Stream: UInt64] = [:]

    private var uploadSequencer = MeetingUploadSequencer()

    mutating func synchronizeOrigin(requestSent: UInt64, responseReceived: UInt64, elapsedMs: UInt64) throws {
        guard epochs.isEmpty else { return }
        let candidate = try MeetingCaptureClock(requestSent: requestSent, responseReceived: responseReceived,
            elapsedMilliseconds: elapsedMs).originNanoseconds
        originNanoseconds = max(originNanoseconds ?? candidate, candidate)
    }

    mutating func acknowledgeGaps(_ capture: MeetingRemoteCapture) {
        pendingGaps = MeetingGapDelivery.remaining(pendingGaps, acknowledgedIDs: Set((capture.gaps ?? []).map(\.id)),
            limitReached: capture.gapLimitReached == true)
    }

    mutating func clipGaps(at cutoff: UInt64?) {
        guard let cutoff else { return }
        pendingGaps = pendingGaps.compactMap { gap in
            guard gap.startMs < cutoff else { return nil }
            return MeetingCaptureGap(id: gap.id, sourceId: gap.sourceId, epoch: gap.epoch,
                startMs: gap.startMs, endMs: min(gap.endMs, cutoff), reason: gap.reason)
        }
    }

    mutating func audioBody(for packet: MeetingAudioPacket, meetingId: String, grantId: String) throws -> MeetingCaptureAudioBody? {
        guard let epoch = epochs[packet.epoch], let origin = originNanoseconds,
              packet.startNanoseconds >= origin else { throw MeetingHostError.invalidResponse }
        if MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: packet.endNanoseconds - origin)
            == MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: packet.startNanoseconds - origin) { return nil }
        let bounds = try MeetingWireAudioBoundary(packet: packet, originNanoseconds: origin)
        let source = packet.source == .microphone ? epoch.choice.microphone?.sourceId : epoch.choice.outputSourceId
        guard let source else { throw MeetingHostError.invalidResponse }
        let identity = uploadSequencer.identity(epoch: epoch.remoteEpoch, source: source, callbackSequence: packet.sequence)
        return MeetingCaptureAudioBody(meetingId: meetingId, grantId: grantId, requestKey: identity.requestKey,
            generation: epoch.generation, epoch: epoch.remoteEpoch, sourceId: source, sequence: identity.sequence,
            startMs: bounds.startMs, endMs: bounds.endMs, sampleRateHz: Int(packet.sampleRate),
            pcmBase64: try MeetingPCMEncoder.encode(packet.samples))
    }

    mutating func acknowledge(_ packet: MeetingAudioPacket, body: MeetingCaptureAudioBody) {
        uploadSequencer.acknowledge(epoch: body.epoch, source: body.sourceId, callbackSequence: packet.sequence)
        acknowledgedEnds[.init(epoch: packet.epoch, source: body.sourceId)] = packet.endNanoseconds
    }

    mutating func endPause(at end: UInt64, localEpoch: UInt64) -> [MeetingCaptureGap] {
        guard let start = pauseStartedNanoseconds else { return [] }
        let context = pauseGapSelection ?? epochs[localEpoch].map { (epoch: $0.remoteEpoch, choice: $0.choice) }
        guard let context else { return [] }
        pauseStartedNanoseconds = nil
        pauseGapSelection = nil
        return [context.choice.microphone?.sourceId, context.choice.outputSourceId].compactMap { source in
            source.flatMap { makeGap(source: $0, epoch: context.epoch, start: start, end: end, reason: pauseReason) }
        }
    }

    func map(_ gap: MeetingAudioGap) -> MeetingCaptureGap? {
        guard let epoch = epochs[gap.epoch] else { return nil }
        let source = gap.source == .microphone ? epoch.choice.microphone?.sourceId : epoch.choice.outputSourceId
        guard let source else { return nil }
        let reason: String
        switch gap.reason {
        case .paused: reason = pauseReason
        case .expired: reason = "expired"
        case .bufferFull: reason = "buffer-full"
        case .captureFailure(.sourceReconfigured): reason = "interrupted"
        case .captureFailure: reason = "source-unavailable"
        case .callbackContention, .startupTimestamp, .sourceVerification: reason = "interrupted"
        case .retentionDeclined, .cutoffChanged: reason = "discarded"
        }
        return makeGap(source: source, epoch: epoch.remoteEpoch, start: gap.startNanoseconds,
            end: min(gap.endNanoseconds, epoch.endNanoseconds ?? gap.endNanoseconds), reason: reason,
            afterMappedAudio: gap.reason == .captureFailure(.sourceReconfigured))
    }

    func discardedTail(localEpoch: UInt64, at now: UInt64, reason: String) -> [MeetingCaptureGap] {
        guard let epoch = epochs[localEpoch] else { return [] }
        let sources = [epoch.choice.microphone?.sourceId, epoch.choice.outputSourceId].compactMap { $0 }
        return sources.compactMap { source in
            let start = acknowledgedEnds[.init(epoch: localEpoch, source: source)] ?? epoch.startNanoseconds
            return makeGap(source: source, epoch: epoch.remoteEpoch, start: start,
                end: min(now, epoch.endNanoseconds ?? now), reason: reason)
        }
    }

    private func makeGap(source: String, epoch: UInt64, start: UInt64, end: UInt64, reason: String,
                         afterMappedAudio: Bool = false) -> MeetingCaptureGap? {
        guard let origin = originNanoseconds, end > start, start >= origin else { return nil }
        let startMs = afterMappedAudio ? MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: start - origin)
            : (start - origin) / 1_000_000
        let endMs = MeetingWireAudioBoundary.milliseconds(coveringNanoseconds: end - origin)
        guard endMs > startMs else { return nil }
        return .init(id: UUID().uuidString.lowercased(), sourceId: source, epoch: epoch,
            startMs: startMs, endMs: endMs, reason: reason)
    }

    mutating func adoptPausedSources(_ capture: MeetingRemoteCapture, selection: MeetingCaptureChoice,
                                    boundary: UInt64, localEpoch: UInt64, stoppedByUser: Bool) -> [MeetingCaptureGap] {
        if let old = epochs[localEpoch] {
            epochs[localEpoch]?.endNanoseconds = min(old.endNanoseconds ?? boundary, boundary)
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
        var remapped: [MeetingCaptureGap] = []
        for tail in tails {
            for source in [selection.microphone?.sourceId, selection.outputSourceId].compactMap({ $0 }) {
                remapped.append(.init(id: UUID().uuidString.lowercased(), sourceId: source, epoch: capture.epoch,
                    startMs: tail.startMs, endMs: tail.endMs, reason: tail.reason))
            }
        }
        let remainingPauseStart = max(pauseStartedNanoseconds ?? boundary, boundary)
        remapped += endPause(at: boundary, localEpoch: localEpoch)
        // Old identities end at this boundary; the replacement owns the remaining gap,
        // including a source change made while already paused.
        pauseStartedNanoseconds = stoppedByUser ? nil : remainingPauseStart
        pauseGapSelection = (capture.epoch, selection)
        sourceBoundaryEpoch = capture.epoch
        pauseReason = "interrupted"
        return remapped
    }

    func nativeTime(_ milliseconds: UInt64) throws -> UInt64 {
        guard let origin = originNanoseconds, milliseconds <= (UInt64.max - origin) / 1_000_000 else {
            throw MeetingHostError.invalidResponse
        }
        return origin + milliseconds * 1_000_000
    }
}

private struct MeetingSourceGapTail: Hashable {
    let startMs: UInt64
    let endMs: UInt64
    let reason: String
}
