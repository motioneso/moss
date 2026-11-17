mod common;
use common::*;
use serde_json::json;

fn create(fake: &Fake, body: serde_json::Value) -> serde_json::Value {
    let (status, out) = fake.route("POST", "/definitions", &[], body);
    assert_eq!(status, 201, "{out}");
    out["definition"].clone()
}

#[test]
fn create_fills_defaults_and_schedules_in_the_owner_zone() {
    let fake = Fake::new();
    fake.zone(A, "Pacific/Auckland");
    let made = create(&fake, json!({"title":"  Morning  ","briefingType":"morning","cadence":"daily"}));
    assert_eq!(made["title"], "Morning");
    assert_eq!(made["scheduleMetadata"]["timezone"], "Pacific/Auckland");
    assert_eq!(made["scheduleMetadata"]["targetTime"], "07:00");
    assert_eq!(made["enabled"], true);
    assert!(made["selectedToolNames"].as_array().is_some_and(|names| !names.is_empty()));
    let jobs = fake.jobs.borrow();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].0, "schedule");
    assert_eq!(jobs[0].1, "briefings-run");
    assert_eq!(jobs[0].2["cron"], "0 7 * * *");
    assert_eq!(jobs[0].2["timezone"], "Pacific/Auckland");
    assert_eq!(jobs[0].2["key"], made["id"]);
    assert_eq!(jobs[0].2["params"]["run-kind"], "scheduled");
}

#[test]
fn a_manual_definition_registers_nothing() {
    let fake = Fake::new();
    create(&fake, json!({"title":"Ad hoc"}));
    let jobs = fake.jobs.borrow();
    // The keyed call returns the id, then the schedule is removed.
    assert_eq!(jobs.iter().map(|j| j.0.as_str()).collect::<Vec<_>>(), ["schedule", "unschedule"]);
}

#[test]
fn switching_a_definition_off_removes_its_schedule() {
    let fake = Fake::new();
    let made = create(&fake, json!({"title":"Daily","cadence":"daily"}));
    fake.jobs.borrow_mut().clear();
    let id = made["id"].as_str().unwrap().to_owned();
    let (status, _) = fake.route("PATCH", "/definitions/:id", &[("id", &id)], json!({"enabled":false}));
    assert_eq!(status, 200);
    let jobs = fake.jobs.borrow();
    assert_eq!(jobs.last().unwrap().0, "unschedule");
    assert_eq!(jobs.last().unwrap().2["id"], format!("job-{id}"));
}

#[test]
fn weekly_cron_uses_the_day_of_week() {
    let fake = Fake::new();
    fake.zone(A, "Europe/London");
    create(&fake, json!({"title":"Review","briefingType":"weekly_review","cadence":"weekly"}));
    assert_eq!(fake.jobs.borrow()[0].2["cron"], "0 9 * * 0");
}

#[test]
fn validation_messages_match_the_old_app() {
    let fake = Fake::new();
    let bad = |body| fake.route("POST", "/definitions", &[], body);
    assert_eq!(bad(json!({"title":"   "})), (400, json!({"error":"title must not be empty"})));
    assert_eq!(
        bad(json!({"title":"x","selectedToolNames":["nope"]})),
        (400, json!({"error":"Briefings can only select declared read-risk assistant tools"}))
    );
    assert_eq!(
        bad(json!({"title":"x","scheduleMetadata":{"timezone":"Mars/Base"}})),
        (400, json!({"error":"invalid timezone"}))
    );
    assert_eq!(
        bad(json!({"title":"x","cadence":"weekly","scheduleMetadata":{"time":"07:00"}})),
        (400, json!({"error":"dayOfWeek required for weekly schedules"}))
    );
    assert_eq!(bad(json!({})).0, 400);
}

#[test]
fn list_is_newest_first_and_heals_only_owned_schedules() {
    let fake = Fake::new();
    fake.zone(A, "UTC");
    let mine = create(&fake, json!({"title":"Mine","cadence":"daily"}));
    fake.as_actor(B);
    let theirs = create(&fake, json!({"title":"Theirs","cadence":"daily"}));
    fake.share(theirs["id"].as_str().unwrap(), A, "view");
    fake.as_actor(A);
    fake.jobs.borrow_mut().clear();
    let (status, out) = fake.route("GET", "/definitions", &[], json!({}));
    assert_eq!(status, 200);
    assert_eq!(out["definitions"].as_array().unwrap().len(), 2);
    assert_eq!(out["externalSources"], json!([]));
    let jobs = fake.jobs.borrow();
    assert_eq!(jobs.len(), 1, "only the caller's own definition is scheduled");
    assert_eq!(jobs[0].2["key"], mine["id"]);
}

#[test]
fn unknown_route_and_missing_definition() {
    let fake = Fake::new();
    assert_eq!(fake.route("GET", "/nothing", &[], json!({})), (404, json!({"message":"Route not found"})));
    let (status, out) = fake.route(
        "PATCH",
        "/definitions/:id",
        &[("id", "00000000-0000-4000-8000-0000000000ff")],
        json!({"title":"x"}),
    );
    assert_eq!((status, out), (404, json!({"error":"Briefing definition not found"})));
}
