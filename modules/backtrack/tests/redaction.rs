use moss_backtrack_module::redact::redact;

#[test]
fn headers_urls_and_known_secret_shapes_are_masked() {
    let cases = [
        ("Authorization: Bearer abc123def456ghi789", "abc123def456ghi789"),
        ("curl -H \"Authorization: Bearer abc123def456ghi789\" x", "abc123def456ghi789"),
        ("https://user:hunter2pass@example.test/path", "hunter2pass"),
        ("password=correcthorsebattery", "correcthorsebattery"),
        ("api_key: sk-1234567890abcdefghij", "sk-1234567890abcdefghij"),
        ("{\"token\": \"abcdefghijklmnop1234\"}", "abcdefghijklmnop1234"),
        ("https://example.test/cb?access_token=abcdefghijklmnop", "abcdefghijklmnop"),
    ];
    for (input, secret) in cases {
        let out = redact(input);
        assert!(!out.contains(secret), "{input} -> {out}");
        assert!(out.contains("[redacted]"), "{input} -> {out}");
    }
}

#[test]
fn ordinary_text_passes_through_unchanged() {
    for text in ["Meeting notes for Tuesday", "https://example.test/page?x=1", "", "naïve café 東京"] {
        assert_eq!(redact(text), text);
    }
}

#[test]
fn redacting_twice_changes_nothing_more_and_long_input_stays_fast() {
    let once = redact("password=correcthorsebattery and more");
    assert_eq!(redact(&once), once);
    let long = "a:".repeat(50_000);
    let started = std::time::Instant::now();
    let _ = redact(&long);
    assert!(started.elapsed().as_secs() < 5);
}
