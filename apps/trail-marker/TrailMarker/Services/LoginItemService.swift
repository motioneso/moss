import Foundation
import ServiceManagement

/// Thin wrapper over `SMAppService.mainApp`. macOS can leave a registration in
/// `.requiresApproval` (the person has to flip it on in System Settings themselves); the
/// This Mac settings pane surfaces that with a button straight to the right pane.
final class LoginItemService: LoginItemManaging {
    var status: LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .notRegistered: return .notRegistered
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .unavailable
        @unknown default: return .unavailable
        }
    }

    func setEnabled(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }

    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
