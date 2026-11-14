mod common;
use common::*;
use serde_json::json;

const SOURCES: &str = "app.news_custom_sources";
const TOPICS: &str = "app.news_custom_topics";
const SNAPSHOTS: &str = "app.news_compilation_snapshots";

fn source(domain: &str, feed: Option<&str>) -> serde_json::Value {
    json!({"label":"L","canonical_domain":domain,"homepage_url":format!("https://{domain}/"),
        "feed_url":feed,"retrieval_method":"feed","validation_status":"valid","health_status":"healthy",
        "fingerprint":"secret-fingerprint"})
}

#[test]
fn an_empty_account_reads_as_idle_with_every_ability_off() {
    let f = Fake::new();
    let (s, b) = f.route("GET", "/personalization", &[], json!(null));
    assert_eq!(s, 200);
    assert_eq!(b["availability"]["aiConfigured"], true);
    assert_eq!(b["availability"]["customSourceByUrlEnabled"], true);
    assert_eq!(b["availability"]["customSourceByNameEnabled"], false);
    assert_eq!(b["availability"]["webSearchReason"], "no-key-no-native-model");
    assert_eq!(b["snapshot"], json!(null));
    assert_eq!(b["refresh"]["state"], "idle");
    assert_eq!(b["customSources"], json!([]));
}

#[test]
fn reads_show_a_workaround_and_never_the_fingerprint() {
    let f = Fake::new();
    f.seed(SOURCES, A, source("example.com", Some("https://feedburner.test/x")));
    f.seed(
        SNAPSHOTS,
        A,
        json!({"payload":{"articles":[1,2,3]},"compiled_at":"2026-11-11T10:00:00.000+00:00","expires_at":"2026-11-11T12:00:00.000+00:00"}),
    );
    let (_, b) = f.route("GET", "/personalization", &[], json!(null));
    assert_eq!(b["customSources"][0]["workaround"], true);
    assert!(!b.to_string().contains("secret-fingerprint"));
    assert_eq!(b["snapshot"]["articleCount"], 3);
    assert_eq!(b["snapshot"]["compiledAt"], "2026-11-11T10:00:00.000Z");
}

#[test]
fn exclusions_normalize_repeat_and_stop_at_the_limit() {
    let f = Fake::new();
    let (s, b) = f.route("POST", "/source-exclusions", &[], json!({"source":"https://Example.com/x"}));
    assert_eq!(s, 200, "{b}");
    assert_eq!(b["exclusion"]["canonicalDomain"], "example.com");
    let id = b["exclusion"]["id"].clone();
    assert_eq!(f.route("POST", "/source-exclusions", &[], json!({"source":"example.com"})).1["exclusion"]["id"], id);
    let (s, b) = f.route("POST", "/source-exclusions", &[], json!({"source":"http://example.com"}));
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "Invalid publisher domain (non_https_scheme)"));
    for n in 0..99 {
        f.route("POST", "/source-exclusions", &[], json!({"source":format!("site{n}.example")}));
    }
    let (s, b) = f.route("POST", "/source-exclusions", &[], json!({"source":"one-more.example"}));
    assert_eq!(
        (s, b["error"].as_str().unwrap()),
        (400, "news personalization limit reached: at most 100 source_exclusions per user")
    );
    // A repeat is still answered at the limit.
    assert_eq!(f.route("POST", "/source-exclusions", &[], json!({"source":"example.com"})).0, 200);
    let (_, gone) = f.route("DELETE", "/source-exclusions/:id", &[("id", id.as_str().unwrap())], json!(null));
    assert_eq!(gone, json!({"ok":true}));
}

#[test]
fn removing_a_source_reports_the_delete() {
    let f = Fake::new();
    let id = f.seed(SOURCES, A, source("example.com", None));
    assert_eq!(f.route("DELETE", "/sources/:id", &[("id", &id)], json!(null)).1, json!({"deleted":true}));
    assert_eq!(f.route("DELETE", "/sources/:id", &[("id", &id)], json!(null)).1, json!({"deleted":false}));
}

#[test]
fn topics_need_web_search_to_add_or_change() {
    let f = Fake::new();
    let (s, b) = f.route("POST", "/topics", &[], json!({"label":"Space"}));
    assert_eq!((s, b), (503, json!({"error":"Topic discovery requires web search"})));
    let (s, b) = f.route("POST", "/topics", &[], json!({"label":"   "}));
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "Topic label is required"));
    let id = f.seed(TOPICS, A, json!({"label":"Space","guidance":null,"validation_status":"valid"}));
    let (s, _) = f.route("PATCH", "/topics/:id", &[("id", &id)], json!({"label":"Stars"}));
    assert_eq!(s, 503);
    let (_, b) = f.route("PATCH", "/topics/:id", &[("id", &id)], json!({}));
    assert_eq!(b["error"], "body must NOT have fewer than 1 properties");
    let missing = "00000000-0000-4000-8000-0000000000ff";
    let (s, b) = f.route("PATCH", "/topics/:id", &[("id", missing)], json!({"label":"x"}));
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "Topic was not found"));
    assert_eq!(f.route("DELETE", "/topics/:id", &[("id", &id)], json!(null)).1, json!({"deleted":true}));
}

#[test]
fn another_person_cannot_remove_or_prune_my_data() {
    let f = Fake::new();
    let id = f.seed(SOURCES, A, source("example.com", None));
    f.seed(SNAPSHOTS, A, json!({"payload":{"articles":[{"canonicalDomain":"example.com"}]}}));
    f.as_actor(B);
    assert_eq!(f.route("DELETE", "/sources/:id", &[("id", &id)], json!(null)).1, json!({"deleted":false}));
    f.route("POST", "/source-exclusions", &[], json!({"source":"example.com"}));
    assert_eq!(f.rows(SNAPSHOTS)[0]["payload"]["articles"].as_array().unwrap().len(), 1);
    assert_eq!(f.route("GET", "/personalization", &[], json!(null)).1["customSources"], json!([]));
}

#[test]
fn export_holds_only_the_owners_rows_and_no_fingerprint() {
    let f = Fake::new();
    let row = |d: &str| {
        let mut r = source(d, None);
        r["validated_at"] = json!(null);
        r["updated_at"] = json!("2026-11-11T10:00:00.000+00:00");
        r
    };
    f.seed(SOURCES, A, row("mine.example"));
    f.seed(SOURCES, B, row("theirs.example"));
    let out = moss_news_module::handle(&f, "api", r#"{"name":"collectNewsPersonalizationExportSection","parameters":{}}"#).unwrap();
    assert!(out.contains("mine.example") && !out.contains("theirs.example") && !out.contains("secret-fingerprint"));
    assert!(out.contains("custom_topics") && out.contains("source_exclusions"));
}
