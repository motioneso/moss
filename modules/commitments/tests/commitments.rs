mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const CLOCK: &str = "2026-11-10T00:00:00.000Z";

/// A candidate row as the extraction job would save it, with the fields the routes read.
fn candidate(f: &Fake, owner: &str, title: &str, status: &str, seen: &str) -> String {
    f.seed(
        "app.commitment_candidates",
        owner,
        json!({
            "candidate_signature": format!("sig-{title}-{status}-{seen}"), "kind": "promise", "title": title,
            "due_local_date": "2026-11-20", "counterparty_label": null, "status": status,
            "confidence": "high", "suggested_handling": "create_task", "resolution_ref": null,
            "suppressed_by": null, "source_count": 1, "first_seen_at": seen, "last_seen_at": seen,
            "snoozed_until": null, "expires_at": null, "updated_at": seen,
            "counterparty_person_id": null, "counterparty_address": null, "proposed_actions": [],
            "why_lines": [], "thread_ref": null, "last_judged_external_id": null, "stale": false
        }),
    )
}
fn set(f: &Fake, id: &str, field: &str, value: Value) {
    for row in f.tables.borrow_mut().get_mut("app.commitment_candidates").unwrap() {
        if row["id"] == id {
            row[field] = value.clone();
        }
    }
}
fn statuses(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|c| c["status"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn list_read_and_change_status() {
    let f = Fake::new();
    let a = candidate(&f, A, "Send the report", "pending_review", "2026-11-09T10:00:00.000Z");
    candidate(&f, A, "Call the plumber", "accepted", "2026-11-09T11:00:00.000Z");
    let (status, all) = f.route("GET", "/candidates", &[], json!(null));
    assert_eq!(status, 200);
    // Newest first.
    assert_eq!(all[0]["title"], "Call the plumber");
    assert_eq!(all[0]["hasResolutionRef"], false);
    assert!(all[0].get("resolutionRef").is_none());
    let (_, accepted) = f.route_query("GET", "/candidates", &[], &[("status", "accepted")], json!(null));
    assert_eq!(accepted.as_array().unwrap().len(), 1);

    f.route("POST", "/candidates/:id/suppress", &[("id", &a)], json!({"suppressedBy":"nope"}));
    set(&f, &a, "source_count", json!(2));
    f.seed("app.commitment_candidate_sources", A, json!({
        "candidate_id": a, "source_kind": "email", "source_ref": "t1", "source_version": 0,
        "evidence_excerpt": "I will send it", "occurred_at": null }));
    let (status, detail) = f.route("GET", "/candidates/:id", &[("id", &a)], json!(null));
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["evidence"][0]["evidenceExcerpt"], "I will send it");

    let (status, snoozed) = f.route("PATCH", "/candidates/:id/status", &[("id", &a)],
        json!({"status":"snoozed","snoozedUntil":"2030-01-01T00:00:00.000Z"}));
    assert_eq!(status, 200, "{snoozed}");
    assert_eq!(snoozed["status"], "snoozed");
    assert_eq!(snoozed["snoozedUntil"], "2030-01-01T00:00:00.000Z");
    // A change without a date clears the old snooze date.
    let (_, rejected) = f.route("PATCH", "/candidates/:id/status", &[("id", &a)], json!({"status":"rejected"}));
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["snoozedUntil"], Value::Null);
}

#[test]
fn a_snooze_that_has_ended_counts_as_pending_review() {
    let f = Fake::new();
    let ended = candidate(&f, A, "Ended", "snoozed", "2026-11-09T10:00:00.000Z");
    set(&f, &ended, "snoozed_until", json!("2026-11-09T12:00:00.000Z"));
    let live = candidate(&f, A, "Still snoozed", "snoozed", "2026-11-09T09:00:00.000Z");
    set(&f, &live, "snoozed_until", json!("2026-11-12T12:00:00.000Z"));
    candidate(&f, A, "Waiting", "pending_review", "2026-11-09T08:00:00.000Z");
    assert!(f.clock.get() > 0, "{CLOCK}");
    f.clock.set(chrono::DateTime::parse_from_rfc3339(CLOCK).unwrap().timestamp_millis());
    let (_, pending) = f.route_query("GET", "/candidates", &[], &[("status", "pending_review")], json!(null));
    assert_eq!(statuses(&pending), ["pending_review", "pending_review"]);
    assert!(pending.as_array().unwrap().iter().all(|c| c["snoozedUntil"].is_null()));
    let (_, snoozed) = f.route_query("GET", "/candidates", &[], &[("status", "snoozed")], json!(null));
    assert_eq!(snoozed.as_array().unwrap().len(), 1);
    assert_eq!(snoozed[0]["title"], "Still snoozed");
}

#[test]
fn a_resolved_candidate_stays_resolved() {
    let f = Fake::new();
    let id = candidate(&f, A, "Resolved", "accepted", "2026-11-09T10:00:00.000Z");
    set(&f, &id, "resolution_ref", json!("task:123"));
    let (_, read) = f.route("GET", "/candidates/:id", &[("id", &id)], json!(null));
    assert_eq!(read["hasResolutionRef"], true);
    // Changing the status keeps the reference.
    let (_, snoozed) = f.route("PATCH", "/candidates/:id/status", &[("id", &id)], json!({"status":"snoozed"}));
    assert_eq!(snoozed["hasResolutionRef"], true);
    // Suppressing keeps it too.
    let driver = candidate(&f, A, "Not owed", "explicit_non_action", "2026-11-09T09:00:00.000Z");
    let (status, suppressed) = f.route("POST", "/candidates/:id/suppress", &[("id", &id)], json!({"suppressedBy":driver}));
    assert_eq!(status, 200, "{suppressed}");
    assert_eq!(suppressed["status"], "explicit_non_action");
    assert_eq!(suppressed["hasResolutionRef"], true);
    // The reference itself is stored, never sent.
    assert_eq!(f.rows("app.commitment_candidates")[0]["resolution_ref"], "task:123");
    assert!(!suppressed.to_string().contains("task:123"));
}

#[test]
fn resolve_is_refused_and_saves_nothing() {
    let f = Fake::new();
    let id = candidate(&f, A, "Open", "pending_review", "2026-11-09T10:00:00.000Z");
    let (status, body) = f.route("POST", "/candidates/:id/resolve", &[("id", &id)], json!({"resolutionRef":"task:9"}));
    assert_eq!((status, body), (503, json!({"error":"Resolution verifier unavailable"})));
    assert_eq!(f.rows("app.commitment_candidates")[0]["resolution_ref"], Value::Null);
    assert_eq!(f.route("POST", "/candidates/:id/resolve", &[("id", &id)], json!({})).0, 400);
    assert_eq!(f.route("POST", "/candidates/:id/resolve", &[("id", &id)], json!({"resolutionRef":""})).0, 400);
}

#[test]
fn suppress_needs_a_candidate_marked_not_owed() {
    let f = Fake::new();
    let id = candidate(&f, A, "Target", "pending_review", "2026-11-09T10:00:00.000Z");
    let open = candidate(&f, A, "Open", "pending_review", "2026-11-09T09:00:00.000Z");
    let missing = "99999999-9999-4999-8999-999999999999";
    assert_eq!(f.route("POST", "/candidates/:id/suppress", &[("id", &id)], json!({"suppressedBy":missing})),
        (404, json!({"error":"Suppressor not found"})));
    assert_eq!(f.route("POST", "/candidates/:id/suppress", &[("id", &id)], json!({"suppressedBy":open})),
        (422, json!({"error":"Suppressor must be explicit_non_action"})));
    assert_eq!(f.rows("app.commitment_candidates")[0]["status"], "pending_review");
    assert_eq!(f.route("POST", "/candidates/:id/suppress", &[("id", &id)], json!({})).0, 400);
}

#[test]
fn validation_and_missing_candidates_match_the_old_answers() {
    let f = Fake::new();
    let id = candidate(&f, A, "t", "pending_review", "2026-11-09T10:00:00.000Z");
    let patch = |body: Value| f.route("PATCH", "/candidates/:id/status", &[("id", &id)], body);
    assert_eq!(patch(json!({})).1, json!({"error":"body must have required property 'status'"}));
    assert_eq!(patch(json!({"status":"expired"})).0, 400);
    assert_eq!(patch(json!({"status":"accepted","snoozedUntil":"soon"})).0, 400);
    let (status, body) = f.route_query("GET", "/candidates", &[], &[("status", "bogus")], json!(null));
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().starts_with("querystring/status must be equal to constant"));
    let missing = "99999999-9999-4999-8999-999999999999";
    assert_eq!(f.route("GET", "/candidates/:id", &[("id", missing)], json!(null)),
        (404, json!({"error":"Not found"})));
    assert_eq!(f.route("PATCH", "/candidates/:id/status", &[("id", missing)], json!({"status":"accepted"})).0, 404);
    assert_eq!(f.route("GET", "/candidates/:id", &[("id", "nope")], json!(null)).0, 400);
    assert_eq!(f.route("GET", "/nope", &[], json!(null)).0, 404);
}

#[test]
fn a_second_person_sees_and_changes_none_of_it() {
    let f = Fake::new();
    let id = candidate(&f, A, "Private", "pending_review", "2026-11-09T10:00:00.000Z");
    f.as_actor(B);
    assert_eq!(f.route("GET", "/candidates", &[], json!(null)).1, json!([]));
    assert_eq!(f.route("GET", "/candidates/:id", &[("id", &id)], json!(null)).0, 404);
    assert_eq!(f.route("PATCH", "/candidates/:id/status", &[("id", &id)], json!({"status":"rejected"})).0, 404);
    f.as_actor(A);
    assert_eq!(f.route("GET", "/candidates/:id", &[("id", &id)], json!(null)).1["status"], "pending_review");
}
