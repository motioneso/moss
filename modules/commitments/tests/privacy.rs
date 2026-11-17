mod common;
use common::Fake;
use serde_json::json;

const MARK: &str = "PLANTED-MARKER-7d2e41";

#[test]
fn private_text_reaches_no_host_call_beyond_the_candidate_tables() {
    let f = Fake::new();
    let id = f.seed("app.commitment_candidates", common::A, json!({
        "candidate_signature":"sig","kind":"promise","title":MARK,"due_local_date":null,
        "counterparty_label":MARK,"status":"pending_review","confidence":"high","suggested_handling":null,
        "resolution_ref":null,"suppressed_by":null,"source_count":1,
        "first_seen_at":"2026-11-09T10:00:00.000Z","last_seen_at":"2026-11-09T10:00:00.000Z",
        "snoozed_until":null,"expires_at":null,"updated_at":"2026-11-09T10:00:00.000Z",
        "proposed_actions":[],"why_lines":[MARK],"stale":false}));
    f.seed("app.commitment_candidate_sources", common::A, json!({
        "candidate_id": id, "source_kind":"email","source_ref":"t","source_version":0,
        "evidence_excerpt":MARK,"occurred_at":null}));
    f.route("GET", "/candidates", &[], json!(null));
    f.route("GET", "/candidates/:id", &[("id", &id)], json!(null));
    f.route("PATCH", "/candidates/:id/status", &[("id", &id)], json!({"status":"snoozed"}));
    f.route("POST", "/candidates/:id/resolve", &[("id", &id)], json!({"resolutionRef":MARK}));
    // Every host call is a database query on the two candidate tables or a clock read. There
    // are no job, log, model or network calls in this package at all.
    for (port, _, resource, parameters) in f.calls.borrow().iter() {
        assert!(port == "db" || port == "context", "unexpected port {port}");
        if port == "db" {
            assert!(["app.commitment_candidates", "app.commitment_candidate_sources"].contains(&resource.as_str()), "{resource}");
        }
        // The resolution text the person sent is never written anywhere.
        assert!(!parameters.to_string().contains("resolutionRef"));
    }
    assert!(!f.calls.borrow().iter().any(|(_, _, _, p)| p.to_string().contains(MARK) && p["kind"] != "select"));
    // A host failure must not echo the marker back.
    *f.db_failure.borrow_mut() = Some(format!("failed on {MARK}"));
    let (status, body) = f.route("GET", "/candidates", &[], json!(null));
    assert_eq!(status, 500);
    assert!(!body.to_string().contains(MARK), "{body}");
}
