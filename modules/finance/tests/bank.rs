//! Bank routes and jobs against a scripted host. The real-database tests in the host crate prove
//! the rows; these pin the reply shapes and statuses the old handlers gave.
mod common;
use moss_module_sdk::{query::Query, Error, Host, Result, RouteRequest};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

struct Scripted {
    keys: Cell<bool>,
    plaid: RefCell<Vec<(String, u16, Value)>>,
    calls: RefCell<Vec<(String, String)>>,
    sessions: RefCell<Vec<Value>>,
}

impl Scripted {
    fn new() -> Self {
        Self { keys: Cell::new(true), plaid: RefCell::new(vec![]), calls: RefCell::new(vec![]), sessions: RefCell::new(vec![]) }
    }
    fn route(&self, path: &str) -> (u16, Value) {
        let request = RouteRequest { method: "POST".into(), path: path.into(), params: BTreeMap::new(), query: BTreeMap::new(), body: json!({}) };
        let r = moss_finance_module::route(self, request);
        (r.status, r.body)
    }
}

impl Host for Scripted {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into()));
        match (port, operation) {
            ("credentials", "status") => Ok(json!({"configured": self.keys.get()})),
            ("credentials", "request") => {
                let url = parameters["url"].as_str().unwrap_or_default().to_owned();
                let plaid = self.plaid.borrow();
                let (_, status, body) = plaid.iter().find(|(p, _, _)| url.ends_with(p.as_str())).ok_or_else(|| Error::new("unscripted"))?;
                Ok(json!({"status":status,"body":body}))
            }
            ("context", "read") => Ok(json!({"actorUserId":"00000000-0000-4000-8000-00000000000a","now":"2026-11-11T18:00:00.000Z"})),
            ("context", "local-date") => Ok(json!({"timezone":"UTC","date":"2026-11-11","offsetMinutes":0})),
            ("jobs", _) => Ok(json!({})),
            ("db", "query") => {
                let query: Query = serde_json::from_value(parameters)?;
                Ok(match (resource, format!("{:?}", query.kind).as_str()) {
                    ("app.finance_link_sessions", "Select") => json!(self.sessions.borrow().clone()),
                    ("app.finance_link_sessions", "Insert") => {
                        self.sessions.borrow_mut().push(json!(query.values));
                        json!([])
                    }
                    _ => json!([]),
                })
            }
            _ => Err(Error::new("Unexpected host call")),
        }
    }
}

#[test]
fn starting_without_saved_keys_is_a_bad_gateway_and_makes_no_bank_call() {
    let h = Scripted::new();
    h.keys.set(false);
    let (status, body) = h.route("/finance/connect/start");
    assert_eq!(status, 502, "{body}");
    assert_eq!(body["code"], "bank_unavailable");
    assert!(h.calls.borrow().iter().all(|(_, op)| op != "request"));
}

#[test]
fn starting_returns_the_pending_page_address_and_queues_one_poll() {
    let h = Scripted::new();
    h.plaid.borrow_mut().push(("/link/token/create".into(), 200, json!({"link_token":"link-1","hosted_link_url":"https://example.test/hl/1"})));
    let (status, body) = h.route("/finance/connect/start");
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "pending");
    assert_eq!(body["hostedLinkUrl"], "https://example.test/hl/1");
    assert!(body["nextStep"].as_str().unwrap().contains("finance.connect.poll"));
    assert_eq!(h.sessions.borrow().len(), 1);
    assert_eq!(h.calls.borrow().iter().filter(|(p, o)| p == "jobs" && o == "enqueue-after-commit").count(), 1);
}

#[test]
fn a_refused_link_is_a_bad_gateway() {
    let h = Scripted::new();
    h.plaid.borrow_mut().push(("/link/token/create".into(), 400, json!({"error_code":"INVALID_API_KEYS"})));
    assert_eq!(h.route("/finance/connect/start").0, 502);
}

#[test]
fn polling_with_nothing_pending_has_the_old_reply_keys() {
    let h = Scripted::new();
    let (status, body) = h.route("/finance/connect/poll");
    assert_eq!(status, 200);
    for key in ["status", "completed", "pending", "abandoned", "nextStep"] {
        assert!(body.get(key).is_some(), "missing {key}");
    }
    assert_eq!((body["status"].clone(), body["completed"].clone()), (json!("ok"), json!(0)));
}

#[test]
fn run_now_with_no_banks_is_ok_and_empty() {
    let h = Scripted::new();
    let (status, body) = h.route("/finance/sync/run-now");
    assert_eq!((status, body), (200, json!({"status":"ok","items":[]})));
}

#[test]
fn jobs_dispatch_by_queue_and_refuse_an_unknown_one() {
    let h = Scripted::new();
    let sweep = moss_finance_module::handle(&h, "job", &json!({"queue":"finance.sync-run","parameters":{}}).to_string()).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&sweep).unwrap()["items"], json!([]));
    let poll = moss_finance_module::handle(&h, "job", &json!({"queue":"finance.connect-poll","parameters":{}}).to_string()).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&poll).unwrap()["completed"], 0);
    assert!(moss_finance_module::handle(&h, "job", &json!({"queue":"finance.other"}).to_string()).is_err());
}

/// Exercises the real sync and storage logic, scripting only the bank's replies.
struct SyncBank {
    db: common::Fake,
    replies: RefCell<std::collections::VecDeque<(Value, u16, Value)>>,
    cursors: RefCell<Vec<Value>>,
}

impl SyncBank {
    fn new(replies: Vec<(Value, u16, Value)>) -> Self {
        let db = common::Fake::new();
        db.seed("app.finance_items", common::A, json!({"item_id":"bank","status":"connected"}));
        db.seed("app.finance_bank_links", common::A, json!({"item_id":"bank","slot":"slot","sync_cursor":null}));
        Self { db, replies: RefCell::new(replies.into()), cursors: RefCell::new(vec![]) }
    }
    fn run(&self) -> Value {
        moss_finance_module::sync::run(self).unwrap()["items"][0].clone()
    }
}

impl Host for SyncBank {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        if (port, operation) != ("credentials", "request") {
            return self.db.call(port, operation, resource, parameters);
        }
        let url = parameters["url"].as_str().unwrap();
        if url.ends_with("/accounts/balance/get") {
            return Ok(json!({"status":200,"body":{"accounts":[]}}));
        }
        assert!(url.ends_with("/transactions/sync"), "unexpected bank request: {url}");
        let cursor = parameters["body"]["cursor"].clone();
        self.cursors.borrow_mut().push(cursor.clone());
        let (expected, status, body) = self.replies.borrow_mut().pop_front().expect("unexpected sync request");
        assert_eq!(cursor, expected, "sync must resume from the expected cursor");
        Ok(json!({"status":status,"body":body}))
    }
}

fn sync_page(cursor: Value, next: &str, more: bool, id: &str) -> (Value, u16, Value) {
    (cursor, 200, json!({"added":[{"transaction_id":id,"account_id":"account","date":"2026-11-01","amount":1,"name":"Shop"}],
        "modified":[],"removed":[],"next_cursor":next,"has_more":more}))
}

fn mutation() -> (Value, u16, Value) {
    (json!("c1"), 400, json!({"error_code":"TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"}))
}

#[test]
fn a_mutation_restarts_with_room_for_both_pages() {
    let bank = SyncBank::new(vec![
        sync_page(Value::Null, "c1", true, "t1"), mutation(),
        sync_page(Value::Null, "c1", true, "t1"), sync_page(json!("c1"), "c2", false, "t2"),
    ]);
    let result = bank.run();
    assert_eq!(result["status"], "connected");
    assert_eq!(result["pages"], 3, "report all successful page reads, including the replay");
    assert_eq!(*bank.cursors.borrow(), vec![Value::Null, json!("c1"), Value::Null, json!("c1")]);
    let rows = bank.db.rows("app.finance_transactions");
    assert_eq!(rows.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), ["t1", "t2"]);
    assert_eq!(bank.db.rows("app.finance_bank_links")[0]["sync_cursor"], "c2");
}

#[test]
fn a_normal_read_still_stops_after_two_pages_and_resumes_next_run() {
    let bank = SyncBank::new(vec![
        sync_page(Value::Null, "c1", true, "t1"), sync_page(json!("c1"), "c2", true, "t2"),
        sync_page(json!("c2"), "c3", false, "t3"),
    ]);
    assert_eq!(bank.run()["pages"], 2);
    assert_eq!(bank.db.rows("app.finance_transactions").len(), 2);
    assert_eq!(bank.cursors.borrow().len(), 2);
    assert_eq!(bank.run()["pages"], 1);
    assert_eq!(bank.db.rows("app.finance_transactions").len(), 3);
    assert!(bank.replies.borrow().is_empty());
}

#[test]
fn repeated_mid_read_mutations_stop_after_three_restarts() {
    let mut replies = vec![];
    for _ in 0..4 {
        replies.extend([sync_page(Value::Null, "c1", true, "t1"), mutation()]);
    }
    let bank = SyncBank::new(replies);
    assert_eq!(bank.run()["status"], "error");
    assert_eq!(bank.cursors.borrow().len(), 8);
    assert_eq!(bank.db.rows("app.finance_items")[0]["last_error"], "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
    assert_eq!(bank.db.rows("app.finance_transactions").len(), 1);
}
