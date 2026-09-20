import Foundation
import Security

/// One generic-password Keychain item per linked identity. The account string binds the
/// credential to a specific instance host and device id, so a leftover item from a previous
/// instance is never picked up by a new link (§9 client).
struct KeychainStore {
    private let service = "com.moss.trailmarker"

    func store(credential: String, for identity: LinkedIdentity) throws {
        let account = Self.account(for: identity)
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
            kSecAttrAccount as String: Self.account(for: identity),
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
            kSecAttrAccount as String: Self.account(for: identity)
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
