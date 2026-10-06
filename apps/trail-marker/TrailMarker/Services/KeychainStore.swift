import Foundation
import Security

/// Generic-password storage. Legacy companion items retain their host/device account key.
/// Independent recording namespaces additionally bind the full canonical origin below.
struct KeychainStore {
    private let service: String
    private let recordingOrigin: String?

    /// Tests pass their own service, so they never read or prompt for the person's real items.
    init(service: String = "com.moss.trailmarker") {
        self.service = service
        recordingOrigin = nil
    }

    private init(service: String, recordingOrigin: String) {
        self.service = service
        self.recordingOrigin = recordingOrigin
    }

    private func accountKey(for identity: LinkedIdentity) -> String {
        if let recordingOrigin { return "\(recordingOrigin)|\(identity.deviceId)" }
        return Self.account(for: identity)
    }

    func store(credential: String, for identity: LinkedIdentity) throws {
        let account = accountKey(for: identity)
        delete(for: identity)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(credential.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.osStatus(status)
        }
    }

    func read(for identity: LinkedIdentity) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountKey(for: identity),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    func delete(for identity: LinkedIdentity) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountKey(for: identity)
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func account(for identity: LinkedIdentity) -> String {
        "\(identity.instance.origin.host ?? "")|\(identity.deviceId)"
    }
}

enum KeychainError: Error, Equatable {
    case osStatus(OSStatus)
}

extension KeychainStore {
    private static let visionKeyAccount = "vision-api-key"

    /// The rung 3 vision endpoint's API key. Not tied to a linked identity: it is a Mac-local
    /// setting the person enters once, kept only while an API-key vision source is chosen.
    func storeVisionKey(_ key: String) throws {
        deleteVisionKey()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.visionKeyAccount,
            kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.osStatus(status) }
    }

    func readVisionKey() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.visionKeyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    func deleteVisionKey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.visionKeyAccount
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

extension KeychainStore: BacktrackBufferKeyStoring {
    private static let backtrackBufferKeyAccount = "backtrack-buffer-key"

    /// The key that encrypts Backtrack's offline buffer on this Mac (phase 2 plan §5.1). Never
    /// leaves the Keychain except to open or seal the buffer, and is deleted with it.
    func storeBacktrackBufferKey(_ key: Data) throws {
        deleteBacktrackBufferKey()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.backtrackBufferKeyAccount,
            kSecValueData as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.osStatus(status) }
    }

    func readBacktrackBufferKey() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.backtrackBufferKeyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    @discardableResult
    func deleteBacktrackBufferKey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.backtrackBufferKeyAccount
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// Independent capability proof. A copied legacy companion credential cannot reconstruct it.
/// It is namespaced separately so replacing a heartbeat credential preserves explicit approval.
extension KeychainStore {
    private func recordingStore(for identity: LinkedIdentity, pending: Bool = false) -> KeychainStore {
        let origin = identity.instance.origin
        let scheme = origin.scheme?.lowercased() ?? ""
        let host = origin.host?.lowercased() ?? ""
        let port = origin.port ?? (scheme == "https" ? 443 : 80)
        let canonicalOrigin = "\(scheme)://\(host):\(port)"
        return KeychainStore(service: service + (pending ? ".meeting-recording-pending" : ".meeting-recording"),
                             recordingOrigin: canonicalOrigin)
    }

    func storeRecordingProof(_ proof: String, for identity: LinkedIdentity) throws {
        try recordingStore(for: identity).store(credential: proof, for: identity)
    }
    func readRecordingProof(for identity: LinkedIdentity) -> String? {
        recordingStore(for: identity).read(for: identity)
    }
    @discardableResult func deleteRecordingProof(for identity: LinkedIdentity) -> Bool {
        let removed = recordingStore(for: identity).delete(for: identity)
        let pending = recordingStore(for: identity, pending: true).delete(for: identity)
        return removed && pending
    }
    func storePendingRecordingProof(_ value: PendingRecordingProof, for identity: LinkedIdentity) throws {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else { throw MeetingHostError.invalidResponse }
        try recordingStore(for: identity, pending: true).store(credential: text, for: identity)
    }
    func readPendingRecordingProof(for identity: LinkedIdentity) -> PendingRecordingProof? {
        guard let text = recordingStore(for: identity, pending: true).read(for: identity) else { return nil }
        return try? JSONDecoder().decode(PendingRecordingProof.self, from: Data(text.utf8))
    }
    func deletePendingRecordingProof(for identity: LinkedIdentity) {
        recordingStore(for: identity, pending: true).delete(for: identity)
    }
}
