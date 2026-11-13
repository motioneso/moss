mod common;
use common::*;
use serde_json::json;

const MARK: &str = "PRIVATE-MARK-7f3a";

fn owned_definition(fake: &Fake) -> String {
    let (_, out) = fake.route("POST", "/definitions", &[], json!({"title":"Private plan","cadence":"daily"}));
    out["definition"]["id"].as_str().unwrap().to_owned()
}

#[test]
fn a_stranger_sees_and_changes_nothing() {
    let fake = Fake::new();
    let id = owned_definition(&fake);
    fake.as_actor(B);
    let (_, list) = fake.route("GET", "/definitions", &[], json!({}));
    assert_eq!(list["definitions"], json!([]));
    let got = fake.route("PATCH", "/definitions/:id", &[("id", &id)], json!({"title":"Mine now"}));
    assert_eq!(got, (404, json!({"error":"Briefing definition not found"})));
    assert_eq!(fake.route("GET", "/definitions/:id/runs", &[("id", &id)], json!({})).0, 404);
    assert_eq!(fake.definitions.borrow()[0]["title"], "Private plan");
}

#[test]
fn view_access_reads_but_cannot_edit_and_never_sees_runs() {
    let fake = Fake::new();
    let id = owned_definition(&fake);
    fake.seed_run(&id, A, "00000000-0000-4000-8000-0000000000a1", "2026-11-11T07:00:00.000Z", json!({}));
    fake.share(&id, B, "view");
    fake.as_actor(B);
    let (_, list) = fake.route("GET", "/definitions", &[], json!({}));
    assert_eq!(list["definitions"].as_array().unwrap().len(), 1);
    assert_eq!(fake.route("PATCH", "/definitions/:id", &[("id", &id)], json!({"title":"x"})).0, 404);
    let (status, runs) = fake.route("GET", "/definitions/:id/runs", &[("id", &id)], json!({}));
    assert_eq!((status, runs["runs"].clone()), (200, json!([])));
    assert_eq!(fake.route("GET", "/definitions/:id/runs/:run_id", &[("id", &id), ("run_id", "00000000-0000-4000-8000-0000000000a1")], json!({})).0, 404);
}

#[test]
fn manage_access_edits_but_never_moves_the_owner_schedule() {
    let fake = Fake::new();
    fake.zone(A, "Europe/London");
    fake.zone(B, "Asia/Tokyo");
    let id = owned_definition(&fake);
    fake.share(&id, B, "manage");
    fake.as_actor(B);
    fake.jobs.borrow_mut().clear();
    let got = fake.route("PATCH", "/definitions/:id", &[("id", &id)], json!({"title":"Renamed","enabled":false}));
    assert_eq!(got.0, 200);
    assert_eq!(fake.definitions.borrow()[0]["title"], "Renamed");
    assert!(fake.jobs.borrow().is_empty(), "a manager must not touch the owner's schedule");
}

#[test]
fn briefing_text_never_reaches_job_calls() {
    let fake = Fake::new();
    fake.zone(A, "UTC");
    let (_, out) = fake.route(
        "POST",
        "/definitions",
        &[],
        json!({"title":"Secret title text","cadence":"daily","scheduleMetadata":{"targetTime":"06:00"}}),
    );
    let id = out["definition"]["id"].as_str().unwrap().to_owned();
    fake.seed_run(&id, A, "00000000-0000-4000-8000-0000000000a1", "2026-11-11T07:00:00.000Z", json!({}));
    fake.route("GET", "/definitions", &[], json!({}));
    fake.route("PATCH", "/definitions/:id", &[("id", &id)], json!({"cadence":"weekly","scheduleMetadata":{"dayOfWeek":2}}));
    let jobs = serde_json::to_string(&*fake.jobs.borrow()).unwrap();
    assert!(!jobs.contains("Secret title text"));
    assert!(!jobs.contains("two meetings"));
    for (_, queue, params) in fake.jobs.borrow().iter() {
        assert_eq!(queue, "briefings-run");
        if let Some(inner) = params.get("params") {
            let mut keys: Vec<_> = inner.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            assert_eq!(keys, ["briefing-type", "definition-id", "run-kind"]);
        }
    }
}

#[test]
fn a_host_failure_returns_the_fixed_message() {
    // A failing query carrying private text must reach the caller only as the fixed message.
    let fake = Fake::new();
    *fake.db_failure.borrow_mut() = Some(format!("db error near {MARK}"));
    let (status, body) = fake.route("GET", "/definitions", &[], json!({}));
    assert_eq!(status, 500);
    assert_eq!(body, json!({"message":"Internal server error"}));
    assert!(!body.to_string().contains(MARK));
}

#[test]
fn a_failed_zone_lookup_does_not_fail_the_save() {
    let fake = Fake::new();
    let (status, _) = fake.route("POST", "/definitions", &[], json!({"title":"No zone known"}));
    assert_eq!(status, 201);
}
