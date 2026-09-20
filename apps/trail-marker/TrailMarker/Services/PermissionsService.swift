import ApplicationServices
import CoreGraphics
import Foundation

enum PermissionState: Equatable {
    case granted
    case notGranted
}

/// Talks to the two system permission APIs. Kept behind a protocol so tests can assert
/// `refresh()` never prompts (§17: "Do not request Accessibility or Screen Recording on every
/// launch") while `requestAccessibility()` / `requestScreenRecording()` do, exactly once.
protocol PermissionsOSAdaptor {
    func accessibilityTrusted(prompting: Bool) -> Bool
    func screenRecordingGranted(prompting: Bool) -> Bool
}

struct SystemPermissionsAdaptor: PermissionsOSAdaptor {
    func accessibilityTrusted(prompting: Bool) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: prompting] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    func screenRecordingGranted(prompting: Bool) -> Bool {
        prompting ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    }
}

/// Permissions are informational in v1 (§17): they never gate account linking, and the app
/// never re-prompts on its own — only an explicit button press prompts.
@MainActor
final class PermissionsService: ObservableObject {
    @Published private(set) var accessibility: PermissionState = .notGranted
    @Published private(set) var screenRecording: PermissionState = .notGranted

    private let adaptor: PermissionsOSAdaptor

    init(adaptor: PermissionsOSAdaptor = SystemPermissionsAdaptor()) {
        self.adaptor = adaptor
    }

    /// Safe to call on every launch and whenever Settings appears: never prompts.
    func refresh() {
        accessibility = adaptor.accessibilityTrusted(prompting: false) ? .granted : .notGranted
        screenRecording = adaptor.screenRecordingGranted(prompting: false) ? .granted : .notGranted
    }

    func requestAccessibility() {
        accessibility = adaptor.accessibilityTrusted(prompting: true) ? .granted : .notGranted
    }

    func requestScreenRecording() {
        screenRecording = adaptor.screenRecordingGranted(prompting: true) ? .granted : .notGranted
    }
}
