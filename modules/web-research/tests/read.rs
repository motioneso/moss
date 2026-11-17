//! `web.read`: text extraction against the old reader, document shape, limits, reasons, and what
//! crosses the host boundary.
mod common;
use common::Fake;
use moss_web_research_module::reader::{cut, extract_readable_text, units};
use serde_json::{json, Value};

const VECTORS: &str = include_str!("data/extract-vectors.json");

#[test]
fn extraction_matches_the_old_reader_on_every_vector() {
    let rows: Vec<Value> = serde_json::from_str(VECTORS).unwrap();
    assert!(rows.len() >= 30);
    for row in rows {
        let (title, text) = extract_readable_text(row["html"].as_str().unwrap());
        assert_eq!(
            title,
            row["title"].as_str().unwrap(),
            "title of {}",
            row["html"]
        );
        assert_eq!(
            text,
            row["text"].as_str().unwrap(),
            "text of {}",
            row["html"]
        );
    }
}

#[test]
fn cutting_counts_utf16_units_and_never_splits_a_character() {
    assert_eq!(units("a\u{1F600}"), 3);
    assert_eq!(cut("a\u{1F600}b", 2), "a");
    assert_eq!(cut("a\u{1F600}b", 3), "a\u{1F600}");
    assert_eq!(cut("abc", 10), "abc");
}

fn article() -> &'static str {
    "<html><head><title>Hello &amp; World</title><style>p{}</style></head><body><nav>menu</nav><p>First</p><script>x()</script><p>Second</p></body></html>"
}

#[test]
fn a_page_becomes_a_document_with_text_excerpt_and_time() {
    let fake = Fake::new();
    fake.page("https://example.com/a", "text/html", article());
    let out = fake.read_tool(json!({"urls": ["https://example.com/a"]}));
    let doc = &out["data"]["documents"][0];
    assert_eq!(doc["url"], "https://example.com/a");
    assert_eq!(doc["domain"], "example.com");
    assert_eq!(doc["title"], "Hello & World");
    assert_eq!(doc["text"], "Hello & World First Second");
    assert_eq!(doc["excerpt"], "Hello & World First Second");
    assert_eq!(doc["fetchedAt"], "2026-11-16T10:00:00.000Z");
    assert_eq!(doc["truncated"], false);
    assert_eq!(doc["status"], 200);
    let trace = &out["data"]["trace"];
    assert_eq!(
        (
            trace["requestedUrlCount"].as_u64(),
            trace["fetchedUrlCount"].as_u64(),
            trace["skippedUrlCount"].as_u64(),
            trace["urlLimitApplied"].as_bool()
        ),
        (Some(1), Some(1), Some(0), Some(false))
    );
}

#[test]
fn long_text_is_cut_and_marked_truncated() {
    let fake = Fake::new();
    let body = format!("<p>{}</p>", "word ".repeat(5000));
    fake.page("https://example.com/long", "text/html", &body);
    let out = fake.read_tool(json!({"urls": ["https://example.com/long"]}));
    let doc = &out["data"]["documents"][0];
    assert_eq!(units(doc["text"].as_str().unwrap()), 12_000);
    assert_eq!(units(doc["excerpt"].as_str().unwrap()), 500);
    assert_eq!(doc["truncated"], true);
}

#[test]
fn only_five_addresses_are_read_and_the_rest_count_as_skipped() {
    let fake = Fake::new();
    let urls: Vec<String> = (0..7).map(|i| format!("https://example.com/{i}")).collect();
    for u in &urls {
        fake.page(u, "text/plain", "hi");
    }
    let out = fake.read_tool(json!({"urls": urls}));
    let trace = &out["data"]["trace"];
    assert_eq!(out["data"]["documents"].as_array().unwrap().len(), 5);
    assert_eq!(fake.fetches().len(), 5);
    assert_eq!(
        (
            trace["requestedUrlCount"].as_u64(),
            trace["skippedUrlCount"].as_u64(),
            trace["urlLimitApplied"].as_bool()
        ),
        (Some(7), Some(2), Some(true))
    );
}

#[test]
fn refused_pages_show_a_fixed_reason_and_unknown_reasons_read_as_network() {
    let fake = Fake::new();
    fake.refuse("https://a.test/", json!({"ok": false, "reason": "robots"}));
    fake.refuse(
        "https://b.test/",
        json!({"ok": false, "reason": "something odd <b>"}),
    );
    fake.refuse("https://c.test/", json!({"ok": false, "reason": "http_error", "detail": "response_too_large", "body": "SECRET-BODY"}));
    fake.page("https://d.test/", "text/plain", "fine");
    let out = fake.read_tool(json!({"urls": ["https://a.test/", "https://b.test/", "https://c.test/", "https://d.test/"]}));
    let seen = out["data"]["trace"]["documents"].as_array().unwrap();
    let find = |u: &str| seen.iter().find(|r| r["url"] == u).unwrap().clone();
    assert_eq!(
        find("https://a.test/"),
        json!({"url":"https://a.test/","status":"skipped","reason":"robots"})
    );
    assert_eq!(find("https://b.test/")["reason"], "network");
    assert_eq!(find("https://c.test/")["detail"], "response_too_large");
    assert_eq!(out["data"]["trace"]["skippedUrlCount"], 3);
    assert!(!out.to_string().contains("SECRET-BODY"));
    assert!(!out.to_string().contains("odd"));
}

#[test]
fn a_fetch_that_fails_outright_is_a_network_skip() {
    let fake = Fake::new();
    *fake.fetch_down.borrow_mut() = true;
    let out = fake.read_tool(json!({"urls": ["https://example.com/"]}));
    assert_eq!(out["data"]["trace"]["documents"][0]["reason"], "network");
}

#[test]
fn the_host_gets_exact_limits_and_the_address_goes_only_to_the_fetch() {
    let fake = Fake::new();
    let marker = "https://example.com/private-marker-7731?token=zz";
    fake.page(marker, "text/html", "<p>BODY-MARKER-9912</p>");
    fake.read_tool(json!({"urls": [marker], "goal": "GOAL-MARKER-5521"}));
    let sent = fake.fetches();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["maxBytes"], 500_000);
    assert_eq!(sent[0]["timeoutMs"], 8_000);
    assert_eq!(
        sent[0]["allowedContentTypes"],
        json!(["text/html", "application/xhtml+xml", "text/plain"])
    );
    for (port, _, _, params) in fake.calls.borrow().iter() {
        if port != "fetch" {
            let text = params.to_string();
            assert!(!text.contains("private-marker-7731"), "{port}: {text}");
            assert!(!text.contains("GOAL-MARKER-5521"), "{port}: {text}");
        }
    }
    assert!(!sent[0].to_string().contains("GOAL-MARKER-5521"));
}

#[test]
fn reading_works_without_a_search_key_and_an_empty_list_reads_nothing() {
    let fake = Fake::new();
    let out = fake.read_tool(json!({"urls": []}));
    assert_eq!(out["data"]["documents"], json!([]));
    assert!(fake.fetches().is_empty());
    assert!(fake.calls.borrow().iter().all(|c| c.0 != "credentials"));
}

#[test]
fn the_read_route_checks_input_and_answers_with_documents() {
    let fake = Fake::new();
    fake.page("https://example.com/a", "text/html", article());
    let (status, body) = fake.post("/read", json!({"urls": []}));
    assert_eq!(status, 400);
    assert!(body.to_string().contains("at least one address"));
    let (status, body) = fake.post("/read", json!({"urls": ["https://example.com/a"]}));
    assert_eq!(status, 200);
    assert_eq!(body["documents"][0]["title"], "Hello & World");
}

#[test]
fn the_web_read_api_answers_like_the_tool() {
    let fake = Fake::new();
    fake.page("https://example.com/a", "text/html", article());
    let out = fake.api("webRead", json!({"urls": ["https://example.com/a"]}));
    assert_eq!(out["data"]["documents"][0]["domain"], "example.com");
}
