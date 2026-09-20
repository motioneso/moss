import Foundation
import ServiceManagement

/// Thin wrapper over `SMAppService.mainApp`. macOS can leave a registration in
/// `.requiresApproval` (the person has to flip it on in System Settings themselves); the
/// This Mac settings pane surfaces that with a button straight to the right pane.
final class LoginItemService {
    var isRegistered: Bool {
        SMAppService.mainApp.status == .enabled
    }

    var requiresApproval: Bool {
        SMAppService.mainApp.status == .requiresApproval
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
