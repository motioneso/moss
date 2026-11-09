//! Differential control flow; core ingestion/filesystem I/O are explicit stand-ins.
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::cell::RefCell;

#[path = "../../test-support/sync.rs"]
mod support;
use support::SyncHost;

#[test]
fn cleanup_is_one_core_transaction_request() {
    struct Core(RefCell<usize>);
    impl moss_module_sdk::Host for Core {
        fn call(
            &self,
            _: &str,
            operation: &str,
            _: &str,
            p: Value,
        ) -> moss_module_sdk::Result<Value> {
            Ok(match operation {
                "index.sync-open" => {
                    json!({"sourcePath":"/notes","resolvedSourcePath":"/notes","files":["/notes/a.md"]})
                }
                "index.sync-file" => json!({"status":"skipped","chunksProcessed":0}),
                "index.sync-cleanup" => {
                    assert_eq!(
                        p,
                        json!({"sourcePath":"/notes","walkedPaths":["/notes/a.md"]})
                    );
                    *self.0.borrow_mut() += 1;
                    json!({})
                }
                _ => panic!("Cleanup escaped the atomic core request: {operation}"),
            })
        }
    }
    let host = Core(RefCell::new(0));
    handle(&host, "job", r#"{"queue":"notes.sync","parameters":{}}"#).unwrap();
    assert_eq!(*host.0.borrow(), 1);
}

#[test]
fn sync_matches_actual_legacy_coordinator() {
    for line in include_str!("sync-vectors.jsonl").lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let host = SyncHost {
            case: &case,
            calls: RefCell::new(vec![]),
        };
        let payload = json!({"queue":"notes.sync","parameters":case["payload"]}).to_string();
        let out = match handle(&host, "job", &payload) {
            Ok(out) => json!({"ok":serde_json::from_str::<Value>(&out).unwrap()}),
            Err(error) => json!({"error":error.message}),
        };
        assert_eq!(out, case["expected"], "{case}");
        assert_eq!(json!(*host.calls.borrow()), case["calls"], "{case}");
    }
}

#[test]
fn invalid_job_inputs_are_refused_before_core_access() {
    struct Deny;
    impl moss_module_sdk::Host for Deny {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> moss_module_sdk::Result<Value> {
            panic!("Invalid job reached core")
        }
    }
    for payload in [
        json!({"queue":"other.sync","parameters":{}}),
        json!({"name":"notes.sync","parameters":{}}),
        json!({"queue":"notes.sync","parameters":{"actorUserId":"other"}}),
        json!({"queue":"notes.sync","parameters":{"chunkOffset":-1}}),
        json!({"queue":"notes.sync","parameters":{"chunkOffset":9007199254740992u64}}),
        json!({"queue":"notes.sync","parameters":{"chunkOffset":1.5}}),
        json!({"queue":"notes.sync","parameters":{"sourceKind":"vault"}}),
    ] {
        assert!(handle(&Deny, "job", &payload.to_string()).is_err());
    }
}

#[test]
fn invalid_core_progress_cannot_expand_the_chunk_budget_or_disclose_errors() {
    struct BadCore(Value);
    impl moss_module_sdk::Host for BadCore {
        fn call(
            &self,
            _: &str,
            operation: &str,
            _: &str,
            _: Value,
        ) -> moss_module_sdk::Result<Value> {
            Ok(match operation {
                "index.sync-open" => {
                    json!({"sourcePath":"/notes","resolvedSourcePath":"/notes","files":["/notes/a.md"]})
                }
                "index.sync-file" => self.0.clone(),
                "index.sync-cleanup" => json!({}),
                _ => panic!("Unexpected core operation"),
            })
        }
    }
    for value in [
        json!({"status":"ingested","chunksProcessed":101}),
        json!({"status":"ingested","chunksProcessed":-1}),
        json!({"status":"unrecognized","chunksProcessed":0}),
        json!({"error":"private/path EACCES"}),
        json!({"error":{"message":"private/path"}}),
    ] {
        let error = handle(
            &BadCore(value),
            "job",
            r#"{"queue":"notes.sync","parameters":{}}"#,
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "notes sync: all 1 file(s) failed; last error: notes sync failed (Error)"
        );
    }
}
