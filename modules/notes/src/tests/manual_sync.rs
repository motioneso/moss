//! HTTP contract and account-independent request shape; host I/O is a stand-in.
use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::cell::RefCell;

const ID: &str = "ca52403e-9b4a-4ff7-bd53-7590890c563c";
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
            ("db", "query", "app.notes_sync_checkpoints") => {
                assert_eq!(params["kind"], "insert");
                assert_eq!(params["values"], json!({"id":ID,"checkpoint":{}}));
                self.writes.borrow_mut().push(params.clone());
                json!([params["values"]])
            }
            ("jobs", "enqueue-after-commit", "notes.sync") => {
                assert_eq!(params["params"], json!({"checkpointId":ID}));
                assert_eq!(params["idempotencyKey"], ID);
                assert_eq!(self.writes.borrow().len(), 1);
                json!({"deferred":true})
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
