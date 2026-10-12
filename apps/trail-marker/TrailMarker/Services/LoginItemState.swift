import Foundation

enum LoginItemStatus: Equatable {
    case notRegistered, enabled, requiresApproval, unavailable
}

protocol LoginItemManaging {
    var status: LoginItemStatus { get }
    func setEnabled(_ enabled: Bool) throws
    func openSystemSettings()
}

/// The native setting reflects the service's confirmed state, never an optimistic request.
struct LoginItemState {
    private(set) var status: LoginItemStatus = .notRegistered
    private(set) var errorMessage: String?

    var isEnabled: Bool { status == .enabled }
    var showsSystemSettings: Bool {
        status == .requiresApproval || status == .unavailable || errorMessage != nil
    }

    var statusMessage: String? {
        switch status {
        case .notRegistered, .enabled: return nil
        case .requiresApproval: return "Start at login needs approval in System Settings."
        case .unavailable: return "macOS couldn’t confirm Trail Marker’s login item."
        }
    }

    mutating func refresh(using service: any LoginItemManaging) {
        let current = service.status
        if current != status { errorMessage = nil }
        status = current
    }

    mutating func setEnabled(_ enabled: Bool, using service: any LoginItemManaging) {
        errorMessage = nil
        do {
            try service.setEnabled(enabled)
        } catch {
            let action = enabled ? "turn on" : "turn off"
            errorMessage = "Couldn’t \(action) Start at login. \(error.localizedDescription)"
        }
        // Registration can require approval, and a thrown operation can still change status.
        status = service.status
    }
}
