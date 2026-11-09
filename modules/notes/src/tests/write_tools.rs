//! Actual legacy execute-function comparisons; filesystem and sync are explicit boundary stand-ins.
use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap};

struct Ports {
    files: RefCell<BTreeMap<String, String>>,
    syncs: RefCell<usize>,
    checkpoints: RefCell<Vec<Value>>,
}
impl Host for Ports {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        match (port, operation, resource) {
            ("vault", "folder.resolve", "source") => Ok(json!({"status":200,"body":"/notes"})),
            ("vault", "notes.read", "source") => {
                let path = parameters["path"].as_str().unwrap();
                Ok(
                    json!({"path":path,"destinationId":"destination","content":self.files.borrow().get(path)}),
                )
            }
            ("vault", "notes.compare-write", "source") | ("vault", "notes.remove", "source") => {
                let path = parameters["path"].as_str().unwrap();
                assert_eq!(parameters["destinationId"], "destination");
                assert_eq!(json!(self.files.borrow().get(path)), parameters["expected"]);
                if operation == "notes.remove" {
                    self.files.borrow_mut().remove(path);
                } else {
                    self.files
                        .borrow_mut()
                        .insert(path.into(), parameters["content"].as_str().unwrap().into());
                }
                Ok(json!({}))
            }
            ("jobs", "enqueue-after-commit", "notes.sync") => {
                assert_eq!(
                    parameters["params"],
                    json!({"checkpoint-id":"00000000-0000-4000-8000-000000000001"})
                );
                assert_eq!(
                    parameters["idempotencyKey"],
                    parameters["params"]["checkpoint-id"]
                );
                assert_eq!(
                    self.checkpoints.borrow().len(),
                    *self.syncs.borrow() + 1,
                    "Every write must save a private checkpoint before queueing"
                );
                assert_eq!(parameters.as_object().unwrap().len(), 3);
                *self.syncs.borrow_mut() += 1;
                Ok(json!({"deferred":true}))
            }
            ("db", "query", "app.notes_sync_checkpoints") => {
                assert_eq!(parameters["kind"], "insert");
                assert_eq!(parameters["values"]["checkpoint"], json!({}));
                self.checkpoints
                    .borrow_mut()
                    .push(parameters["values"].clone());
                Ok(json!([parameters["values"]]))
            }
            ("context", "read", "call") => Ok(json!({"now":"2026-11-08T12:00:00.000Z"})),
            ("context", "uuid", "new") => Ok(json!({"id":"00000000-0000-4000-8000-000000000001"})),
            _ => Err(Error::new("Unexpected test port")),
        }
    }
}
#[test]
fn write_tools_match_actual_legacy_handlers() {
    let cases: Vec<Value> = include_str!("write-tool-vectors.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(cases.len() >= 30);
    for case in cases {
        let files: BTreeMap<String, String> =
            serde_json::from_value(case["files"].clone()).unwrap();
        let ports = Ports {
            files: RefCell::new(files),
            syncs: RefCell::new(0),
            checkpoints: RefCell::new(Vec::new()),
        };
        let actual = match handle(&ports, "tool", &case["request"].to_string()) {
            Ok(result) => json!({"ok":serde_json::from_str::<Value>(&result).unwrap()}),
            Err(error) => {
                json!({"error":serde_json::from_str::<Value>(&error.message).expect("safe structured tool error")})
            }
        };
        assert_eq!(actual, case["expected"], "{}", case["request"]);
        assert_eq!(
            json!(*ports.files.borrow()),
            case["after"],
            "file effect {}",
            case["request"]
        );
        assert_eq!(json!(*ports.syncs.borrow()), case["syncs"]);
    }
}

#[test]
fn tools_reject_forged_context_and_unknown_fields_before_host_access() {
    struct NoCalls;
    impl Host for NoCalls {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
            panic!("Invalid input reached host")
        }
    }
    for request in [
        json!({"tool":"notes.create","parameters":{"path":"a.md","content":"x","actorUserId":"other"}}),
        json!({"tool":"notes.delete","parameters":{"path":"a.md"},"actorUserId":"other"}),
        json!({"tool":"notes.create","parameters":{"path":"a.md","content":"x","overwrite":"true"}}),
        json!({"tool":"notes.edit","parameters":{"path":"a.md","oldText":"","newText":"x"}}),
        json!({"tool":"notes.unknown","parameters":{"query":"private"}}),
    ] {
        assert!(handle(&NoCalls, "tool", &request.to_string()).is_err());
    }
}

#[test]
fn approval_details_match_actual_legacy_hooks_without_writing_or_enqueueing() {
    #[derive(serde::Deserialize)]
    struct Case {
        files: BTreeMap<String, String>,
        request: Box<serde_json::value::RawValue>,
        expected: Value,
    }
    for line in include_str!("approval-vectors.jsonl").lines() {
        let case: Case = serde_json::from_str(line).unwrap();
        let ports = Ports {
            files: RefCell::new(case.files.clone()),
            syncs: RefCell::new(0),
            checkpoints: RefCell::new(Vec::new()),
        };
        let out = moss_notes::write_tools::presentation(&ports, case.request.get()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            case.expected,
            "{}",
            case.request
        );
        assert_eq!(*ports.files.borrow(), case.files);
        assert_eq!(*ports.syncs.borrow(), 0);
    }
}
