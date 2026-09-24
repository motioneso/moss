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

    /// Recognised lines, in order: normalised and redacted one by one, then a secret that exists
    /// only across a line break (a token cut in two, a grouped card number) masked on both sides.
    /// Lines are never merged before redacting: merging can erase the word boundaries a rule needs
    /// and let a secret through that each line alone would have lost.
    static func lines(_ raw: [String]) -> [String] {
        var out = raw.map(normalise).filter { !$0.isEmpty }.map(redact)
        guard out.count > 1 else { return out }
        for index in 0..<(out.count - 1) {
            var first = out[index]
            var second = out[index + 1]
            maskAcrossBreak(&first, &second)
            out[index] = first
            out[index + 1] = second
        }
        return out.filter { !$0.isEmpty }
    }

    /// A window title or an app name.
    static func title(_ raw: String) -> String {
        String(redact(normalise(raw)).prefix(titleLimit))
    }

    /// A web address, or nil when it isn't one. Only http(s); userinfo, query and fragment are
    /// dropped, and any path segment that looks like a secret or a long token becomes "…".
    static func address(_ raw: String) -> String? {
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.percentEncodedHost, !host.isEmpty
        else { return nil }
        // Built by hand from scheme, host, port and path only, so userinfo, query and fragment
        // can't come along. A display address for recall, not a URL to open.
        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).map {
            segment -> String in
            let text = String(segment)
            if text.isEmpty { return text }
            let decoded = text.removingPercentEncoding ?? text
            if redact(decoded) != decoded || matches(longToken, decoded) { return "…" }
            return text
        }
        let port = components.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host.lowercased())\(port)\(segments.joined(separator: "/"))"
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

    /// Recognition breaks a long token, or a grouped card number, across lines. Each line is already
    /// redacted on its own; this masks what is a secret only when the two halves are read together.
    /// It only ever adds masks, never removes one.
    private static func maskAcrossBreak(_ first: inout String, _ second: inout String) {
        var head = first.split(separator: " ").map(String.init)
        var tail = second.split(separator: " ").map(String.init)
        guard let end = head.last, let start = tail.first else { return }

        // A token cut mid-word: neither half is a secret, the two joined are.
        let joined = end + start
        if redact(end) == end, redact(start) == start, redact(joined) != joined {
            head[head.count - 1] = redacted
            tail[0] = redacted
        }

        // A grouped card number: the digit groups at the end of one line and the start of the next.
        let leading = head.reversed().prefix { isDigitGroup($0) }.count
        let trailing = tail.prefix { isDigitGroup($0) }.count
        if leading > 0, trailing > 0 {
            let digits = (head.suffix(leading) + tail.prefix(trailing)).joined().filter(\.isNumber)
            if (13...19).contains(digits.count), passesLuhn(digits) {
                head = Array(head.dropLast(leading)) + ["[card]"]
                tail = Array(tail.dropFirst(trailing))
            }
        }
        first = head.joined(separator: " ")
        second = tail.joined(separator: " ")
    }

    private static func isDigitGroup(_ word: String) -> Bool {
        !word.isEmpty && word.count <= 6 && word.allSatisfy { $0.isNumber || $0 == "-" } && word.contains { $0.isNumber }
    }

    private static func matches(_ expression: NSRegularExpression, _ text: String) -> Bool {
        expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func replace(_ expression: NSRegularExpression, in text: String, with template: String) -> String {
        expression.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
}
#endif
