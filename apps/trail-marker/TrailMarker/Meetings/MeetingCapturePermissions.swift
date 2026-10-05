import AVFoundation
import AppKit

/// Querying authorization never requests it. System-audio permission has no equivalent public
/// preflight here: only an explicit Record may create/start a tap and let macOS ask.
enum MeetingCapturePermissions {
    static var microphone: MeetingCapturePermission {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .unknown
        @unknown default: return .unknown
        }
    }

    static func requestMicrophoneFromUserClick() async -> Bool {
        if microphone == .granted { return true }
        guard microphone == .unknown else { return false }
        return await AVCaptureDevice.requestAccess(for: .audio)
    }

    static func openMicrophoneSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
            NSWorkspace.shared.open(url)
        }
    }
}
