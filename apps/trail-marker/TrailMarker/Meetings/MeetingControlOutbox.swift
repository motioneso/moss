import Foundation

/// Stop/Pause remain pending across an uncertain request. Only a confirmed state clears intent;
/// unchanged state retries the same UUID, and a proven generation conflict creates a new request.
struct MeetingControlOutbox {
    private(set) var pending: MeetingCaptureControlBody?
    private(set) var latestGeneration = -1

    mutating func accepts(generation: Int) -> Bool {
        guard generation >= latestGeneration else { return false }
        latestGeneration = generation
        return true
    }

    mutating func stage(command: String, meetingId: String, grantId: String, generation: Int) {
        if pending?.command == "stop" || pending?.command == command { return }
        pending = .init(meetingId: meetingId, grantId: grantId, requestKey: UUID().uuidString.lowercased(),
            expectedGeneration: generation, command: command)
    }

    mutating func reconcile(generation: Int, desired: String) {
        guard let request = pending else { return }
        if desired == "stopped" || desired == "revoked" || (request.command == "pause" && desired == "paused") {
            pending = nil
        } else if generation > request.expectedGeneration {
            pending = .init(meetingId: request.meetingId, grantId: request.grantId,
                requestKey: UUID().uuidString.lowercased(), expectedGeneration: generation, command: request.command)
        }
    }

    mutating func received(requestKey: String, desired: String) {
        guard let request = pending, request.requestKey == requestKey else { return }
        if desired == "stopped" || (request.command == "pause" && desired == "paused") { pending = nil }
    }
}
