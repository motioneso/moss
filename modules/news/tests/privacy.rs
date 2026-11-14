mod common;
use common::*;
use serde_json::{json, Value};

const MARK: &str = "PLANTED-MARKER-4f1c9b";

#[test]
fn text_a_person_types_never_reaches_a_response_log_job_or_activity_row() {
    let f = Fake::new();
    let mut out: Vec<Value> = vec![];
    out.push(f.route("POST", "/prefs", &[], json!({"kind":"source","key":MARK})).1);
    out.push(f.route("POST", "/prefs", &[], json!({"kind":"topic","key":MARK})).1);
    out.push(f.route("POST", "/source-exclusions", &[], json!({"source":format!("{MARK}.example.com")})).1);
    out.push(f.route("POST", "/source-exclusions", &[], json!({"source":format!("https://u:{MARK}@example.com")})).1);
    out.push(f.route("POST", "/topics", &[], json!({"label":MARK,"guidance":MARK})).1);
    out.push(f.route("PATCH", "/topics/:id", &[("id","99999999-9999-4999-8999-999999999999")], json!({"label":MARK})).1);
    // Only the old refusals that quote a name back may carry it.
    for response in out.iter().filter(|r| r.to_string().contains(MARK)) {
        let message = response["error"].as_str().unwrap_or_default();
        assert!(message.starts_with("Unknown "), "{response}");
    }
    // No other port, no job, no activity row.
    let calls = f.calls.borrow();
    assert!(calls.iter().all(|(p, _, _, _)| p == "db"));
    for (_, _, resource, parameters) in calls.iter() {
        assert!(!resource.contains("activity") && !resource.contains("job"), "{resource}");
        // Typed text may only be written to the owner's own news tables.
        if parameters.to_string().contains(MARK) {
            assert!(resource.starts_with("app.news_"), "{resource}");
        }
    }
}

#[test]
fn a_database_failure_leaves_as_fixed_text() {
    let f = Fake::new();
    *f.db_failure.borrow_mut() = Some(format!("boom {MARK}"));
    let (status, body) = f.route("POST", "/source-exclusions", &[], json!({"source":"example.com"}));
    assert_eq!(status, 500);
    assert!(!body.to_string().contains(MARK));
}

#[test]
fn adding_a_source_uses_only_the_expected_ports_and_leaks_no_typed_text() {
    let f = Fake::new();
    let secret = format!("https://user:{MARK}@news.example.com/");
    let (_, refused) = f.route("POST", "/sources/preview", &[], json!({"input": secret}));
    assert!(!refused.to_string().contains(MARK), "{refused}");
    let rss = "<?xml version=\"1.0\"?><rss><channel><title>T</title><item><title>A headline here</title><link>https://news.example.com/a</link></item></channel></rss>";
    f.page(&format!("https://news.example.com/rss?q={MARK}"), 200, "application/rss+xml", rss);
    f.model_says(r#"{"allowed":true,"category":"news_publisher"}"#);
    let (_, shown) = f.route("POST", "/sources/preview", &[], json!({"input": format!("news.example.com/rss?q={MARK}")}));
    assert_eq!(shown["status"], "ok", "{shown}");
    let (_, saved) = f.route("POST", "/sources", &[], json!({"confirmationId": shown["confirmationId"]}));
    let calls = f.calls.borrow();
    for (port, _, resource, parameters) in calls.iter() {
        assert!(["db", "kv", "fetch", "ai", "context"].contains(&port.as_str()), "{port}");
        assert!(!resource.contains("activity") && !resource.contains("job"), "{resource}");
        // Only the owner's tables, the preview file and the public read may carry typed text.
        if parameters.to_string().contains(MARK) {
            assert!(resource.starts_with("app.news_") || ["news.source-previews", "public-web"].contains(&resource.as_str()), "{port} {resource}");
        }
    }
    // The saved source returns the person's own feed address to them, so only the preview is held clean.
    assert!(!shown.to_string().contains(MARK), "{shown}");
    assert_eq!(saved["source"]["feedUrl"], format!("https://news.example.com/rss?q={MARK}"));
}
