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
