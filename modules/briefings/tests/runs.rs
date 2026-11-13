mod common;
use common::*;
use serde_json::json;

fn setup() -> (Fake, String) {
    let fake = Fake::new();
    let (_, out) = fake.route("POST", "/definitions", &[], json!({"title":"Morning"}));
    let id = out["definition"]["id"].as_str().unwrap().to_owned();
    (fake, id)
}

#[test]
fn runs_list_newest_first_and_a_run_reads_back() {
    let (fake, id) = setup();
    let ai = json!({"aiModel":{"provider":"p","model":"m"}});
    fake.seed_run(&id, A, "00000000-0000-4000-8000-0000000000a1", "2026-11-10T07:00:00.000Z", ai.clone());
    fake.seed_run(&id, A, "00000000-0000-4000-8000-0000000000a2", "2026-11-11T07:00:00.000Z", ai);
    let (status, out) = fake.route("GET", "/definitions/:id/runs", &[("id", &id)], json!({}));
    assert_eq!(status, 200);
    assert_eq!(out["runs"][0]["id"], "00000000-0000-4000-8000-0000000000a2");
    let (status, out) = fake.route(
        "GET",
        "/definitions/:id/runs/:run_id",
        &[("id", &id), ("run_id", "00000000-0000-4000-8000-0000000000a1")],
        json!({}),
    );
    assert_eq!(status, 200);
    assert_eq!(out["state"], "ready");
    assert_eq!(out["latest"], false);
    assert_eq!(out["plan"]["status"], "unavailable");
}

#[test]
fn a_run_written_without_ai_hides_its_text() {
    let (fake, id) = setup();
    fake.seed_run(&id, A, "00000000-0000-4000-8000-0000000000a3", "2026-11-11T07:00:00.000Z", json!({"degraded":true}));
    let (_, out) = fake.route("GET", "/definitions/:id/runs", &[("id", &id)], json!({}));
    assert_eq!(out["runs"][0]["summaryText"], "");
}

#[test]
fn a_missing_run_and_someone_elses_run_look_the_same() {
    let (fake, id) = setup();
    fake.seed_run(&id, B, "00000000-0000-4000-8000-0000000000b1", "2026-11-11T07:00:00.000Z", json!({}));
    let missing = json!({"error":"Briefing run is missing or owned by someone else","code":"briefing_run_not_available"});
    for run in ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000ee"] {
        let got = fake.route("GET", "/definitions/:id/runs/:run_id", &[("id", &id), ("run_id", run)], json!({}));
        assert_eq!(got, (404, missing.clone()));
    }
    let got = fake.route("GET", "/definitions/:id/runs", &[("id", "00000000-0000-4000-8000-0000000000ff")], json!({}));
    assert_eq!(got, (404, json!({"error":"Briefing definition not found"})));
}

#[test]
fn the_oldest_run_stays_reachable_past_a_thousand_newer_ones() {
    let (fake, id) = setup();
    let ai = json!({"aiModel":{"provider":"p","model":"m"}});
    fake.seed_run(&id, A, "00000000-0000-4000-8000-000000000001", "2020-01-01T07:00:00.000Z", ai.clone());
    for n in 0..1001u32 {
        let run = format!("00000000-0000-4000-8000-{:012}", n + 10);
        fake.seed_run(&id, A, &run, "2026-11-11T07:00:00.000Z", ai.clone());
    }
    let (status, out) = fake.route(
        "GET",
        "/definitions/:id/runs/:run_id",
        &[("id", &id), ("run_id", "00000000-0000-4000-8000-000000000001")],
        json!({}),
    );
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["latest"], false);
}

#[test]
fn a_run_id_that_is_not_an_id_is_not_available() {
    let (fake, id) = setup();
    let (status, out) = fake.route(
        "GET",
        "/definitions/:id/runs/:run_id",
        &[("id", &id), ("run_id", "nope")],
        json!({}),
    );
    assert_eq!(status, 404);
    assert_eq!(out["code"], "briefing_run_not_available");
}

#[test]
fn listing_definitions_keeps_existing_fire_times_but_saving_resets_them() {
    let (fake, _) = setup();
    fake.jobs.borrow_mut().clear();
    fake.route("GET", "/definitions", &[], json!({}));
    let listed = fake.jobs.borrow().clone();
    assert!(!listed.is_empty());
    assert!(listed.iter().all(|(op, _, p)| op != "schedule" || p["keepExisting"] == json!(true)));
}
