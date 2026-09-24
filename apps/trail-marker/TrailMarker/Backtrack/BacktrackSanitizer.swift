#if DEBUG
import Foundation

/// Cleans every field of a Backtrack segment before it can exist (plan §4.3). It removes known
/// kinds of secret: it cannot recognise an arbitrary password typed as plain text in a document,
/// and says so (spec §5). Email addresses are kept on purpose (Ben, 2026-09-23): "who sent that?"
/// is often the point; Focus judgment's `TextRedactor` still strips them.
enum BacktrackSanitizer {
    static let redacted = "[redacted]"
    static let titleLimit = 300

    // MARK: - Fields

    /// Recognised lines, in order: normalised, a secret split across two lines rejoined, then
    /// every line redacted.
    static func lines(_ raw: [String]) -> [String] {
        let normalised = raw.map(normalise).filter { !$0.isEmpty }
        return rejoinSplitSecrets(normalised).map(redact)
    }

    /// A window title or an app name.
    static func title(_ raw: String) -> String {
        String(redact(normalise(raw)).prefix(titleLimit))
    }

    /// A web address, or nil when it isn't one. Only http(s); userinfo, query and fragment are
    /// dropped, and any path segment that looks like a secret or a long token becomes "…".
    static func address(_ raw: String) -> String? {
        guard var components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty
        else { return nil }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).map {
            segment -> String in
            let text = String(segment)
            if text.isEmpty { return text }
            let decoded = text.removingPercentEncoding ?? text
            if redact(decoded) != decoded || matches(longToken, decoded) { return "…" }
            return text
        }
        components.percentEncodedPath = segments.joined(separator: "/")
        return components.string
    }

    // MARK: - Redaction

    /// Every pattern of `packages/ai/src/adapters/redact.ts:12-28`, in the same order, then card
    /// numbers that pass a Luhn check, then one-time codes.
    static func redact(_ text: String) -> String {
        var out = text
        for (expression, template) in serverPatterns {
            out = replace(expression, in: out, with: template)
        }
        out = redactCards(out)
        for (expression, template) in codePatterns {
            out = replace(expression, in: out, with: template)
        }
        return out
    }

    private static func regex(_ pattern: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern)
    }

    /// Ported from redact.ts; `$1`/`$2` keep the field name and quoting, as there.
    private static let serverPatterns: [(NSRegularExpression, String)] = [
        (regex(#"(?i)JARVIS_MCP_TOKEN=\S+"#), redacted),
        (regex(#"(?i)Bearer\s+\S+"#), redacted),
        (regex(#"jst_[A-Za-z0-9_-]+"#), redacted),
        (regex(#"(?i)\bsk-(?:(?:ant|proj|live|test)[-_])?[A-Za-z0-9][A-Za-z0-9_-]+\b"#), redacted),
        (regex(#"(?i)\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b"#), redacted),
        (regex(#"(?i)\b(?:ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b"#), redacted),
        (
            regex(#"(?i)([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token|key)=)[^&#\s]+"#),
            "$1" + redacted
        ),
        (
            regex(#"(?i)\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH(?:ORIZATION)?|CLIENT[_-]?SECRET|PASSWORD|SECRET|TOKEN|KEY)=[^&\s}]+"#),
            redacted
        ),
        (
            regex(#"(?i)(["']?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token|key)["']?\s*:\s*)(["']?)([^"'\s,}]+)\2"#),
            "$1$2" + redacted + "$2"
        )
    ]

    /// A 4 to 8 digit code next to "code", "verification", "OTP", "passcode" or "PIN".
    private static let codePatterns: [(NSRegularExpression, String)] = [
        (regex(#"(?i)\b(code|verification|otp|passcode|pin)\b([^\d\n]{0,30}?)\b\d{4,8}\b"#), "$1$2[code]"),
        (regex(#"(?i)\b\d{4,8}\b(?=[^\d\n]{0,20}\b(?:is your|code|verification|otp|passcode)\b)"#), "[code]")
    ]

    /// 13 to 19 digits, optionally grouped by spaces or dashes; masked only if they pass Luhn, so an
    /// order number or a phone number survives.
    private static let cardCandidate = regex(#"(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])"#)
    private static let longToken = regex(#"^[A-Za-z0-9_\-+=.~]{24,}$"#)

    private static func redactCards(_ text: String) -> String {
        let ns = text as NSString
        var out = ""
        var cursor = 0
        for match in cardCandidate.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let candidate = ns.substring(with: match.range)
            let digits = candidate.filter(\.isNumber)
            guard (13...19).contains(digits.count), passesLuhn(digits) else { continue }
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            out += "[card]"
            cursor = match.range.location + match.range.length
        }
        out += ns.substring(from: cursor)
        return out
    }

    static func passesLuhn(_ digits: String) -> Bool {
        var sum = 0
        for (index, character) in digits.reversed().enumerated() {
            guard var value = character.wholeNumberValue else { return false }
            if index % 2 == 1 {
                value *= 2
                if value > 9 { value -= 9 }
            }
            sum += value
        }
        return sum % 10 == 0
    }

    // MARK: - Helpers

    private static func normalise(_ text: String) -> String {
        let scalars = text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }
        return String(String.UnicodeScalarView(scalars))
            .split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
    }

    /// Recognition breaks a long token (or a grouped card number) across lines. When the end of one
    /// line and the start of the next redact differently together than apart, the two lines are
    /// joined first, so the whole secret is masked rather than two harmless-looking halves. Joined
    /// with a space when that is what makes the difference (a grouped card number), without one
    /// otherwise (a token cut mid-word).
    private static func rejoinSplitSecrets(_ lines: [String]) -> [String] {
        var out: [String] = []
        for line in lines {
            if let previous = out.last {
                let tail = previous.split(separator: " ").suffix(4).joined(separator: " ")
                let head = line.split(separator: " ").prefix(4).joined(separator: " ")
                if redact(tail + " " + head) != redact(tail) + " " + redact(head) {
                    out[out.count - 1] = previous + " " + line
                    continue
                }
                if redact(tail + head) != redact(tail) + redact(head) {
                    out[out.count - 1] = previous + line
                    continue
                }
            }
            out.append(line)
        }
        return out
    }

    private static func matches(_ expression: NSRegularExpression, _ text: String) -> Bool {
        expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func replace(_ expression: NSRegularExpression, in text: String, with template: String) -> String {
        expression.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
}
#endif
