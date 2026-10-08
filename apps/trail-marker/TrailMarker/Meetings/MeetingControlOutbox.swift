import Foundation

/// Stop/Pause retry across conflicts. Resume retries only its exact paused generation;
/// newer authority cancels that intent and requires another explicit click.
struct MeetingControlOutbox {
    private(set) var pending: MeetingCaptureControlBody?
    private(set) var latestGeneration = -1

    mutating func accepts(generation: Int) -> Bool {
        guard generation >= latestGeneration else { return false }
        latestGeneration = generation
        return true
    }

    mutating func stage(command: String, meetingId: String, grantId: String, generation: Int) {
        if pending?.command == "stop" || pending?.command == command || (command == "record" && pending != nil) { return }
        pending = .init(meetingId: meetingId, grantId: grantId, requestKey: UUID().uuidString.lowercased(),
            expectedGeneration: generation, command: command)
    }

    mutating func reconcile(generation: Int, desired: String, retainedSourceMatches: Bool = true) {
        guard let request = pending else { return }
        if request.command == "record", generation > request.expectedGeneration || !retainedSourceMatches {
            pending = nil
        } else if desired == "stopped" || desired == "revoked" || (request.command == "pause" && desired == "paused") {
            pending = nil
        } else if generation > request.expectedGeneration {
            pending = .init(meetingId: request.meetingId, grantId: request.grantId,
                requestKey: UUID().uuidString.lowercased(), expectedGeneration: generation, command: request.command)
        }
    }

    @discardableResult
    mutating func rejectResume(requestKey: String) -> Bool {
        guard pending?.command == "record", pending?.requestKey == requestKey else { return false }
        pending = nil
        return true
    }

    mutating func received(requestKey: String, desired: String) {
        guard let request = pending, request.requestKey == requestKey else { return }
        if desired == "stopped" || (request.command == "pause" && desired == "paused") ||
            (request.command == "record" && desired == "recording") { pending = nil }
    }
}
