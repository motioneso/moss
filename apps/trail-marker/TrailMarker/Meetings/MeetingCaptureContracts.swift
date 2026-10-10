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
        var applicationId: String? = nil
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
    /// Exact current OS-default input UID, when it is an unambiguous advertised microphone.
    var defaultMicrophoneId: String? = nil

    private enum CodingKeys: String, CodingKey {
        case microphones, applications, computerAudio, microphonePermission, systemAudioPermission, defaultMicrophoneId
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(microphones, forKey: .microphones)
        try values.encode(applications, forKey: .applications)
        try values.encode(computerAudio, forKey: .computerAudio)
        try values.encode(microphonePermission, forKey: .microphonePermission)
        try values.encode(systemAudioPermission, forKey: .systemAudioPermission)
        // Omission means an older client. An unresolved default on this client must never
        // authorize the server's legacy single-microphone compatibility fallback.
        if let defaultMicrophoneId {
            try values.encode(defaultMicrophoneId, forKey: .defaultMicrophoneId)
        } else {
            try values.encodeNil(forKey: .defaultMicrophoneId)
        }
    }
}
struct MeetingCaptureChoice: Codable, Equatable {
    struct Microphone: Codable, Equatable { let deviceId: String; let sourceId: String }
    struct Scope: Codable, Equatable {
        let kind: String
        let endpointId: String?
        let excludedProcessTreeIds: [String]?
    }
    let mode: String
    let microphone: Microphone?
    let outputSourceId: String?
    let appProcessTreeId: String?
    let scope: Scope?
    var applicationId: String? = nil

    private enum CodingKeys: String, CodingKey {
        case mode, microphone, outputSourceId, appProcessTreeId, scope, applicationId
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(mode, forKey: .mode)
        // Computer-only capture explicitly transmits null; omission is not a source choice.
        if let microphone { try values.encode(microphone, forKey: .microphone) }
        else { try values.encodeNil(forKey: .microphone) }
        try values.encodeIfPresent(outputSourceId, forKey: .outputSourceId)
        try values.encodeIfPresent(appProcessTreeId, forKey: .appProcessTreeId)
        try values.encodeIfPresent(scope, forKey: .scope)
        try values.encodeIfPresent(applicationId, forKey: .applicationId)
    }
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
    var revision: String? = nil
    var recordedDurationMs: UInt64? = nil
    var finalization: String? = nil
    var processing: MeetingProcessingStatus? = nil
    var transcriptRevision: Int? = nil
    var leaseMs: UInt64? = nil
    var revocationReason: String? = nil

    var revocationMessage: String {
        switch revocationReason {
        case "device-unavailable": return "Recording stopped because this Mac was unlinked or its link expired."
        case "recording-permission-revoked": return "Recording stopped because recording permission was switched off in Moss."
        case "session-ended": return "Recording stopped because the starting browser session signed out or expired."
        case "connection-replaced": return "Recording stopped because this Mac connected again. Press Start in Moss again."
        default: return MeetingHostError.authorizationExpired.message
        }
    }

    func validate() throws {
        guard generation >= 0, generation <= 9_007_199_254_740_991, epoch <= 64,
              elapsedMs <= 9_007_199_254_740_991,
              ["idle", "recording", "paused", "stopped", "revoked"].contains(desired),
              ServerTime.parse(expiresAt) != nil else { throw MeetingHostError.invalidResponse }
    }
}
struct MeetingCaptureReply: Decodable { let capture: MeetingRemoteCapture }
struct MeetingCaptureReceipt: Decodable {
    let requestKey: String
    let status: String
    let code: String?
    var reason: String? = nil
    var stage: String? = nil
    var retryable: Bool? = nil
    var retryAfterMs: UInt64? = nil

    /// Both successful processing and a terminal processing failure release transient audio.
    /// An unrelated receipt or pending work never acknowledges this request's packet.
    func releasesAudio(matching expectedKey: String) -> Bool {
        requestKey == expectedKey && (status == "saved" || (status == "failed" && retryable != true))
    }
}
struct MeetingCaptureStatusBody: Encodable {
    let meetingId: String
    let grantId: String
    let inventory: MeetingCaptureInventory
    let observed: MeetingCaptureObserved
    var gaps: [MeetingCaptureGap] = []
    var finalized: Bool? = nil
    var recordedDurationMs: UInt64? = nil
}
struct MeetingCaptureControlBody: Encodable {
    let meetingId: String
    let grantId: String
    let requestKey: String
    let expectedGeneration: Int
    let command: String
    var expectedEpoch: UInt64? = nil
    var selection: MeetingCaptureChoice? = nil
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
    case authorizationExpired, rejected, network, invalidResponse, cleanupFailed, bufferExhausted, recoveryExhausted
    case retryAfter(milliseconds: UInt64)
    var retryDelayMilliseconds: UInt64? {
        if case .retryAfter(let milliseconds) = self { return milliseconds }
        return nil
    }
    var message: String {
        switch self {
        case .invalidActivation: return "Open this meeting from Moss to choose audio sources."
        case .wrongInstance: return "Link Trail Marker to the same Moss instance before starting this meeting."
        case .unavailable: return "That audio source is unavailable. Choose an available source in Moss."
        case .permissionDenied: return "Allow microphone access in System Settings, then press Start in Moss."
        case .sourceChanged: return "An audio source changed. Capture has stopped. Check the source and press Resume in Moss."
        case .authorizationExpired: return "Meeting access ended. Check the meeting and Mac connection in Moss before recording again."
        case .rejected: return "Moss did not accept the capture request. Check this meeting in Moss."
        case .network: return "Moss is unreachable. Capture is paused. Reconnect and press Resume in Moss."
        case .recoveryExhausted: return "Audio recovery could not finish. Capture is paused. Press Resume in Moss to try again."
        case .invalidResponse: return "Moss returned an incompatible meeting response. Update both apps before trying again."
        case .bufferExhausted: return "Audio memory reached its limit. Capture is paused. Reconnect and press Resume in Moss."
        case .retryAfter: return "Moss is temporarily busy. Capture continues only within its current connection lease."
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

/// A command is accepted once, only in this claimed native session. A reconnect establishes
/// a new generation floor instead of executing a stale "recording" response.
struct MeetingCommandFence {
    private(set) var highestGeneration = -1
    private(set) var needsReconnectBaseline = true
    mutating func interrupt() { needsReconnectBaseline = true }
    mutating func acceptFreshStart(generation: Int) {
        highestGeneration = generation - 1
        needsReconnectBaseline = false
    }
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

struct MeetingProcessingStatus: Codable, Equatable {
    let status: String
    var reason: String? = nil
    var stage: String? = nil
    var retryable: Bool? = nil
    var retryAfterMs: UInt64? = nil
}
struct MeetingRecordingConnectionBody: Encodable {
    let connectionId: String
    let verifierHash: String
    let inventory: MeetingCaptureInventory
}
struct MeetingRecordingConnectionReply: Decodable {
    let connectionId: String
    let revision: Int
    let leaseMs: UInt64
    let expiresAt: String
}
struct MeetingRecordingCommandsBody: Encodable {
    let connectionId: String
    let verifier: String
    var revision: String? = nil
    var waitMs: UInt64 = 10000
}
struct MeetingRecordingCommand: Codable, Equatable {
    let meetingId: String
    let grantId: String
    let ownerUserId: String
    let expiresAt: String
    let selection: MeetingCaptureChoice
    let capabilityRevision: Int
    var generation: Int = 1
}
struct MeetingRecordingCommandsReply: Decodable {
    let revision: String
    let command: MeetingRecordingCommand?
    let retryAfterMs: UInt64
}
struct MeetingRecordingClaimBody: Encodable {
    let connectionId: String
    let verifier: String
    let grantId: String
    let credentialHash: String
}
struct MeetingRecordingClaimReply: Decodable {
    let meetingId: String
    let grantId: String
    let expiresAt: String
    let capture: MeetingRemoteCapture
}

/// The permission dialog can return after Stop, reconnect or command expiry. Revalidate the
/// exact authority that opened it before letting that continuation acquire audio resources.
struct MeetingStartPermissionFence {
    let sessionGeneration: Int
    let captureGeneration: Int
    let grantId: String
    let deviceId: String
    let expiresAt: Date?

    func permits(session currentSession: Int, capture: MeetingRemoteCapture, now: Date,
                 cancelled: Bool, stopped: Bool) -> Bool {
        !cancelled && !stopped && currentSession == sessionGeneration &&
            capture.generation == captureGeneration && capture.grantId == grantId && capture.deviceId == deviceId &&
            capture.desired == "recording" && (expiresAt.map { now < $0 } ?? true) &&
            (ServerTime.parse(capture.expiresAt).map { now < $0 } ?? false)
    }
}

/// A retry always reuses the complete locally generated bearer and its hash. Neither a lost
/// response nor polling the same command mints a replacement authority for that Start.
struct MeetingPendingStart {
    private(set) var command: MeetingRecordingCommand
    let credential: String
    private let connectionId: String
    private let deviceId: String

    init(command: MeetingRecordingCommand, connectionId: String, deviceId: String,
         secret: String = LinkAttempt.makeVerifier()) {
        self.command = command
        self.connectionId = connectionId
        self.deviceId = deviceId
        credential = "mm1_\(command.ownerUserId).\(command.grantId).\(secret)"
    }

    /// A browser Resume may renew a still-unclaimed grant. Refresh its bounded command,
    /// never its bearer. Old responses cannot roll back a newer generation or cross bindings.
    @discardableResult mutating func refresh(_ next: MeetingRecordingCommand,
                                             connectionId: String, deviceId: String) throws -> Bool {
        guard self.connectionId == connectionId, self.deviceId == deviceId,
              next.grantId == command.grantId, next.ownerUserId == command.ownerUserId,
              next.meetingId == command.meetingId, next.capabilityRevision == command.capabilityRevision,
              next.generation > 0, next.generation <= 9_007_199_254_740_991 else {
            throw MeetingHostError.invalidResponse
        }
        if next.generation < command.generation { return false }
        if next.generation == command.generation {
            guard next == command else { throw MeetingHostError.invalidResponse }
            return false
        }
        command = next
        return true
    }

    func body(verifier: String) -> MeetingRecordingClaimBody {
        .init(connectionId: connectionId, verifier: verifier, grantId: command.grantId,
              credentialHash: MeetingCaptureClient.verifierHash(credential))
    }
}
