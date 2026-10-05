import Foundation

/// Mirrors packages/shared/src/meeting-capture-api.ts. Credentials never enter this UI state.
enum MeetingCapturePermission: String, Codable { case granted, denied, unknown }
struct MeetingCaptureInventory: Codable, Equatable {
    struct Microphone: Codable, Equatable {
        let deviceId: String
        let sourceId: String
        let label: String
    }
    struct Application: Codable, Equatable {
        let appProcessTreeId: String
        let label: String
    }
    struct ComputerAudio: Codable, Equatable {
        let available: Bool
        let excludedProcessTreeIds: [String]
    }
    let microphones: [Microphone]
    let applications: [Application]
    let computerAudio: ComputerAudio
    let microphonePermission: MeetingCapturePermission
    let systemAudioPermission: MeetingCapturePermission
}
struct MeetingCaptureChoice: Codable, Equatable {
    struct Microphone: Codable, Equatable { let deviceId: String; let sourceId: String }
    struct Scope: Codable, Equatable {
        let kind: String
        let endpointId: String?
        let excludedProcessTreeIds: [String]?
    }
    let mode: String
    let microphone: Microphone
    let outputSourceId: String?
    let appProcessTreeId: String?
    let scope: Scope?
}
struct MeetingCaptureObserved: Codable, Equatable {
    let generation: Int
    let phase: String
    let errorCode: String?
}
struct MeetingRemoteCapture: Decodable {
    let grantId: String
    let deviceId: String
    let deviceName: String
    let generation: Int
    let epoch: UInt64
    let desired: String
    let selection: MeetingCaptureChoice?
    let epochStartMs: UInt64
    let epochEndMs: UInt64?
    let stopCutoffMs: UInt64?
    let finalizationDeadline: String?
    let expiresAt: String
    let serverTime: String
    let elapsedMs: UInt64
    let gaps: [MeetingCaptureGap]?
    let gapLimitReached: Bool?

    func validate() throws {
        guard generation >= 0, generation <= 9_007_199_254_740_991, epoch <= 64,
              elapsedMs <= 9_007_199_254_740_991,
              ["idle", "recording", "paused", "stopped", "revoked"].contains(desired),
              ServerTime.parse(expiresAt) != nil else { throw MeetingHostError.invalidResponse }
    }
}
struct MeetingCaptureReply: Decodable { let capture: MeetingRemoteCapture }
struct MeetingCaptureLink: Decodable {
    let challengeId: String
    let meetingId: String
    let deviceId: String
    let expiresAt: String
}
struct MeetingCaptureRedemption: Decodable {
    let status: String
    let credential: String?
    let grantId: String?
    let expiresAt: String?
}
struct MeetingCaptureReceipt: Decodable {
    let requestKey: String
    let status: String
    let code: String?

    /// Both successful processing and a terminal processing failure release transient audio.
    /// An unrelated receipt or pending work never acknowledges this request's packet.
    func releasesAudio(matching expectedKey: String) -> Bool {
        requestKey == expectedKey && ["saved", "failed"].contains(status)
    }
}
struct MeetingCaptureStatusBody: Encodable {
    let meetingId: String
    let grantId: String
    let inventory: MeetingCaptureInventory
    let observed: MeetingCaptureObserved
    var gaps: [MeetingCaptureGap] = []
}
struct MeetingCaptureControlBody: Encodable {
    let meetingId: String
    let grantId: String
    let requestKey: String
    let expectedGeneration: Int
    let command: String
}
struct MeetingCaptureAudioBody: Encodable {
    let meetingId: String
    let grantId: String
    let requestKey: String
    let generation: Int
    let epoch: UInt64
    let sourceId: String
    let sequence: UInt64
    let startMs: UInt64
    let endMs: UInt64
    let sampleRateHz: Int
    let pcmBase64: String
}

enum MeetingHostError: Error, Equatable {
    case invalidActivation, wrongInstance, unavailable, permissionDenied, sourceChanged
    case authorizationExpired, rejected, network, invalidResponse, cleanupFailed
    var message: String {
        switch self {
        case .invalidActivation: return "Open this meeting from Moss to prepare capture."
        case .wrongInstance: return "Link Trail Marker to the same Moss instance before preparing this meeting."
        case .unavailable: return "That audio source is unavailable. Choose a current source and press Record again."
        case .permissionDenied: return "Allow microphone access in System Settings, then prepare this meeting again."
        case .sourceChanged: return "An audio source changed. Capture has stopped. Check the source and press Record again."
        case .authorizationExpired: return "Meeting approval ended. Open this meeting from Moss and approve this Mac again."
        case .rejected: return "Moss did not accept the capture request. Check this meeting in Moss."
        case .network: return "Moss is unreachable. Capture is paused. Reconnect and press Record again."
        case .invalidResponse: return "Moss returned an incompatible meeting response. Update both apps before trying again."
        case .cleanupFailed: return "Audio cleanup is incomplete. Capture and sending are blocked; retry Stop before continuing."
        }
    }
}

struct MeetingActivation: Equatable {
    let instance: InstanceURL
    let meetingId: String

    /// MeetingsPage selects a record using the id query parameter on the module's sole route.
    var browserURL: URL? {
        guard var components = URLComponents(url: instance.endpoint("/meetings"), resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "id", value: meetingId)]
        return components.url
    }

    static func parse(_ url: URL) throws -> MeetingActivation {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "moss-meeting", parts.host == "capture", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let items = parts.queryItems, items.count == 2,
              Set(items.map(\.name)) == Set(["instance", "meetingId"]),
              let address = items.first(where: { $0.name == "instance" })?.value,
              let id = items.first(where: { $0.name == "meetingId" })?.value,
              let uuid = UUID(uuidString: id),
              case .success(let instance) = InstanceURL.parse(address), instance.basePath.isEmpty else {
            throw MeetingHostError.invalidActivation
        }
        return MeetingActivation(instance: instance, meetingId: uuid.uuidString.lowercased())
    }
}

/// A command is accepted once, only in this actively prepared session. A reconnect establishes
/// a new generation floor instead of executing a stale "recording" response.
struct MeetingCommandFence {
    private(set) var highestGeneration = -1
    private(set) var needsReconnectBaseline = true
    mutating func interrupt() { needsReconnectBaseline = true }
    mutating func shouldStart(generation: Int, desired: String) -> Bool {
        guard generation >= 0 else { return false }
        if needsReconnectBaseline {
            highestGeneration = max(highestGeneration, generation)
            needsReconnectBaseline = false
            return false
        }
        guard generation > highestGeneration else { return false }
        highestGeneration = generation
        return desired == "recording"
    }
}

struct MeetingCaptureGap: Codable, Equatable {
    let id: String
    let sourceId: String
    let epoch: UInt64
    let startMs: UInt64
    let endMs: UInt64
    let reason: String
}

/// A server-confirmed gap cap is a terminal metadata outcome, not an acknowledgment to wait for.
/// The host retains a visible incomplete-coverage flag while allowing bounded final close.
enum MeetingGapDelivery {
    static func remaining(_ pending: [MeetingCaptureGap], acknowledgedIDs: Set<String>, limitReached: Bool) -> [MeetingCaptureGap] {
        if limitReached { return [] }
        return pending.filter { !acknowledgedIDs.contains($0.id) }
    }
}
