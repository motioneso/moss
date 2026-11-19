//! The Needs you section on Today: live status joined from Tasks, and Accept and Dismiss that
//! only ever act through Tasks.
mod common;
use common::*;
use serde_json::{json, Value};

const DEFINITION: &str = "11111111-1111-4111-8111-111111111111";
const RUN: &str = "22222222-2222-4222-8222-222222222222";
const MINE: &str = "33333333-3333-4333-8333-333333333331";
const MINE2: &str = "33333333-3333-4333-8333-333333333332";
const THEIRS: &str = "33333333-3333-4333-8333-333333333339";

fn metadata() -> Value {
    json!({"version":1,"category":"needs_reply","sourceLabel":"Gmail","sourceHref":null,"cacheMessageId":"cache-1",
        "subjectSignature":"sig","computedAt":"2026-11-11T07:00:00.000Z","resurfaceReason":null})
}

fn task(id: &str, owner: &str, status: &str) -> Value {
    json!({"id":id,"ownerUserId":owner,"title":format!("Reply {id}"),"status":status,"dueAt":null,"priority":null,
        "description":"Sam asked.","source":"email","sourceRef":format!("acct:{id}"),
        "updatedAt":"2026-11-11T07:00:00.000Z","suggestionMetadata":metadata()})
}

fn row(id: &str) -> Value {
    json!({"taskId":id,"title":format!("Reply {id}"),"explanation":"Sam asked.","category":"needs_reply","status":"suggested",
        "primaryAction":{"kind":"reply","cacheMessageId":"cache-1"},"source":"email","sourceLabel":"Gmail",
        "sourceRef":format!("acct:{id}"),"sourceHref":null,"dueAt":null,"computedAt":"2026-11-11T07:00:00.000Z","resurfaceReason":null})
}

fn seeded(tasks: Vec<Value>, rows: Vec<Value>) -> Fake {
    let fake = Fake::new();
    fake.zone(A, "UTC");
    fake.zone(B, "UTC");
    fake.definitions.borrow_mut().push(json!({
        "id": DEFINITION, "owner_user_id": A, "title": "Morning", "briefing_type": "morning", "cadence": "daily",
        "schedule_metadata": {}, "enabled": true, "selected_tool_names": [],
        "last_run_at": null, "created_at": "2026-11-01T00:00:00.000Z", "updated_at": "2026-11-01T00:00:00.000Z"
    }));
    fake.seed_run(DEFINITION, A, RUN, "2026-11-11T07:00:00.000Z", json!({"structuredPayload":{"version":1,"actionRows":rows,"catchUp":null}}));
    *fake.tasks.borrow_mut() = Some(tasks);
    fake
}

fn today(fake: &Fake) -> Value {
    let (status, body) = fake.route("GET", "/today", &[], Value::Null);
    assert_eq!(status, 200, "{body}");
    body
}

fn act(fake: &Fake, id: &str, action: &str) -> (u16, Value) {
    fake.route("POST", "/today/rows/:task_id", &[("task_id", id)], json!({"action": action}))
}

fn statuses(body: &Value) -> Vec<(String, Value)> {
    body["rows"].as_array().unwrap().iter().map(|r| (r["taskId"].as_str().unwrap().to_owned(), r["status"].clone())).collect()
}

#[test]
fn accept_then_reload_shows_accepted_and_dismiss_then_reload_shows_dismissed() {
    let fake = seeded(vec![task(MINE, A, "suggested"), task(MINE2, A, "suggested")], vec![row(MINE), row(MINE2)]);
    assert_eq!(statuses(&today(&fake)), vec![(MINE.into(), json!("suggested")), (MINE2.into(), json!("suggested"))]);
    assert_eq!(act(&fake, MINE, "accept").0, 200);
    assert_eq!(act(&fake, MINE2, "dismiss").0, 200);
    assert_eq!(statuses(&today(&fake)), vec![(MINE.into(), json!("accepted")), (MINE2.into(), json!("dismissed"))]);
    let stored: Vec<_> = fake.tasks.borrow().clone().unwrap().iter().map(|t| t["status"].clone()).collect();
    assert_eq!(stored, vec![json!("todo"), json!("archived")]);
}

#[test]
fn the_status_comes_from_tasks_not_from_the_run() {
    // The run still says suggested. Tasks says the person finished it elsewhere.
    let fake = seeded(vec![task(MINE, A, "done")], vec![row(MINE)]);
    assert_eq!(statuses(&today(&fake)), vec![(MINE.into(), json!("accepted"))]);
}

#[test]
fn another_accounts_task_is_not_found_and_stays_suggested() {
    // The run names the other account's task, so a stored copy would let the call through.
    let fake = seeded(vec![task(THEIRS, B, "suggested")], vec![row(THEIRS)]);
    let (status, _) = act(&fake, THEIRS, "dismiss");
    assert_eq!(status, 404);
    assert_eq!(fake.tasks.borrow().clone().unwrap()[0]["status"], "suggested");
    assert!(fake.api_calls.borrow().iter().any(|c| c.2 == "setBriefingTaskStatus"), "Tasks was asked");
    assert!(today(&fake)["rows"].as_array().unwrap().is_empty(), "a row for another account's task is not shown");
}

#[test]
fn a_task_that_cannot_move_is_refused_and_left_alone() {
    let fake = seeded(vec![task(MINE, A, "done")], vec![row(MINE)]);
    assert_eq!(act(&fake, MINE, "accept").0, 409);
    assert_eq!(fake.tasks.borrow().clone().unwrap()[0]["status"], "done");
}

#[test]
fn bad_requests_write_nothing() {
    let fake = seeded(vec![task(MINE, A, "suggested")], vec![row(MINE)]);
    for body in [json!({"action":"delete"}), json!({}), json!({"action":"accept","status":"done"}), json!("accept")] {
        let (status, _) = fake.route("POST", "/today/rows/:task_id", &[("task_id", MINE)], body);
        assert_eq!(status, 400);
    }
    assert_eq!(act(&fake, "not-a-uuid", "accept").0, 404);
    assert!(fake.api_calls.borrow().iter().all(|c| c.2 != "setBriefingTaskStatus"));
}

#[test]
fn with_no_run_the_rows_come_from_suggested_tasks() {
    let fake = seeded(vec![task(MINE, A, "suggested"), task(MINE2, A, "todo")], vec![]);
    fake.runs.borrow_mut().clear();
    let body = today(&fake);
    assert_eq!(body["run"], Value::Null);
    assert_eq!(statuses(&body), vec![(MINE.into(), json!("suggested"))]);
}

#[test]
fn nothing_to_show_says_so_and_a_run_with_no_rows_says_caught_up() {
    let fake = seeded(vec![], vec![]);
    assert_eq!(today(&fake)["state"], "rows");
    fake.runs.borrow_mut().clear();
    assert_eq!(today(&fake)["state"], "none");
}

#[test]
fn without_tasks_the_rows_show_with_no_status() {
    let fake = seeded(vec![], vec![row(MINE)]);
    *fake.tasks.borrow_mut() = None;
    let body = today(&fake);
    assert_eq!(body["tasks"], false);
    assert_eq!(statuses(&body), vec![(MINE.into(), Value::Null)]);
}

#[test]
fn another_persons_run_is_never_read() {
    let fake = seeded(vec![task(MINE, A, "suggested")], vec![row(MINE)]);
    fake.as_actor(B);
    let body = today(&fake);
    assert_eq!(body["run"], Value::Null);
    assert!(body["rows"].as_array().unwrap().is_empty());
}
