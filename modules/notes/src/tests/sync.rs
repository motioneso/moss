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

#[test]
fn durable_job_refuses_forged_envelopes_before_host_access() {
    struct Deny;
    impl moss_module_sdk::Host for Deny {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> moss_module_sdk::Result<Value> {
            panic!("Invalid durable job reached core")
        }
    }
    let id = "a4230333-65ef-41c4-b244-98b221695ecc";
    for payload in [
        json!({"queue":"notes.sync","parameters":{"checkpoint-id":"not-an-id"}}),
        json!({"queue":"other.sync","parameters":{"checkpoint-id":id}}),
        json!({"queue":"notes.sync","actorUserId":id,"parameters":{"checkpoint-id":id}}),
        json!({"queue":"notes.sync","parameters":{"checkpoint-id":id,"filePath":"private"}}),
        json!({"queue":"notes.sync","parameters":{"checkpoint-id":id,"actorUserId":id}}),
    ] {
        assert!(handle(&Deny, "job", &payload.to_string()).is_err());
    }
}

/// Durable worker wraps the coordinator, while core I/O remains the same named
/// stand-in used by the legacy corpus. Outcome persistence is checked in the DB gate.
#[test]
fn durable_worker_records_only_finished_runs_and_keeps_errors_safe() {
    struct Worker<'a> {
        core: SyncHost<'a>,
        outcomes: RefCell<Vec<Value>>,
    }
    impl moss_module_sdk::Host for Worker<'_> {
        fn call(
            &self,
            port: &str,
            op: &str,
            resource: &str,
            p: Value,
        ) -> moss_module_sdk::Result<Value> {
            match (port, op) {
                ("db", "query") if p["kind"] == "select" || p["values"].get("id").is_some() => {
                    Ok(json!([{"checkpoint":self.core.case["payload"]}]))
                }
                ("db", "query") => Ok(json!([{}])),
                ("context", "read") => Ok(json!({"now":"2026-11-09T12:00:00.000Z"})),
                ("context", "uuid") => Ok(json!({"id":"00000000-0000-4000-8000-000000000002"})),
                ("jobs", "enqueue-after-commit") => Ok(json!({"deferred":true})),
                ("vault", "folder.record-sync") => {
                    self.outcomes.borrow_mut().push(p);
                    // Legacy status writes are best effort: failure must not mask
                    // successful ingestion or replace the coordinator error.
                    Err(moss_module_sdk::Error::new(
                        "private status backend failure",
                    ))
                }
                _ => self.core.call(port, op, resource, p),
            }
        }
    }
    for line in include_str!("sync-vectors.jsonl").lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let worker = Worker {
            core: SyncHost {
                case: &case,
                calls: RefCell::new(vec![]),
            },
            outcomes: RefCell::new(vec![]),
        };
        let result = handle(
            &worker,
            "job",
            r#"{"queue":"notes.sync","parameters":{"checkpoint-id":"00000000-0000-4000-8000-000000000001"}}"#,
        );
        let expected = &case["expected"];
        let outcome = if let Some(error) = expected["error"].as_str() {
            assert_eq!(result.unwrap_err().message, error);
            {
                assert_eq!(
                    case["lastSync"],
                    json!({"ingested":0,"skipped":0,"errors":0,"lastError":error})
                );
                json!({"outcome":"failed","lastError":case["lastSync"]["lastError"]})
            }
        } else {
            let mut expected_result = expected["ok"].clone();
            if expected_result.get("continuation").is_some() {
                expected_result
                    .as_object_mut()
                    .unwrap()
                    .remove("continuation");
                expected_result["checkpointId"] = json!("00000000-0000-4000-8000-000000000002");
            }
            assert_eq!(
                serde_json::from_str::<Value>(&result.unwrap()).unwrap(),
                expected_result
            );
            if expected["ok"]["noOp"] == true {
                assert!(case["lastSync"].is_null());
                assert!(
                    worker.outcomes.borrow().is_empty(),
                    "No-op replaced saved stats"
                );
                continue;
            } else if expected["ok"]["deferred"] == true {
                assert!(case["lastSync"].is_null());
                json!({"outcome":"deferred"})
            } else {
                json!({"outcome":"completed","ingested":case["lastSync"]["ingested"],"skipped":case["lastSync"]["skipped"],"errors":case["lastSync"]["errors"]})
            }
        };
        assert_eq!(*worker.outcomes.borrow(), vec![outcome], "{case}");
    }
}

/// The same durable page may be redelivered after the worker restarts or after
/// after-commit publication fails. Core operations must not run a second time.
#[test]
fn durable_page_replay_reuses_its_result_and_continuation() {
    struct Worker<'a> {
        core: SyncHost<'a>,
        row: RefCell<Value>,
        jobs: RefCell<Vec<Value>>,
        outcomes: RefCell<Vec<Value>>,
        ids: RefCell<u32>,
    }
    impl moss_module_sdk::Host for Worker<'_> {
        fn call(
            &self,
            port: &str,
            op: &str,
            resource: &str,
            p: Value,
        ) -> moss_module_sdk::Result<Value> {
            match (port, op) {
                ("db", "query") => {
                    if p["kind"] == "update" {
                        assert_eq!(
                            p["filter"],
                            json!({"type":"compare", "column":"id", "op":"eq", "value":"00000000-0000-4000-8000-000000000001"})
                        );
                    }
                    if p["values"].get("checkpoint").is_some() && p["kind"] == "update" {
                        *self.row.borrow_mut() = p["values"]["checkpoint"].clone();
                    }
                    Ok(json!([{"checkpoint":*self.row.borrow()}]))
                }
                ("context", "read") => Ok(json!({"now":"2026-11-09T12:00:00.000Z"})),
                ("context", "uuid") => {
                    *self.ids.borrow_mut() += 1;
                    Ok(json!({"id":format!("00000000-0000-4000-8000-{:012}", *self.ids.borrow())}))
                }
                ("jobs", "enqueue-after-commit") => {
                    self.jobs.borrow_mut().push(p);
                    Ok(json!({"deferred":true}))
                }
                ("vault", "folder.record-sync") => {
                    self.outcomes.borrow_mut().push(p);
                    Ok(json!({}))
                }
                _ => self.core.call(port, op, resource, p),
            }
        }
    }
    let mut count = 0;
    for line in include_str!("sync-vectors.jsonl").lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        if case["expected"].get("ok").is_none() {
            continue;
        }
        let worker = Worker {
            core: SyncHost {
                case: &case,
                calls: RefCell::new(vec![]),
            },
            row: RefCell::new(case["payload"].clone()),
            jobs: RefCell::new(vec![]),
            outcomes: RefCell::new(vec![]),
            ids: RefCell::new(2),
        };
        let payload = r#"{"queue":"notes.sync","parameters":{"checkpoint-id":"00000000-0000-4000-8000-000000000001"}}"#;
        let first = handle(&worker, "job", payload).unwrap();
        let core_calls = worker.core.calls.borrow().clone();
        let first_jobs = worker.jobs.borrow().clone();
        let first_outcomes = worker.outcomes.borrow().clone();
        worker.jobs.borrow_mut().clear();
        let second = handle(&worker, "job", payload).unwrap();
        assert_eq!(
            second, first,
            "Replay changed the saved page result: {case}"
        );
        assert_eq!(
            *worker.core.calls.borrow(),
            core_calls,
            "Replay reran core I/O: {case}"
        );
        assert_eq!(
            *worker.jobs.borrow(),
            first_jobs,
            "Replay created a new continuation: {case}"
        );
        // Deferred retries register publication failures, but completed/no-op
        // retries must leave any newer saved outcome alone.
        if case["expected"]["ok"]["deferred"] != true {
            assert_eq!(*worker.outcomes.borrow(), first_outcomes);
        }
        assert_eq!(*worker.ids.borrow(), 2 + u32::from(!first_jobs.is_empty()));
        count += 1;
    }
    assert!(count > 20);
}

#[test]
fn malformed_saved_pages_are_refused_before_publication() {
    struct Corrupt(Value);
    impl moss_module_sdk::Host for Corrupt {
        fn call(&self, port: &str, _: &str, _: &str, _: Value) -> moss_module_sdk::Result<Value> {
            assert_eq!(port, "db", "Corrupt saved result reached core or queue");
            Ok(json!([{"checkpoint": self.0}]))
        }
    }
    for saved in [
        json!({"workerResult":{"ingested":0,"skipped":0,"errors":0,"path":"private-marker"}}),
        json!({"workerResult":{"ingested":0,"skipped":0,"errors":0,"deferred":true,"checkpointId":"private-marker"}}),
        json!({"workerResult":{"ingested":0,"skipped":0,"errors":0,"deferred":true}}),
        json!({"workerResult":{"ingested":0,"skipped":0,"errors":0,"checkpointId":"00000000-0000-4000-8000-000000000001"}}),
        json!({"workerResult":{"ingested":-1,"skipped":0,"errors":0}}),
        json!({"workerResult":null}),
    ] {
        let error = handle(&Corrupt(saved), "job",
            r#"{"queue":"notes.sync","parameters":{"checkpoint-id":"00000000-0000-4000-8000-000000000001"}}"#).unwrap_err();
        assert_eq!(error.message, "Notes sync checkpoint is unavailable");
    }
}

#[path = "sync/recovery.rs"]
mod recovery;
