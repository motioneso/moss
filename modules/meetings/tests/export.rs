//! Private exports of a summary version, against stand-ins for the stores and for Notes. The
//! real-database behaviour is proved in the host crate tests.
use moss_module_sdk::{Error, Host, Result, RouteRequest};
use moss_meetings_module::export_render::render;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

const M: &str = "11111111-1111-4111-8111-111111111111";
const K1: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const K2: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const K3: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MARKER: &str = "ZEBRAMARKER7731";

fn artifact() -> Value {
    serde_json::from_str(include_str!("fixtures/export_artifact.json")).unwrap()
}

#[derive(Default)]
struct World {
    artifacts: RefCell<BTreeMap<i64, Value>>,
    receipts: RefCell<BTreeMap<i64, (String, String)>>,
    requests: RefCell<BTreeMap<String, (i64, Option<String>)>>,
    copies: RefCell<BTreeMap<String, String>>,
    notes_down: Cell<bool>,
    lose_answer: Cell<bool>,
    writes: Cell<u32>,
    calls: RefCell<Vec<String>>,
    seen: RefCell<Vec<String>>,
}

impl World {
    fn new() -> Self {
        let w = Self::default();
        w.artifacts.borrow_mut().insert(3, artifact());
        w
    }
    fn route(&self, method: &str, key: Option<&str>, version: i64) -> (u16, Value) {
        let body = key.map_or(Value::Null, |k| json!({"requestKey": k, "artifactVersion": version}));
        let request = RouteRequest {
            method: method.into(),
            path: "/records/:id/exports".into(),
            params: [("id".to_owned(), M.to_owned())].into(),
            query: Default::default(),
            body,
        };
        let response = moss_meetings_module::route(self, request);
        (response.status, response.body)
    }
    fn notes(&self, p: &Value) -> Result<Value> {
        if self.notes_down.get() {
            return Err(Error::new("Notes service is unavailable"));
        }
        let args = &p["parameters"];
        let key = format!("{}/v{}", args["sourceId"].as_str().unwrap(), args["version"]);
        let content = args["content"].as_str().unwrap().to_owned();
        let reference = format!("notes/generated/{key}.md");
        let seen = self.copies.borrow().get(&key).cloned();
        let answer = |status: &str| json!({"destination":"private-vault","audience":"owner","noteReference":reference,"contentHash":"h","status":status});
        match p["name"].as_str().unwrap() {
            "inspectPrivateNote" => Ok(answer(match seen {
                None => "missing",
                Some(text) if text == content => "unchanged",
                Some(_) => "conflict",
            })),
            "exportPrivateNote" => {
                let status = match seen {
                    None => {
                        self.copies.borrow_mut().insert(key, content);
                        self.writes.set(self.writes.get() + 1);
                        if self.lose_answer.replace(false) {
                            return Err(Error::new("answer lost"));
                        }
                        "written"
                    }
                    Some(text) if text == content => "unchanged",
                    Some(_) => "conflict",
                };
                Ok(answer(status))
            }
            other => panic!("unexpected Notes call {other}"),
        }
    }
    fn exports(&self, operation: &str, p: &Value) -> Value {
        let version = p["version"].as_i64();
        match operation {
            "list" => {
                let items: Vec<String> = self.receipts.borrow().iter().rev().map(|(_, (_, json))| json.clone()).collect();
                json!({"items": items})
            }
            "request" => match self.requests.borrow().get(p["requestKey"].as_str().unwrap()) {
                None => json!({"found": false}),
                Some((v, result)) => json!({"found": true, "artifactVersion": v, "resultJson": result}),
            },
            "receipt" => match self.receipts.borrow().get(&version.unwrap()) {
                None => json!({"found": false}),
                Some((hash, json)) => json!({"found": true, "contentHash": hash, "receiptJson": json}),
            },
            "intend" => {
                self.receipts
                    .borrow_mut()
                    .entry(version.unwrap())
                    .or_insert((p["contentHash"].as_str().unwrap().into(), p["receiptJson"].as_str().unwrap().into()));
                json!({})
            }
            "reserve" => {
                self.requests.borrow_mut().entry(p["requestKey"].as_str().unwrap().into()).or_insert((version.unwrap(), None));
                json!({})
            }
            "finish" => {
                let json_text = p["receiptJson"].as_str().unwrap().to_owned();
                self.receipts.borrow_mut().get_mut(&version.unwrap()).unwrap().1 = json_text.clone();
                let mut requests = self.requests.borrow_mut();
                let entry = requests.get_mut(p["requestKey"].as_str().unwrap()).unwrap();
                if entry.1.is_none() {
                    entry.1 = Some(json_text);
                }
                json!({})
            }
            other => panic!("unexpected export operation {other}"),
        }
    }
}

impl Host for World {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push(format!("{port}.{operation}.{resource}"));
        if port != "api" {
            self.seen.borrow_mut().push(parameters.to_string());
        }
        match (port, resource) {
            ("context", _) if operation == "read" => Ok(json!({"now": "2026-11-11T12:00:00.000Z"})),
            ("kv", "meetings.outputs") => match operation {
                "lock" | "get" => Ok(json!({"found": true})),
                "artifact" => Ok(match self.artifacts.borrow().get(&parameters["version"].as_i64().unwrap()) {
                    Some(a) => json!({"artifactJson": a.to_string()}),
                    None => json!({}),
                }),
                other => panic!("unexpected outputs operation {other}"),
            },
            ("kv", "meetings.exports") => Ok(self.exports(operation, &parameters)),
            ("api", "notes") => self.notes(&parameters),
            _ => panic!("unexpected host call {port}.{operation}.{resource}"),
        }
    }
}

#[test]
fn rendering_matches_the_old_implementation_byte_for_byte() {
    assert_eq!(render(&artifact()), include_str!("fixtures/export_expected.md"));
}

#[test]
fn a_new_export_makes_one_private_copy_and_a_receipt() {
    let w = World::new();
    let (status, body) = w.route("POST", Some(K1), 3);
    assert_eq!(status, 200, "{body}");
    let receipt = &body["receipt"];
    assert_eq!(receipt["writeStatus"], "saved");
    assert_eq!(receipt["destination"], "private-vault");
    assert_eq!(receipt["audience"], "owner");
    assert_eq!(receipt["noteReference"], format!("notes/generated/{M}/v3.md"));
    // Notes cannot index private copies yet, so the index is reported as delayed.
    assert_eq!(receipt["indexStatus"], "delayed");
    assert_eq!(w.copies.borrow().get(&format!("{M}/v3")).unwrap(), include_str!("fixtures/export_expected.md"));
    let (status, listed) = w.route("GET", None, 0);
    assert_eq!(status, 200);
    assert_eq!(listed["receipts"].as_array().unwrap().len(), 1);
}

#[test]
fn the_same_request_returns_the_same_receipt_without_a_second_write() {
    let w = World::new();
    let (_, first) = w.route("POST", Some(K1), 3);
    let (status, again) = w.route("POST", Some(K1), 3);
    assert_eq!(status, 200);
    assert_eq!(first, again);
    assert_eq!(w.writes.get(), 1);
}

#[test]
fn a_request_key_reused_for_another_version_conflicts() {
    let w = World::new();
    w.artifacts.borrow_mut().insert(4, artifact());
    w.route("POST", Some(K1), 3);
    let (status, body) = w.route("POST", Some(K1), 4);
    assert_eq!((status, body["code"].as_str()), (409, Some("meeting_export_request_conflict")));
}

#[test]
fn a_second_request_for_a_finished_version_changes_nothing() {
    let w = World::new();
    w.route("POST", Some(K1), 3);
    let (status, body) = w.route("POST", Some(K2), 3);
    assert_eq!(status, 200);
    assert_eq!(body["receipt"]["writeStatus"], "saved");
    assert_eq!(w.writes.get(), 1);
}

#[test]
fn an_edited_copy_is_never_overwritten_and_reports_a_conflict() {
    let w = World::new();
    w.route("POST", Some(K1), 3);
    w.copies.borrow_mut().insert(format!("{M}/v3"), "edited by the owner".into());
    let (status, body) = w.route("POST", Some(K2), 3);
    assert_eq!((status, body["receipt"]["errorCode"].as_str()), (409, Some("meeting_vault_conflict")));
    assert_eq!(w.copies.borrow().get(&format!("{M}/v3")).unwrap(), "edited by the owner");
    assert_eq!(w.writes.get(), 1);
}

#[test]
fn a_copy_that_was_deleted_after_saving_is_not_recreated() {
    let w = World::new();
    w.route("POST", Some(K1), 3);
    w.copies.borrow_mut().clear();
    let (status, body) = w.route("POST", Some(K2), 3);
    assert_eq!((status, body["receipt"]["errorCode"].as_str()), (409, Some("meeting_vault_conflict")));
    assert!(w.copies.borrow().is_empty());
}

#[test]
fn an_unavailable_notes_service_fails_then_a_retry_succeeds() {
    let w = World::new();
    w.notes_down.set(true);
    let (status, body) = w.route("POST", Some(K1), 3);
    assert_eq!(status, 200);
    assert_eq!(body["receipt"]["writeStatus"], "failed");
    assert_eq!(body["receipt"]["errorCode"], "meeting_vault_write_failed");
    w.notes_down.set(false);
    let (_, body) = w.route("POST", Some(K3), 3);
    assert_eq!(body["receipt"]["writeStatus"], "saved");
    assert_eq!(w.writes.get(), 1);
}

#[test]
fn a_lost_write_answer_is_recovered_by_looking_again() {
    let w = World::new();
    w.lose_answer.set(true);
    let (_, body) = w.route("POST", Some(K1), 3);
    assert_eq!(body["receipt"]["writeStatus"], "saved");
    assert_eq!(w.writes.get(), 1);
}

#[test]
fn a_missing_summary_version_is_not_found() {
    let w = World::new();
    let (status, body) = w.route("POST", Some(K1), 9);
    assert_eq!((status, body["code"].as_str()), (404, Some("meeting_output_unavailable")));
    assert!(w.receipts.borrow().is_empty());
}

#[test]
fn bad_bodies_are_refused() {
    let w = World::new();
    assert_eq!(w.route("POST", Some("nope"), 3).0, 400);
    assert_eq!(w.route("POST", Some(K1), 0).0, 400);
}

#[test]
fn meeting_text_goes_only_to_the_notes_copy() {
    let w = World::new();
    let mut leaky = artifact();
    leaky["content"]["overview"] = json!(MARKER);
    w.artifacts.borrow_mut().insert(3, leaky);
    w.route("POST", Some(K1), 3);
    assert!(w.copies.borrow().values().any(|c| c.contains(MARKER)));
    // No store write, job call or receipt carries the text.
    assert!(w.seen.borrow().iter().all(|p| !p.contains(MARKER)));
    assert!(w.calls.borrow().iter().all(|c| !c.starts_with("jobs.")));
    assert!(w.receipts.borrow().values().all(|(_, r)| !r.contains(MARKER)));
}
