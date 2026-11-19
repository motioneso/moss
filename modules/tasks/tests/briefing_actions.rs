//! Public `setBriefingTaskStatus`, `createFollowUpTask` and `listBriefingTasks` with ids.
//! The fake store applies the host's own-rows filter, so reading or writing without the
//! caller's scope returns another account's task and fails these tests.
use moss_module_sdk::query::{Compare, Filter, Kind, Query};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::sync::Mutex;

const STAMP: &str = "2026-11-19T00:00:00.000Z";
const MINE: &str = "11111111-1111-4111-8111-111111111111";
const THEIRS: &str = "22222222-2222-4222-8222-222222222222";

struct Store {
    me: &'static str,
    rows: Mutex<Vec<Value>>,
}

fn task(id: &str, owner: &str, status: &str) -> Value {
    json!({"id":id,"owner_user_id":owner,"list_id":"l","parent_task_id":null,
        "title":format!("Task {id}"),"description":"Body","status":status,"priority":null,
        "position":0,"due_at":null,"do_at":null,"effort":null,"source":"manual","source_ref":null,
        "completed_at":if status == "done" { json!(STAMP) } else { Value::Null },
        "created_at":STAMP,"updated_at":STAMP,"suggestion_metadata":null,"recurrence":null,
        "recurrence_series_id":null})
}

impl Store {
    fn new(rows: Vec<Value>) -> Self {
        Store {
            me: "alice",
            rows: Mutex::new(rows),
        }
    }
    fn matches(&self, f: &Filter, row: &Value) -> bool {
        match f {
            Filter::All => true,
            Filter::Owned => row["owner_user_id"] == self.me,
            Filter::And { filters } => filters.iter().all(|f| self.matches(f, row)),
            Filter::Compare {
                column,
                op: Compare::Eq,
                value,
            } => &row[column.as_str()] == value,
            Filter::In { column, values } => values.contains(&row[column.as_str()]),
            other => panic!("unexpected filter {other:?}"),
        }
    }
    fn status_of(&self, id: &str) -> String {
        let rows = self.rows.lock().unwrap();
        rows.iter().find(|r| r["id"] == id).unwrap()["status"]
            .as_str()
            .unwrap()
            .into()
    }
}

impl Host for Store {
    fn call(&self, port: &str, _: &str, table: &str, query: Value) -> Result<Value> {
        if port == "context" {
            return Ok(json!({"actorUserId":self.me,"now":STAMP}));
        }
        if table == "app.task_activity" {
            return Ok(json!([{"id":"a","task_id":"t","actor_user_id":self.me,
                "activity_type":"status_changed","body":null,"created_at":STAMP}]));
        }
        if table == "app.task_lists" {
            return Ok(
                json!([{"id":"l","owner_user_id":self.me,"name":"Personal","position":0,
                "created_at":STAMP,"updated_at":STAMP}]),
            );
        }
        assert_eq!(table, "app.tasks");
        let q: Query = serde_json::from_value(query).unwrap();
        let mut rows = self.rows.lock().unwrap();
        match q.kind {
            Kind::Insert => {
                let mut row = task(
                    &format!("33333333-3333-4333-8333-{:012}", rows.len()),
                    self.me,
                    "todo",
                );
                for (k, v) in &q.values {
                    row[k] = v.clone();
                }
                rows.push(row.clone());
                Ok(json!([row]))
            }
            Kind::Update => {
                let mut out = vec![];
                for row in rows.iter_mut() {
                    if self.matches(&q.filter, row) {
                        for (k, v) in &q.values {
                            row[k] = v.clone();
                        }
                        out.push(row.clone());
                    }
                }
                Ok(json!(out))
            }
            _ => Ok(json!(rows
                .iter()
                .filter(|r| self.matches(&q.filter, r))
                .collect::<Vec<_>>())),
        }
    }
}

fn api(host: &Store, name: &str, parameters: Value) -> moss_module_sdk::Result<Value> {
    let request = json!({"name":name,"parameters":parameters});
    moss_tasks_module::handle(host, "api", &request.to_string())
        .map(|s| serde_json::from_str(&s).unwrap())
}

fn set(host: &Store, id: &str, status: &str) -> moss_module_sdk::Result<Value> {
    api(
        host,
        "setBriefingTaskStatus",
        json!({"taskId":id,"status":status}),
    )
}

#[test]
fn each_allowed_transition_changes_the_status() {
    for (from, to) in [
        ("suggested", "todo"),
        ("suggested", "archived"),
        ("todo", "archived"),
    ] {
        let host = Store::new(vec![task(MINE, "alice", from)]);
        let out = set(&host, MINE, to).unwrap();
        assert_eq!(
            out,
            json!({"task":{"id":MINE,"status":to}}),
            "{from} to {to}"
        );
        assert_eq!(host.status_of(MINE), to);
    }
}

#[test]
fn setting_the_current_status_returns_the_task_unchanged() {
    for status in ["todo", "archived"] {
        let host = Store::new(vec![task(MINE, "alice", status)]);
        let out = set(&host, MINE, status).unwrap();
        assert_eq!(out, json!({"task":{"id":MINE,"status":status}}));
        assert_eq!(
            host.rows.lock().unwrap()[0]["updated_at"],
            STAMP,
            "no write"
        );
    }
}

#[test]
fn a_done_task_and_an_unlisted_move_are_refused_and_left_alone() {
    for (from, to) in [("done", "todo"), ("done", "archived"), ("archived", "todo")] {
        let host = Store::new(vec![task(MINE, "alice", from)]);
        assert!(set(&host, MINE, to).is_err(), "{from} to {to}");
        assert_eq!(host.status_of(MINE), from);
    }
}

#[test]
fn another_accounts_task_is_not_found_and_unchanged() {
    let host = Store::new(vec![task(THEIRS, "bob", "suggested")]);
    assert_eq!(
        set(&host, THEIRS, "archived").unwrap(),
        json!({"task":null})
    );
    assert_eq!(
        set(&host, "no-such-id", "archived").unwrap(),
        json!({"task":null})
    );
    assert_eq!(host.status_of(THEIRS), "suggested");
}

#[test]
fn only_todo_and_archived_are_accepted_and_unknown_fields_refused() {
    let host = Store::new(vec![task(MINE, "alice", "suggested")]);
    for bad in [
        json!({"taskId":MINE,"status":"done"}),
        json!({"taskId":MINE,"status":"suggested"}),
        json!({"taskId":MINE,"status":"todo","ownerUserId":"bob"}),
        json!({"status":"todo"}),
    ] {
        assert!(api(&host, "setBriefingTaskStatus", bad).is_err());
    }
    assert_eq!(host.status_of(MINE), "suggested");
}

#[test]
fn a_follow_up_task_is_open_and_owned_by_the_caller() {
    let host = Store::new(vec![]);
    let out = api(
        &host,
        "createFollowUpTask",
        json!({"title":" Follow up with Sam ","description":"Re: lease"}),
    )
    .unwrap();
    let id = out["task"]["id"].as_str().unwrap().to_owned();
    assert_eq!(out["task"]["status"], "todo");
    let rows = host.rows.lock().unwrap();
    let row = rows.iter().find(|r| r["id"] == id.as_str()).unwrap();
    assert_eq!(row["owner_user_id"], "alice");
    assert_eq!(
        (row["title"].as_str(), row["description"].as_str()),
        (Some("Follow up with Sam"), Some("Re: lease"))
    );
    drop(rows);
    for bad in [
        json!({"title":"  "}),
        json!({"title":"x","ownerUserId":"bob"}),
        json!({}),
    ] {
        assert!(api(&host, "createFollowUpTask", bad).is_err());
    }
    assert_eq!(
        host.rows.lock().unwrap().len(),
        1,
        "refused calls write nothing"
    );
}

#[test]
fn ids_return_archived_tasks_but_never_another_accounts() {
    let host = Store::new(vec![
        task(MINE, "alice", "archived"),
        task(THEIRS, "bob", "archived"),
    ]);
    let out = api(&host, "listBriefingTasks", json!({"ids":[MINE, THEIRS]})).unwrap();
    let items = out["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{out}");
    assert_eq!(
        (items[0]["id"].as_str(), items[0]["status"].as_str()),
        (Some(MINE), Some("archived"))
    );
    assert!(items[0].get("ownerUserId").is_none() && items[0].get("tags").is_none());
    let none = api(&host, "listBriefingTasks", json!({"ids":[]})).unwrap();
    assert_eq!(none, json!({"items":[]}));
}

#[test]
fn ids_cannot_be_mixed_with_a_status_filter() {
    let host = Store::new(vec![]);
    assert!(api(
        &host,
        "listBriefingTasks",
        json!({"ids":[MINE],"status":"todo"})
    )
    .is_err());
    assert!(api(&host, "listBriefingTasks", json!({})).is_err());
}

#[test]
fn archiving_a_parent_archives_its_open_subtasks_only() {
    const CHILD_OPEN: &str = "55555555-5555-4555-8555-555555555551";
    const CHILD_SUGGESTED: &str = "55555555-5555-4555-8555-555555555552";
    const CHILD_DONE: &str = "55555555-5555-4555-8555-555555555553";
    let mut rows = vec![task(MINE, "alice", "todo")];
    for (id, status) in [
        (CHILD_OPEN, "todo"),
        (CHILD_SUGGESTED, "suggested"),
        (CHILD_DONE, "done"),
    ] {
        let mut child = task(id, "alice", status);
        child["parent_task_id"] = json!(MINE);
        rows.push(child);
    }
    let host = Store::new(rows);
    set(&host, MINE, "archived").unwrap();
    assert_eq!(host.status_of(CHILD_OPEN), "archived");
    assert_eq!(host.status_of(CHILD_SUGGESTED), "suggested");
    assert_eq!(host.status_of(CHILD_DONE), "archived");
}

#[test]
fn a_task_finished_after_the_check_is_not_archived() {
    // The store reports "todo" on the read but the row is already done when the write lands.
    struct Racy(Store);
    impl Host for Racy {
        fn call(&self, port: &str, op: &str, table: &str, query: Value) -> Result<Value> {
            let kind = query["kind"].clone();
            let out = self.0.call(port, op, table, query)?;
            if table == "app.tasks" && kind == "select" {
                self.0.rows.lock().unwrap()[0]["status"] = json!("done");
            }
            Ok(out)
        }
    }
    let host = Racy(Store::new(vec![task(MINE, "alice", "todo")]));
    let request =
        json!({"name":"setBriefingTaskStatus","parameters":{"taskId":MINE,"status":"archived"}});
    assert!(moss_tasks_module::handle(&host, "api", &request.to_string()).is_err());
    assert_eq!(host.0.status_of(MINE), "done");
}
