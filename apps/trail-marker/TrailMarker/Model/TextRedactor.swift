import Foundation

/// Cleans text that is about to leave this Mac (an app name or a window title). It removes what
/// looks like a secret or a person's address, then cuts to a hard length. The order matters:
/// redacting first means a long token cannot survive by being cut in half below the token length.
enum TextRedactor {
    /// An email address, wherever it sits in the text.
    private static let email = try! NSRegularExpression(
        pattern: "[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}"
    )

    /// A run of 24 or more characters from the alphabets tokens and keys are written in.
    /// Ordinary words and file names are far shorter.
    private static let token = try! NSRegularExpression(pattern: "[A-Za-z0-9_\\-+/=]{24,}")

    static func clean(_ text: String, limit: Int) -> String {
        guard limit > 0 else { return "" }

        var result = String(
            String.UnicodeScalarView(
                text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }
            )
        )

        result = replace(email, in: result, with: "[email]")
        result = replace(token, in: result, with: "[redacted]")
        result = result.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")

        return String(result.prefix(limit))
    }

    private static func replace(_ expression: NSRegularExpression, in text: String, with template: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        return expression.stringByReplacingMatches(
            in: text, range: range, withTemplate: NSRegularExpression.escapedTemplate(for: template)
        )
    }
}
