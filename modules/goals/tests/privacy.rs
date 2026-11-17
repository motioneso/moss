mod common;
use common::Fake;
use serde_json::json;

const MARK: &str = "PLANTED-MARKER-7d2e41";

#[test]
fn private_text_reaches_no_host_call_beyond_the_goal_tables() {
    let f = Fake::new();
    let (_, goal) = f.route("POST", "/goals", &[], json!({"title":MARK,"desiredOutcome":MARK}));
    let id = goal["id"].as_str().unwrap().to_owned();
    f.route("POST", "/goals/:id/evidence", &[("id", &id)],
        json!({"evidenceKind":"progress","sourceKind":"manual","sourceLabel":MARK,"summary":MARK}));
    f.route("PATCH", "/goals/:id", &[("id", &id)], json!({"lastProgressSummary":MARK}));
    // Every host call is a database query on the two goal tables or a clock read. There are no
    // job, log, model or network calls in this package at all.
    for (port, _, resource, _) in f.calls.borrow().iter() {
        assert!(port == "db" || port == "context", "unexpected port {port}");
        if port == "db" {
            assert!(["app.moss_goals", "app.moss_goal_evidence"].contains(&resource.as_str()), "{resource}");
        }
    }
    // A host failure must not echo the marker back.
    *f.db_failure.borrow_mut() = Some(format!("failed on {MARK}"));
    let (status, body) = f.route("GET", "/goals", &[], json!(null));
    assert_eq!(status, 500);
    assert!(!body.to_string().contains(MARK), "{body}");
}
