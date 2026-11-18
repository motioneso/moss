mod common;
use common::*;
use serde_json::{json, Value};

const APPROVE: &str = r#"{"allowed":true,"category":"news_publisher"}"#;
const REFUSE: &str = r#"{"allowed":false,"category":"news_publisher"}"#;
const HTML: &str = "text/html; charset=utf-8";
const RSS: &str = "application/rss+xml";

fn feed(titles: &[&str]) -> String {
    let items: String = titles
        .iter()
        .map(|t| format!("<item><title>{t}</title><link>https://news.example.com/{}</link></item>", t.len()))
        .collect();
    format!("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Example</title>{items}</channel></rss>")
}

fn home_with_feed() -> String {
    "<html><head><title>Example Daily</title><meta name=\"description\" content=\"Local news\">\
     <link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\"></head><body></body></html>"
        .into()
}

fn site(f: &Fake) {
    f.page("https://news.example.com/", 200, HTML, &home_with_feed());
    f.page("https://news.example.com/feed.xml", 200, RSS, &feed(&["First story here", "Second story here"]));
}

fn preview(f: &Fake, text: &str) -> Value {
    let (status, body) = f.route("POST", "/sources/preview", &[], json!({"input": text}));
    assert_eq!(status, 200, "{body}");
    body
}

fn confirm(f: &Fake, preview: &Value) -> (u16, Value) {
    f.route("POST", "/sources", &[], json!({"confirmationId": preview["confirmationId"]}))
}

#[test]
fn a_site_with_a_feed_link_previews_and_saves() {
    let f = Fake::new();
    site(&f);
    f.model_says(APPROVE);
    let shown = preview(&f, "news.example.com");
    assert_eq!(shown["status"], "ok");
    assert_eq!(shown["candidates"][0]["retrievalMethod"], "feed");
    assert_eq!(shown["candidates"][0]["canonicalDomain"], "news.example.com");
    assert_eq!(shown["candidates"][0]["sampleCount"], 2);
    let (status, saved) = confirm(&f, &shown);
    assert_eq!(status, 201, "{saved}");
    assert_eq!(saved["source"]["feedUrl"], "https://news.example.com/feed.xml");
    let rows = f.rows("app.news_custom_sources");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["confirmed_fetch_hosts"], json!(["news.example.com"]));
}

#[test]
fn a_site_without_a_feed_link_falls_back_to_page_headlines() {
    let f = Fake::new();
    let page = "<html><head><title>Plain Page</title></head><body>\
        <a href=\"/a\">A headline long enough to count</a><a href=\"/b\">Another headline long enough here</a>\
        <a href=\"/c\">short</a></body></html>";
    f.page("https://plain.example.com/", 200, HTML, page);
    f.model_says(APPROVE);
    let shown = preview(&f, "https://plain.example.com/");
    assert_eq!(shown["status"], "ok", "{shown}");
    assert_eq!(shown["candidates"][0]["retrievalMethod"], "scrape");
    assert_eq!(shown["candidates"][0]["sampleCount"], 2);
}

#[test]
fn an_address_that_is_itself_a_feed_is_used_directly() {
    let f = Fake::new();
    f.page("https://news.example.com/rss", 200, RSS, &feed(&["Only story here"]));
    f.model_says(APPROVE);
    let shown = preview(&f, "https://news.example.com/rss");
    assert_eq!(shown["candidates"][0]["retrievalMethod"], "feed");
}

#[test]
fn each_fetch_failure_reaches_the_preview() {
    let cases = [
        ("not_https", "not_https"),
        ("robots", "blocked"),
        ("blocked", "unreachable"),
        ("rate_limited", "unreachable"),
        ("http_error", "unreachable"),
        ("challenge", "unreachable"),
        ("timeout", "unreachable"),
        ("network", "unreachable"),
    ];
    for (reason, shown) in cases {
        let f = Fake::new();
        f.fails("https://down.example.com/", reason);
        let body = preview(&f, "down.example.com");
        assert_eq!(body["status"], "rejected", "{reason}");
        assert_eq!(body["reason"], shown, "{reason}");
        assert_eq!(f.model_calls(), 0);
    }
}

#[test]
fn input_that_is_not_https_or_not_an_address_is_refused_before_any_read() {
    let f = Fake::new();
    assert_eq!(preview(&f, "http://news.example.com")["reason"], "not_https");
    assert_eq!(preview(&f, "https://127.0.0.1/")["reason"], "invalid_input");
    assert_eq!(preview(&f, "some newspaper name")["status"], "unavailable");
    assert!(f.fetched().is_empty());
}

#[test]
fn an_excluded_publisher_is_refused_without_a_read() {
    let f = Fake::new();
    site(&f);
    assert!(f.route("POST", "/source-exclusions", &[], json!({"source":"example.com"})).0 < 300);
    let body = preview(&f, "news.example.com");
    assert_eq!(body["reason"], "policy");
    assert!(f.fetched().is_empty());
}

#[test]
fn a_redirect_inside_one_domain_is_noted_and_to_another_domain_refused() {
    let f = Fake::new();
    f.moved("https://example.com/", "https://www.example.com/", HTML, &home_with_feed().replace("/feed.xml", "https://www.example.com/feed.xml"));
    f.page("https://www.example.com/feed.xml", 200, RSS, &feed(&["Moved story here"]));
    // The model is never asked after a redirect, so the verdict must already be remembered.
    f.seed("app.news_policy_verdicts", A, json!({"canonical_domain":"www.example.com","fingerprint":"host-ai-v1",
        "verdict":"approved","decided_at":"2026-11-01T00:00:00.000Z","expires_at":"2999-01-01T00:00:00.000Z"}));
    let shown = preview(&f, "example.com");
    assert_eq!(shown["status"], "ok", "{shown}");
    assert!(shown["candidates"][0]["redirectNote"].as_str().unwrap().contains("www.example.com"));

    let g = Fake::new();
    g.moved("https://example.com/", "https://other.org/", HTML, &home_with_feed());
    assert_eq!(preview(&g, "example.com")["reason"], "redirected");
}

#[test]
fn a_followed_redirect_never_asks_the_model() {
    let f = Fake::new();
    f.moved("https://example.com/", "https://www.example.com/", HTML, &home_with_feed().replace("/feed.xml", "https://www.example.com/feed.xml"));
    f.page("https://www.example.com/feed.xml", 200, RSS, &feed(&["Moved story here"]));
    let body = preview(&f, "example.com");
    assert_eq!(body["status"], "unavailable");
    assert_eq!(f.model_calls(), 0);
}

#[test]
fn the_policy_refusal_and_unusable_answers_are_told_apart() {
    let f = Fake::new();
    site(&f);
    f.model_says(REFUSE);
    assert_eq!(preview(&f, "news.example.com")["reason"], "policy");
    // The refusal is remembered, so no second model call is made.
    assert_eq!(preview(&f, "news.example.com")["reason"], "policy");
    assert_eq!(f.model_calls(), 1);

    let g = Fake::new();
    site(&g);
    g.model_says("not json at all");
    let body = preview(&g, "news.example.com");
    assert_eq!(body["status"], "unavailable");
    assert_eq!(body["error"]["code"], "news.add_source.discovery_unavailable");
    // No model reply at all fails the same way.
    let h = Fake::new();
    site(&h);
    assert_eq!(preview(&h, "news.example.com")["status"], "unavailable");
}

#[test]
fn an_approval_is_remembered_for_a_day() {
    let f = Fake::new();
    site(&f);
    f.model_says(APPROVE);
    assert_eq!(preview(&f, "news.example.com")["status"], "ok");
    assert_eq!(preview(&f, "news.example.com")["status"], "ok");
    assert_eq!(f.model_calls(), 1);
    f.clock.set(f.clock.get() + 25 * 3600 * 1000);
    f.model_says(APPROVE);
    assert_eq!(preview(&f, "news.example.com")["status"], "ok");
    assert_eq!(f.model_calls(), 2);
}

#[test]
fn the_model_sees_the_page_as_marked_data() {
    let f = Fake::new();
    site(&f);
    f.model_says(APPROVE);
    preview(&f, "news.example.com");
    let calls = f.calls.borrow();
    let (_, _, _, ask) = calls.iter().find(|(p, _, _, _)| p == "ai").unwrap();
    let prompt = ask["prompt"].as_str().unwrap();
    assert!(prompt.contains("UNTRUSTED DATA") && prompt.contains("First story here"));
}

fn reddit_feed() -> String {
    let entry = |title: &str, host: &str| {
        format!(
            "<entry><content type=\"html\">&lt;a href=\"https://{host}/story\"&gt;[link]&lt;/a&gt;</content>\
             <id>t3_{title}</id><title>{title}</title><published>2025-09-04T14:13:20+00:00</published></entry>"
        )
    };
    format!(
        "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><category term=\"worldnews\" label=\"r/worldnews\"/>\
         <title>World News</title>{}{}</feed>",
        entry("A", "www.bbc.com"),
        entry("B", "www.espn.com")
    )
}

#[test]
fn a_subreddit_previews_with_its_own_domain_key_and_saves() {
    let f = Fake::new();
    f.page("https://www.reddit.com/r/worldnews/hot.rss", 200, "application/atom+xml", &reddit_feed());
    f.model_says(r#"{"allowed":true,"category":"news_community"}"#);
    let shown = preview(&f, "r/worldnews");
    assert_eq!(shown["status"], "ok", "{shown}");
    assert_eq!(shown["candidates"][0]["retrievalMethod"], "reddit");
    assert_eq!(shown["candidates"][0]["canonicalDomain"], "reddit.com");
    let (status, _) = confirm(&f, &shown);
    assert_eq!(status, 201);
    assert_eq!(f.rows("app.news_policy_verdicts")[0]["canonical_domain"], "reddit.com/r/worldnews");
    // A second subreddit is its own source and its own verdict.
    let again = preview(&f, "r/worldnews");
    assert_eq!(again["duplicateOfSourceId"], f.rows("app.news_custom_sources")[0]["id"]);
}

#[test]
fn each_subreddit_failure_reaches_the_preview() {
    let url = "https://www.reddit.com/r/worldnews/hot.rss";
    let cases = [("rate_limited", None, "rate_limited"), ("http_error", Some(403), "auth_required"),
        ("http_error", Some(404), "unreachable"), ("network", None, "unreachable"), ("blocked", None, "unreachable")];
    for (reason, status, shown) in cases {
        let f = Fake::new();
        let mut page = json!({"ok":false,"reason":reason});
        if let Some(s) = status {
            page["status"] = json!(s);
        }
        f.pages.borrow_mut().insert(url.into(), page);
        let body = preview(&f, "r/worldnews");
        assert_eq!(body["reason"], shown, "{reason} {status:?}");
    }
    let f = Fake::new();
    f.page(url, 200, "application/atom+xml", &reddit_feed());
    f.model_says(r#"{"allowed":false,"category":"news_community"}"#);
    assert_eq!(preview(&f, "r/worldnews")["reason"], "policy");
    assert_eq!(preview(&Fake::new(), "r/a")["reason"], "invalid_input");
}

#[test]
fn a_subreddit_that_redirects_is_refused() {
    let f = Fake::new();
    f.moved("https://www.reddit.com/r/worldnews/hot.rss", "https://www.reddit.com/search", "application/atom+xml", &reddit_feed());
    assert_eq!(preview(&f, "r/worldnews")["reason"], "unreachable");
}

#[test]
fn saving_covers_expired_duplicate_limit_replace_and_ambiguous() {
    let f = Fake::new();
    site(&f);
    f.model_says(APPROVE);
    let shown = preview(&f, "news.example.com");
    // Missing or unknown confirmations are expired.
    let (status, body) = f.route("POST", "/sources", &[], json!({"confirmationId": "11111111-1111-4111-8111-111111111111"}));
    assert_eq!((status, body["error"].as_str().unwrap()), (409, "Source preview expired or was not found"));
    assert_eq!(confirm(&f, &shown).0, 201);
    // A preview is single use.
    assert_eq!(confirm(&f, &shown).0, 409);
    // The same publisher again is a duplicate, and the preview says so.
    let again = preview(&f, "news.example.com");
    assert!(again["duplicateOfSourceId"].is_string());
    let (status, body) = confirm(&f, &again);
    assert_eq!((status, body["error"].as_str().unwrap()), (409, "news custom source already exists for this publisher"));
    // Replace keeps the row and resets its failures.
    let id = f.rows("app.news_custom_sources")[0]["id"].as_str().unwrap().to_owned();
    f.tables.borrow_mut().get_mut("app.news_custom_sources").unwrap()[0]["consecutive_failures"] = json!(4);
    let (_, replaced) = f.route("POST", "/sources/preview", &[], json!({"input":"news.example.com","replaceSourceId":id}));
    assert!(replaced.get("duplicateOfSourceId").is_none());
    assert_eq!(confirm(&f, &replaced).0, 201);
    let rows = f.rows("app.news_custom_sources");
    assert_eq!((rows.len(), rows[0]["consecutive_failures"].clone()), (1, json!(0)));
    // The limit is ten.
    for n in 0..9 {
        f.seed("app.news_custom_sources", A, json!({"canonical_domain": format!("s{n}.example.org"), "retrieval_method":"feed", "label":"x",
            "homepage_url":"https://x/", "validation_status":"approved","health_status":"healthy"}));
    }
    f.page("https://other.example.net/", 200, HTML, &home_with_feed().replace("/feed.xml", "https://other.example.net/f"));
    f.page("https://other.example.net/f", 200, RSS, &feed(&["Another one here"]));
    f.model_says(APPROVE);
    let extra = preview(&f, "other.example.net");
    let (status, body) = confirm(&f, &extra);
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "news personalization limit reached: at most 10 custom_sources per user");
}

#[test]
fn previews_expire_and_are_capped_at_ten_per_person() {
    let f = Fake::new();
    site(&f);
    f.model_says(APPROVE);
    let first = preview(&f, "news.example.com");
    f.clock.set(f.clock.get() + 11 * 60 * 1000);
    assert_eq!(confirm(&f, &first).0, 409);
    let mut ids = vec![];
    for _ in 0..11 {
        ids.push(preview(&f, "news.example.com"));
    }
    assert_eq!(confirm(&f, &ids[0]).0, 409, "the oldest is evicted");
    assert_eq!(confirm(&f, &ids[10]).0, 201);
}

#[test]
fn another_person_cannot_use_or_see_a_preview_or_verdict() {
    let f = Fake::new();
    site(&f);
    f.model_says(APPROVE);
    let shown = preview(&f, "news.example.com");
    f.as_actor(B);
    assert_eq!(confirm(&f, &shown).0, 409);
    f.as_actor(A);
    assert_eq!(confirm(&f, &shown).0, 201);
    f.as_actor(B);
    // B has no remembered verdict, so the model is asked again.
    f.model_says(APPROVE);
    assert_eq!(preview(&f, "news.example.com")["status"], "ok");
    assert_eq!(f.model_calls(), 2);
    assert!(preview(&f, "news.example.com").get("duplicateOfSourceId").is_none());
}

#[test]
fn bad_bodies_are_refused() {
    let f = Fake::new();
    assert_eq!(f.route("POST", "/sources/preview", &[], json!({})).0, 400);
    assert_eq!(f.route("POST", "/sources", &[], json!({})).0, 400);
}
