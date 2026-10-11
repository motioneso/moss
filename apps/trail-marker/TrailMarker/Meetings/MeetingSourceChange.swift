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

    static func message(_ error: Error) -> String {
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
