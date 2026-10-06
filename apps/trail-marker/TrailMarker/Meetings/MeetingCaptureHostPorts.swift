import Foundation

/// Platform boundaries used by the app host and by synthetic lifecycle tests. Construction is
/// inert: none of these ports opens hardware, requests permission or initiates network work.
@MainActor
struct MeetingCaptureHostPorts {
    let identity: () -> LinkedIdentity?
    let connectionAvailable: () -> Bool
    let readInventory: () throws -> MeetingInventorySnapshot
    let microphonePermission: () -> MeetingCapturePermission
    let requestMicrophone: () async -> Bool
    let makeClient: (InstanceURL) -> MeetingCaptureClient
    let now: () -> UInt64
    let wallNow: () -> Date

    static func live(connection: ConnectionRuntime) -> Self {
        let reader = MeetingCaptureInventoryReader()
        return Self(identity: { connection.identity }, connectionAvailable: { connection.requestClient() != nil },
            readInventory: { try reader.read() }, microphonePermission: { MeetingCapturePermissions.microphone },
            requestMicrophone: { await MeetingCapturePermissions.requestMicrophoneFromUserClick() },
            makeClient: { MeetingCaptureClient(instance: $0) }, now: MeetingCaptureClock.now, wallNow: Date.init)
    }
}
