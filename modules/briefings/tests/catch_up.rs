//! Catch-up Add task, Dismiss and Undo on Today.
mod common;
use common::*;
use serde_json::{json, Value};

const RUN: &str = "00000000-0000-4000-8000-0000000000a1";

fn setup() -> Fake {
    let fake = Fake::new();
    let (_, out) = fake.route("POST", "/definitions", &[], json!({"title":"Morning"}));
    let id = out["definition"]["id"].as_str().unwrap().to_owned();
    let metadata = json!({"structuredPayload": {"version": 1, "actionRows": [], "catchUp": {
        "itemCount": 2,
        "entries": [
            {"id": "catch-1", "senderName": "Sam", "summary": "Contract question"},
            {"id": "catch-2", "senderName": "Priya", "summary": "Invoice"}
        ]
    }}});
    fake.seed_run(&id, A, RUN, "2026-11-11T07:00:00.000Z", metadata);
    *fake.tasks.borrow_mut() = Some(vec![]);
    fake
}

fn post(fake: &Fake, run: &str, item: &str, action: &str, body: Value) -> (u16, Value) {
    fake.route(
        "POST",
        &format!("/today/runs/:run_id/catch-up/:item_id/{action}"),
        &[("run_id", run), ("item_id", item)],
        body,
    )
}

#[test]
fn add_creates_a_follow_up_and_records_more_like_this_with_the_run() {
    let fake = setup();
    let (status, out) = post(&fake, RUN, "catch-1", "add", json!({}));
    assert_eq!(status, 200);
    assert_eq!(out["status"], "added");
    assert_eq!(fake.open_tasks(A), 1);
    assert_eq!(fake.tasks.borrow().as_ref().unwrap()[0]["title"], "Follow up with Sam");
    assert_eq!(fake.tasks.borrow().as_ref().unwrap()[0]["description"], "Contract question");
    assert_eq!(fake.ratings.borrow().len(), 1);
    assert_eq!(fake.ratings.borrow()[0].2, "more_like_this");
}

#[test]
fn a_failed_rating_then_a_retry_leaves_exactly_one_open_task() {
    let fake = setup();
    fake.record_fails.set(true);
    let (status, out) = post(&fake, RUN, "catch-1", "add", json!({}));
    assert_eq!((status, out["error"].as_str()), (500, Some("That did not save. Try again.")));
    assert!(out.get("taskId").is_none());
    assert_eq!(fake.open_tasks(A), 0);
    fake.record_fails.set(false);
    assert_eq!(post(&fake, RUN, "catch-1", "add", json!({})).0, 200);
    assert_eq!(fake.open_tasks(A), 1);
}

#[test]
fn when_the_archive_also_fails_the_task_id_comes_back_and_a_retry_reuses_it() {
    let fake = setup();
    fake.record_fails.set(true);
    fake.archive_fails.set(true);
    let (status, out) = post(&fake, RUN, "catch-1", "add", json!({}));
    assert_eq!(status, 500);
    let stray = out["taskId"].as_str().unwrap().to_owned();
    assert_eq!(fake.open_tasks(A), 1);
    fake.record_fails.set(false);
    fake.archive_fails.set(false);
    let (status, out) = post(&fake, RUN, "catch-1", "add", json!({"strayTaskId": stray}));
    assert_eq!((status, out["taskId"].as_str()), (200, Some(stray.as_str())));
    assert_eq!(fake.open_tasks(A), 1);
}

#[test]
fn dismiss_archives_the_stray_task_then_records_dismiss() {
    let fake = setup();
    fake.record_fails.set(true);
    fake.archive_fails.set(true);
    let stray = post(&fake, RUN, "catch-1", "add", json!({})).1["taskId"].as_str().unwrap().to_owned();
    fake.record_fails.set(false);
    fake.archive_fails.set(false);
    let (status, out) = post(&fake, RUN, "catch-1", "dismiss", json!({"strayTaskId": stray}));
    assert_eq!((status, out["status"].as_str()), (200, Some("dismissed")));
    assert_eq!(fake.open_tasks(A), 0);
    assert_eq!(fake.ratings.borrow()[0].2, "dismiss");
}

#[test]
fn undo_takes_back_the_rating_and_archives_the_task() {
    let fake = setup();
    let added = post(&fake, RUN, "catch-1", "add", json!({})).1;
    let body = json!({"feedbackId": added["feedbackId"], "taskId": added["taskId"]});
    assert_eq!(post(&fake, RUN, "catch-1", "undo", body).0, 200);
    assert_eq!(fake.open_tasks(A), 0);
    assert!(fake.ratings.borrow().is_empty());
}

#[test]
fn another_accounts_run_or_item_returns_404_and_creates_nothing() {
    let fake = setup();
    fake.as_actor(B);
    for action in ["add", "dismiss", "undo"] {
        assert_eq!(post(&fake, RUN, "catch-1", action, json!({"feedbackId": "x"})).0, 404);
    }
    assert!(fake.tasks.borrow().as_ref().unwrap().is_empty() && fake.ratings.borrow().is_empty());
    fake.as_actor(A);
    for item in ["catch-3", "../x"] {
        assert_eq!(post(&fake, RUN, item, "add", json!({})).0, 404);
    }
    assert_eq!(post(&fake, "not-a-run", "catch-1", "add", json!({})).0, 404);
    assert!(fake.tasks.borrow().as_ref().unwrap().is_empty() && fake.ratings.borrow().is_empty());
}

#[test]
fn an_already_handled_entry_can_still_be_undone() {
    // The raw stored entry is checked, not the reader's view that hides handled entries.
    let fake = setup();
    let added = post(&fake, RUN, "catch-1", "add", json!({})).1;
    let body = json!({"feedbackId": added["feedbackId"], "taskId": added["taskId"]});
    assert_eq!(post(&fake, RUN, "catch-1", "undo", body).0, 200);
}

#[test]
fn undo_with_another_accounts_feedback_or_task_id_changes_nothing() {
    let fake = setup();
    let mine = post(&fake, RUN, "catch-1", "add", json!({})).1;
    fake.as_actor(B);
    fake.seed_run("d", B, "00000000-0000-4000-8000-0000000000b1", "2026-11-11T07:00:00.000Z", json!({"structuredPayload": {"catchUp": {"entries": [{"id": "catch-1", "senderName": "Z", "summary": "s"}]}}}));
    let theirs = post(&fake, "00000000-0000-4000-8000-0000000000b1", "catch-1", "add", json!({})).1;
    // B names A's rating and task on B's own run.
    let run_b = "00000000-0000-4000-8000-0000000000b1";
    let (status, _) = post(&fake, run_b, "catch-1", "undo", json!({"feedbackId": mine["feedbackId"]}));
    assert_eq!(status, 500);
    let (status, _) = post(&fake, run_b, "catch-1", "undo", json!({"taskId": mine["taskId"]}));
    assert_eq!(status, 404);
    // B's own rating with A's task: the rating must not be undone either.
    let (status, _) = post(&fake, run_b, "catch-1", "undo", json!({"feedbackId": theirs["feedbackId"], "taskId": mine["taskId"]}));
    assert_eq!(status, 404);
    assert_eq!(fake.ratings.borrow().len(), 2);
    assert_eq!(fake.open_tasks(A), 1);
    assert_eq!(fake.open_tasks(B), 1);
}
