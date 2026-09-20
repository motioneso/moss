import CryptoKit
import Foundation
import Security

/// The account and device a Mac is linked to. Persisted in preferences; the credential itself
/// never is — it lives only in the Keychain, looked up by `instance.origin.host` + `deviceId`.
struct LinkedIdentity: Equatable, Codable {
    let instance: InstanceURL
    let deviceId: String
    let accountName: String
    let accountEmail: String
}

/// One in-flight browser-approval attempt. The verifier lives only in memory for the attempt;
/// only its sha256 (base64url) ever reaches the server, matching
/// `packages/auth/src/companion-crypto.ts` (`sha256Base64url`, `randomBase64url`).
struct LinkAttempt: Equatable {
    let verifier: String
    let verifierHash: String

    init(verifier: String = LinkAttempt.makeVerifier()) {
        self.verifier = verifier
        self.verifierHash = LinkAttempt.hash(verifier)
    }

    static func makeVerifier(bytes: Int = 32) -> String {
        var data = Data(count: bytes)
        let status = data.withUnsafeMutableBytes { buffer -> OSStatus in
            SecRandomCopyBytes(kSecRandomDefault, bytes, buffer.baseAddress!)
        }
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
        return data.base64URLEncodedString()
    }

    static func hash(_ verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64URLEncodedString()
    }
}

extension Data {
    /// RFC 4648 base64url, no padding — matches Node's `Buffer.toString("base64url")`.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
