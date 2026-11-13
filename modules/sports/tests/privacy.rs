mod common;
use common::*;
use serde_json::{json, Value};

const MARK: &str = "PLANTED-MARKER-4f1c9b";

/// Every place a planted marker could leak from the guest other than the table and the saved
/// settings it is meant to reach.
fn leaks(f: &Fake, responses: &[Value]) -> Vec<String> {
    let mut found = vec![];
    for response in responses {
        if response.to_string().contains(MARK) {
            found.push(format!("response {response}"));
        }
    }
    for (port, operation, resource, parameters) in f.calls.borrow().iter() {
        let sink = !(port == "db" && operation == "query") && !(port == "kv" && operation == "preference.write");
        if sink && parameters.to_string().contains(MARK) {
            found.push(format!("{port}.{operation}.{resource}"));
        }
        if !["db", "kv", "context"].contains(&port.as_str()) {
            found.push(format!("unexpected port {port}"));
        }
    }
    found
}

#[test]
fn text_a_person_types_never_reaches_a_response_log_job_or_activity_row() {
    let f = Fake::new();
    // The marker rides in every free-text field the routes accept.
    let mut out = vec![];
    out.push(f.route("POST", "/follows", &[], json!({"competitionKey":format!("nba-{MARK}")})).1);
    out.push(f.route("POST", "/follows", &[], json!({"competitionKey":"nba","teamKey":MARK})).1);
    out.push(f.route("POST", "/follows/:id/team", &[("id","99999999-9999-4999-8999-999999999999")], json!({"sourceTeamId":MARK})).1);
    out.push(f.route("PUT", "/standings-preferences", &[], json!({"selectedCompetitionKeys":[MARK]})).1);
    out.push(f.route("PUT", "/standings-preferences", &[], json!({"lastViewed":{"competitionKey":"nba","viewKey":MARK,"viewLabel":MARK}})).1);
    // Only the old refusals that quote a name back, and the owner's own saved view, carry it.
    let quoted: Vec<&Value> = out.iter().filter(|r| r.to_string().contains(MARK)).collect();
    assert!(
        quoted.iter().all(|r| r["error"].as_str().is_some_and(|e| e.starts_with("Unknown ")) || r["lastViewed"]["viewKey"] == MARK),
        "{quoted:?}"
    );
    // Nothing else carries it: no job, no activity row, no other port.
    let calls = f.calls.borrow();
    assert!(calls.iter().all(|(p, _, _, _)| ["db", "kv", "context"].contains(&p.as_str())));
    assert!(calls.iter().all(|(p, o, r, _)| !(p == "jobs" || o.contains("activity") || r.contains("activity"))));
    drop(calls);
    // The saved view is the one place text lands, and it is returned only to its owner.
    f.as_actor(B);
    let (_, theirs) = f.route("GET", "/standings-preferences", &[], json!(null));
    let (_, list) = f.route("GET", "/follows", &[], json!(null));
    assert!(!theirs.to_string().contains(MARK) && !list.to_string().contains(MARK));
    assert!(leaks(&f, &[theirs, list]).is_empty());
}

#[test]
fn a_database_failure_leaves_as_fixed_text() {
    let f = Fake::new();
    *f.db_failure.borrow_mut() = Some(format!("boom {MARK}"));
    let (status, body) = f.route("POST", "/follows", &[], json!({"competitionKey":"nba"}));
    assert_eq!(status, 500);
    assert!(leaks(&f, &[body]).is_empty());
}
