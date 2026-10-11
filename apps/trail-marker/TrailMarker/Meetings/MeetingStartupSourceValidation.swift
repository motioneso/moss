import Foundation

/// Recovery never changes the selected scope: only an unoffered startup epoch may discard
/// uncertain PCM and confirm one incomplete inventory against the exact original selection.
@MainActor
enum MeetingStartupSourceValidation {
    enum Outcome {
        case valid(MeetingInventorySnapshot, recovered: Bool)
        case invalid(MeetingCaptureSourceDiagnostics.Reason)
    }

    static func validate(_ fresh: MeetingInventorySnapshot, choice: MeetingCaptureChoice,
                         selected: MeetingInventorySnapshot.Resolved, original: MeetingInventorySnapshot?,
                         runtime: MeetingCaptureRuntime, ports: MeetingCaptureHostPorts) -> Outcome {
        guard choice.microphone == nil || ports.microphonePermission() == .granted else {
            return .invalid(.microphonePermissionNotGranted)
        }
        let reason: MeetingCaptureSourceDiagnostics.Reason
        if let current = try? fresh.resolve(choice) {
            if current == selected { return .valid(fresh, recovered: false) }
            reason = .resolvedNotEqual
        } else { reason = .resolveThrew }
        if let original, fresh.onlyOmitsStartupSources(from: original, choice: choice),
           runtime.beginStartupSourceRecheck(at: ports.now()) {
            let confirmation = try? ports.readInventory()
            let unchanged = confirmation.flatMap { try? $0.resolve(choice) } == selected &&
                (choice.microphone == nil || ports.microphonePermission() == .granted)
            if runtime.finishStartupSourceRecheck(at: ports.now(), unchanged: unchanged), let confirmation {
                return .valid(confirmation, recovered: true)
            }
        }
        return .invalid(reason)
    }
}
