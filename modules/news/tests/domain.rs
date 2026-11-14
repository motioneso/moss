use moss_news_module::domain::{is_workaround, matches, normalize};

#[test]
fn accepts_the_forms_people_paste() {
    for (input, want) in [
        ("example.com", "example.com"),
        ("  Example.COM  ", "example.com"),
        ("https://www.example.com/news?x=1#top", "www.example.com"),
        ("https://example.com:443/", "example.com"),
        ("example.com.", "example.com"),
        ("//example.co.uk/path", "example.co.uk"),
    ] {
        assert_eq!(normalize(input), Ok(want.to_owned()), "{input}");
    }
}

#[test]
fn refuses_with_the_old_reasons() {
    for (input, why) in [
        ("", "empty"),
        ("   ", "empty"),
        ("http://example.com", "non_https_scheme"),
        ("ftp://example.com", "non_https_scheme"),
        ("https://user:pw@example.com", "credentials"),
        ("https://example.com:8443", "explicit_port"),
        ("https://192.168.1.4", "ip_literal"),
        ("https://[::1]/", "ip_literal"),
        ("localhost", "single_label"),
        ("exa_mple.com", "invalid_label"),
        ("-bad.example.com", "invalid_label"),
    ] {
        assert_eq!(normalize(input), Err(why), "{input}");
    }
    assert_eq!(normalize(&"a".repeat(2049)), Err("input_too_long"));
}

#[test]
fn a_domain_covers_its_sub_domains_only() {
    assert!(matches("example.com", "example.com"));
    assert!(matches("example.com", "news.example.com"));
    assert!(!matches("example.com", "notexample.com"));
    assert!(!matches("news.example.com", "example.com"));
}

#[test]
fn a_feed_on_another_site_is_a_workaround() {
    assert!(!is_workaround("example.com", Some("https://example.com/feed")));
    assert!(!is_workaround("example.com", Some("https://feeds.example.com/x")));
    assert!(is_workaround("example.com", Some("https://feedburner.test/x")));
    assert!(!is_workaround("example.com", None));
}
