#if DEBUG
import XCTest
@testable import TrailMarker

/// Backtrack plan §4.3: every retained field is cleaned of known kinds of secret on the Mac.
final class BacktrackSanitizerTests: XCTestCase {
    private func line(_ text: String) -> String { BacktrackSanitizer.lines([text]).first ?? "" }

    func testServerPatternsArePorted() {
        XCTAssertEqual(line("Authorization: Bearer abc.def.ghi"), "Authorization: [redacted]")
        XCTAssertEqual(line("use sk-proj-abcdefghijklmnop now"), "use [redacted] now")
        XCTAssertEqual(line("key sk_live_abcdefgh12345678"), "key [redacted]")
        XCTAssertEqual(line("ghp_abcdefghijklmnopqrstu"), "[redacted]")
        XCTAssertEqual(line("AKIAABCDEFGHIJKLMNOP"), "[redacted]")
        XCTAssertEqual(line("jst_session12345"), "[redacted]")
        XCTAssertEqual(line("JARVIS_MCP_TOKEN=xyz123"), "[redacted]")
        XCTAssertEqual(line("API_KEY=supersecretvalue"), "[redacted]")
        XCTAssertEqual(line(#"{"password": "hunter2"}"#), #"{"password": "[redacted]"}"#)
        // As in redact.ts: the query rule keeps the key, then the environment rule masks key and value.
        XCTAssertEqual(line("https://x.com/cb?access_token=abc123&ok=1"), "https://x.com/cb?[redacted]&ok=1")
    }

    func testCardsAreMaskedOnlyWhenTheyPassLuhn() {
        XCTAssertEqual(line("Card 4111 1111 1111 1111 exp 12/29"), "Card [card] exp 12/29")
        XCTAssertEqual(line("4242424242424242"), "[card]")
        XCTAssertEqual(line("Order 4111 1111 1111 1112 shipped"), "Order 4111 1111 1111 1112 shipped")
        XCTAssertEqual(line("Call 415 555 0123"), "Call 415 555 0123")
    }

    func testOneTimeCodesAreMasked() {
        XCTAssertEqual(line("Your verification code is 482913"), "Your verification code is [code]")
        XCTAssertEqual(line("482913 is your login code"), "[code] is your login code")
        XCTAssertEqual(line("OTP: 1234"), "OTP: [code]")
        XCTAssertEqual(line("Meeting at 1400 in room 12"), "Meeting at 1400 in room 12")
    }

    func testEmailAddressesAndProseAreKept() {
        XCTAssertEqual(line("From ben@example.com about the plan"), "From ben@example.com about the plan")
        XCTAssertEqual(line("The quarterly plan is on track"), "The quarterly plan is on track")
    }

    func testATokenSplitAcrossTwoLinesIsRejoinedAndMasked() {
        let out = BacktrackSanitizer.lines(["Your token ghp_abcd", "efgh1234ijkl and more"])
        XCTAssertFalse(out.joined(separator: " ").contains("efgh1234"), "\(out)")
        XCTAssertFalse(out.joined(separator: " ").contains("ghp_abcd"), "\(out)")
    }

    /// Found building Phase 1: merging lines before redacting joined "482913" to "API_KEY=…",
    /// erasing the word boundaries both rules need, so the merged line kept both secrets.
    func testNeighbouringSecretsOnTwoLinesAreBothStillMasked() {
        let out = BacktrackSanitizer.lines(["Your code is 482913", "API_KEY=supersecretvalue"])
        XCTAssertEqual(out, ["Your code is [code]", "[redacted]"])
    }

    func testACardNumberSplitAcrossTwoLinesIsRejoinedAndMasked() {
        let out = BacktrackSanitizer.lines(["Card number 4111 1111", "1111 1111 on file"])
        XCTAssertFalse(out.joined(separator: " ").contains("1111 1111"), "\(out)")
    }

    func testTitlesAndAppNamesAreSanitisedAndCapped() {
        XCTAssertEqual(BacktrackSanitizer.title("Keys sk-proj-abcdefghijklmnop — Notes"), "Keys [redacted] — Notes")
        XCTAssertEqual(BacktrackSanitizer.title(String(repeating: "a ", count: 400)).count, BacktrackSanitizer.titleLimit)
    }

    func testAddressesLoseUserinfoQueryFragmentAndSecretSegments() {
        XCTAssertEqual(
            BacktrackSanitizer.address("https://ben:hunter2@example.com/docs/page?token=abc#section"),
            "https://example.com/docs/page"
        )
        XCTAssertEqual(
            BacktrackSanitizer.address("https://example.com/reset/aZ9kQ2mN8pL4tX7vB1cD3eF5gH6/confirm"),
            "https://example.com/reset/…/confirm"
        )
        XCTAssertEqual(
            BacktrackSanitizer.address("https://api.example.com/keys/sk-proj-abcdefghijklmnop"),
            "https://api.example.com/keys/…"
        )
        XCTAssertNil(BacktrackSanitizer.address("file:///Users/ben/Secrets.txt"))
        XCTAssertNil(BacktrackSanitizer.address("not a url"))
    }

    func testLuhn() {
        XCTAssertTrue(BacktrackSanitizer.passesLuhn("4111111111111111"))
        XCTAssertFalse(BacktrackSanitizer.passesLuhn("4111111111111112"))
    }
}
#endif
