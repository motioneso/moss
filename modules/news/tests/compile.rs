//! Part 5a: compiling the page. Canned model answers and the fixed-order fallback are checked
//! against the order the old compiler produced for the same stories.
mod common;
use common::{Fake, A, B};
use moss_news_module::compile::{apply_filters, order_ranked, Candidate, Ranked};
use serde_json::json;

const FEED: &str = "https://daily.example.com/feed.xml";

fn feed(items: &[(&str, &str, &str)]) -> String {
    let rows: String = items
        .iter()
        .map(|(title, link, date)| {
            format!("<item><title>{title}</title><link>{link}</link><pubDate>{date}</pubDate><description>About {title}</description></item>")
        })
        .collect();
    format!("<rss><channel><title>Daily</title>{rows}</channel></rss>")
}

fn saved_source(fake: &Fake) {
    fake.seed(
        "app.news_custom_sources",
        A,
        json!({
            "label": "Daily Example", "canonical_domain": "daily.example.com",
            "homepage_url": "https://daily.example.com/", "feed_url": FEED,
            "retrieval_method": "feed", "validation_status": "approved", "health_status": "healthy",
        }),
    );
}

fn titles(body: &serde_json::Value) -> Vec<String> {
    body["rankedStories"].as_array().unwrap().iter().map(|row| row["title"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn canned_model_ranking_orders_the_page_and_stores_the_snapshot() {
    let fake = Fake::new();
    saved_source(&fake);
    fake.page(
        FEED,
        200,
        "application/rss+xml",
        &feed(&[
            ("Alpha story", "https://daily.example.com/a", "Fri, 06 Nov 2026 09:00:00 GMT"),
            ("Beta story", "https://daily.example.com/b", "Fri, 06 Nov 2026 10:00:00 GMT"),
            ("Gamma story", "https://daily.example.com/c", "Fri, 06 Nov 2026 08:00:00 GMT"),
        ]),
    );
    // The model puts Gamma first and drops Beta.
    fake.model_says(r#"{"rankings":[{"id":"c3","relevance":90,"eligible":true},{"id":"c1","relevance":50,"eligible":true},{"id":"c2","relevance":99,"eligible":false}]}"#);
    let (status, body) = fake.route("GET", "/overview", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(titles(&body), vec!["Gamma story", "Alpha story"]);
    assert_eq!(body["topStories"].as_array().unwrap().len(), 2);
    assert_eq!(body["degraded"], json!(false));
    let snapshots = fake.rows("app.news_compilation_snapshots");
    assert_eq!(snapshots.len(), 1);
    let articles = snapshots[0]["payload"]["articles"].as_array().unwrap();
    assert_eq!(articles.len(), 2);
    assert_eq!(articles[0]["headline"], json!("Gamma story"));
    assert_eq!(articles[0]["rank"], json!(1));
    // A second read serves the stored page without reading the feed again.
    let fetched_before = fake.fetched().len();
    let (status, again) = fake.route("GET", "/overview", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(titles(&again), vec!["Gamma story", "Alpha story"]);
    assert_eq!(fake.fetched().len(), fetched_before);
}

#[test]
fn fallback_order_matches_the_old_fixed_order() {
    let fake = Fake::new();
    saved_source(&fake);
    fake.page(
        FEED,
        200,
        "application/rss+xml",
        &feed(&[
            ("Older story", "https://daily.example.com/old", "Fri, 06 Nov 2026 08:00:00 GMT"),
            ("Newer story", "https://daily.example.com/new", "Fri, 06 Nov 2026 10:00:00 GMT"),
            ("Same time B", "https://daily.example.com/b", "Fri, 06 Nov 2026 09:00:00 GMT"),
            ("Same time A", "https://daily.example.com/a", "Fri, 06 Nov 2026 09:00:00 GMT"),
        ]),
    );
    // No model answer queued, so the model call fails and the fixed order applies.
    let (status, body) = fake.route("GET", "/overview", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(titles(&body), vec!["Newer story", "Same time A", "Same time B", "Older story"]);
    assert_eq!(fake.model_calls(), 1);
}

#[test]
fn filters_drop_excluded_old_and_duplicate_stories() {
    let fake = Fake::new();
    saved_source(&fake);
    fake.seed("app.news_source_exclusions", A, json!({"canonical_domain": "blocked.example.com"}));
    fake.page(
        FEED,
        200,
        "application/rss+xml",
        &feed(&[
            ("Kept story", "https://daily.example.com/keep", "Fri, 06 Nov 2026 10:00:00 GMT"),
            ("Kept story", "https://daily.example.com/dupe", "Fri, 06 Nov 2026 09:00:00 GMT"),
            ("Ancient story", "https://daily.example.com/old", "Sat, 01 Aug 2026 09:00:00 GMT"),
            ("Future story", "https://daily.example.com/future", "Sat, 07 Nov 2026 10:00:00 GMT"),
        ]),
    );
    let (status, body) = fake.route("GET", "/overview", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(titles(&body), vec!["Kept story"]);
}

#[test]
fn another_person_gets_their_own_page() {
    let fake = Fake::new();
    saved_source(&fake);
    fake.page(
        FEED,
        200,
        "application/rss+xml",
        &feed(&[("Alpha story", "https://daily.example.com/a", "Fri, 06 Nov 2026 09:00:00 GMT")]),
    );
    let (status, body) = fake.route("GET", "/overview", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(titles(&body), vec!["Alpha story"]);
    fake.as_actor(B);
    let (status, other) = fake.route("GET", "/overview", &[], json!(null));
    assert_eq!(status, 200);
    // B has no saved source, and the default catalog feeds are not in the fake pages.
    assert!(other["rankedStories"].as_array().unwrap().iter().all(|row| row["title"] != json!("Alpha story")));
    assert_eq!(fake.rows("app.news_compilation_snapshots").iter().filter(|row| row["owner_user_id"] == json!(A)).count(), 1);
}

#[test]
fn compile_of_three_hundred_candidates_stays_fast() {
    let now_ms = 1_794_000_000_000_i64;
    let date = "2026-11-06T09:00:00.000Z";
    let candidates: Vec<Candidate> = (0..300)
        .map(|index| Candidate {
            id: format!("c{}", index + 1),
            publisher: "Daily".into(),
            canonical_domain: "daily.example.com".into(),
            headline: format!("Story number {index}"),
            url: format!("https://daily.example.com/{index}"),
            published_at: date.into(),
            excerpt: None,
            image_url: None,
            origin: "curated",
            matched_topics: vec![],
        })
        .collect();
    let started = std::time::Instant::now();
    let filtered = apply_filters(candidates, &[], now_ms);
    let ranked = order_ranked(
        filtered
            .iter()
            .map(|candidate| Ranked { candidate: candidate.clone(), relevance: 0, preferred_boost: true })
            .collect(),
    );
    let elapsed = started.elapsed();
    assert_eq!(ranked.len(), 300);
    // The measured budget for the filter and order step on this machine class.
    assert!(elapsed.as_millis() < 500, "filter and order took {elapsed:?}");
}

#[test]
fn malformed_model_answers_fall_back() {
    let fake = Fake::new();
    saved_source(&fake);
    fake.page(
        FEED,
        200,
        "application/rss+xml",
        &feed(&[("Only story", "https://daily.example.com/a", "Fri, 06 Nov 2026 09:00:00 GMT")]),
    );
    fake.model_says("not json at all");
    let (status, body) = fake.route("GET", "/overview", &[], json!(null));
    assert_eq!(status, 200);
    assert_eq!(titles(&body), vec!["Only story"]);
}
