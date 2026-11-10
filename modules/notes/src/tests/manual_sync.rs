//! HTTP contract and account-independent request shape; host I/O is a stand-in.
use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::cell::RefCell;

const ID: &str = "ca52403e-9b4a-4ff7-bd53-7590890c563c";

#[test]
fn api_sync_pins_the_server_read_source_and_refuses_unlinked_sources() {
    for source in [json!("/notes"), Value::Null, json!(""), json!(42)] {
        let host = Services {
            source: source.clone(),
            fail: None,
            writes: RefCell::new(vec![]),
        };
        let out = handle(
            &host,
            "api",
            r#"{"name":"requestNotesSync","parameters":{}}"#,
        );
        let configured = source.as_str().is_some_and(|s| !s.is_empty());
        assert_eq!(out.is_ok(), configured);
        assert_eq!(host.writes.borrow().len(), usize::from(configured));
        if configured {
            assert_eq!(
                serde_json::from_str::<Value>(&out.unwrap()).unwrap(),
                json!({"checkpointId":ID})
            );
        }
    }
}

#[test]
fn api_sync_refuses_caller_overrides_before_host_access() {
    struct Deny;
    impl Host for Deny {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
            panic!("Caller override reached a host service");
        }
    }
    for field in ["actorUserId", "sourcePath", "checkpointId"] {
        let request = json!({"name":"requestNotesSync","parameters":{(field):"forged"}});
        assert!(handle(&Deny, "api", &request.to_string()).is_err());
    }
}

#[test]
fn api_sync_lookup_failure_never_saves_a_request_or_exposes_backend_text() {
    let host = Services {
        source: json!("/notes"),
        fail: Some("vault"),
        writes: RefCell::new(vec![]),
    };
    let error = handle(
        &host,
        "api",
        r#"{"name":"requestNotesSync","parameters":{}}"#,
    )
    .unwrap_err();
    assert!(!error.message.contains("private backend"));
    assert!(host.writes.borrow().is_empty());
}
struct Services {
    source: Value,
    fail: Option<&'static str>,
    writes: RefCell<Vec<Value>>,
}
impl Host for Services {
    fn call(&self, port: &str, op: &str, resource: &str, params: Value) -> Result<Value> {
        if self.fail == Some(port) {
            return Err(Error::new("private backend error"));
        }
        Ok(match (port, op, resource) {
            ("vault", "folder.get", "source") => {
                assert_eq!(params, json!({}));
                json!({"status":200,"body":self.source})
            }
            ("context", "read", "call") => json!({"now":"2026-11-09T12:00:00Z"}),
            ("context", "uuid", "new") => json!({"id":ID}),
            ("db", "query", "app.notes_sync_checkpoints") if params["kind"] == "select" => {
                json!([])
            }
            ("db", "query", "app.notes_sync_checkpoints") => {
                assert_eq!(params["kind"], "insert");
                assert_eq!(
                    params["values"],
                    json!({"id":ID,"checkpoint":{"sourcePath":self.source}})
                );
                self.writes.borrow_mut().push(params.clone());
                json!([params["values"]])
            }
            ("jobs", "enqueue-after-commit", "notes.sync") => {
                assert_eq!(params["params"], json!({"checkpoint-id":ID}));
                assert_eq!(params["idempotencyKey"], ID);
                assert_eq!(self.writes.borrow().len(), 1);
                json!({"deferred":true})
            }
            ("jobs", "unschedule", "notes.sync-tick") => {
                assert_eq!(params, json!({"id":ID}));
                json!({"cancelled":true})
            }
            ("jobs", "schedule", "notes.sync-tick") => {
                assert_eq!(
                    params,
                    json!({"cron":"*/15 * * * *","timezone":"UTC","key":"notes-sync","params":{}})
                );
                json!({"id":ID})
            }
            _ => panic!("Unexpected manual-sync access: {port}/{op}/{resource}"),
        })
    }
}

#[test]
fn manual_sync_route_preserves_legacy_responses_and_ignores_caller_overrides() {
    for line in include_str!("manual-sync-vectors.jsonl").lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let source = case["source"].clone();
        let host = Services {
            source: source.clone(),
            fail: None,
            writes: RefCell::new(vec![]),
        };
        let out: Value = serde_json::from_str(
            &handle(
                &host,
                "route",
                &json!({
                    "method":"POST","path":"/notes/sync",
                    "body":{"actorUserId":"other","sourcePath":"/other","checkpointId":ID},
                    "query":{"actorUserId":"other"}
                })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        let configured = source.as_str().is_some_and(|s| !s.is_empty());
        assert_eq!(out, case["expected"]);
        assert_eq!(host.writes.borrow().len(), usize::from(configured));
    }
}

#[test]
fn manual_sync_failures_return_safe_legacy_error() {
    for fail in ["vault", "context", "db", "jobs"] {
        let host = Services {
            source: json!("/notes"),
            fail: Some(fail),
            writes: RefCell::new(vec![]),
        };
        let out: Value = serde_json::from_str(
            &handle(&host, "route", r#"{"method":"POST","path":"/notes/sync"}"#).unwrap(),
        )
        .unwrap();
        assert_eq!(
            out,
            json!({"status":500,"body":{"error":"Internal server error"}})
        );
    }
}

#[test]
fn scheduled_tick_requests_a_checkpoint_only_when_a_folder_is_linked() {
    let linked = Services {
        source: json!("/notes"),
        fail: None,
        writes: RefCell::new(vec![]),
    };
    let out = handle(&linked, "job", r#"{"queue":"notes.sync-tick","parameters":{}}"#).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!({"checkpointId":ID}));
    assert_eq!(linked.writes.borrow().len(), 1);

    let unlinked = Services {
        source: json!(""),
        fail: None,
        writes: RefCell::new(vec![]),
    };
    let out = handle(&unlinked, "job", r#"{"queue":"notes.sync-tick","parameters":{}}"#).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!({"noOp":true}));
    assert!(unlinked.writes.borrow().is_empty());
}

#[test]
fn unlinking_cancels_the_schedule_and_linking_keeps_it() {
    struct Calls(RefCell<Vec<String>>);
    impl Host for Calls {
        fn call(&self, port: &str, op: &str, _: &str, _: Value) -> Result<Value> {
            self.0.borrow_mut().push(format!("{port}/{op}"));
            Ok(match (port, op) {
                ("vault", _) => json!({"status":200,"body":null}),
                ("jobs", "schedule") => json!({"id":ID}),
                ("jobs", "unschedule") => json!({"cancelled":true}),
                _ => panic!("unexpected {port}/{op}"),
            })
        }
    }
    for (path, expected) in [
        (json!("/notes"), vec!["vault/folder.set", "jobs/schedule"]),
        (Value::Null, vec!["vault/folder.set", "jobs/schedule", "jobs/unschedule"]),
    ] {
        let host = Calls(RefCell::new(vec![]));
        handle(
            &host,
            "route",
            &json!({"method":"PUT","path":"/notes-source","body":{"path":path}}).to_string(),
        )
        .unwrap();
        assert_eq!(*host.0.borrow(), expected);
    }
}
