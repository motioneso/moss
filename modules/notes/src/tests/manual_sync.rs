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
            ("db", "query", "app.notes_sync_checkpoints")
                if params["kind"] == "delete" || params["kind"] == "select" =>
            {
                // Tick maintenance: retention delete and recovery scan find nothing.
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
                // Unlink maintenance finds nothing to clean.
                ("context", "read") => json!({"now":"2026-11-09T12:00:00Z"}),
                ("db", "query") => json!([]),
                _ => panic!("unexpected {port}/{op}"),
            })
        }
    }
    for (path, expected) in [
        (json!("/notes"), vec!["vault/folder.set", "jobs/schedule"]),
        (
            Value::Null,
            vec![
                "vault/folder.set",
                "context/read",
                "db/query",
                "db/query",
                "context/read",
                "jobs/schedule",
                "jobs/unschedule",
            ],
        ),
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

#[test]
fn tick_deletes_old_checkpoints_and_republishes_unfinished_ones() {
    struct Maintenance(RefCell<Vec<Value>>);
    impl Host for Maintenance {
        fn call(&self, port: &str, op: &str, resource: &str, params: Value) -> Result<Value> {
            Ok(match (port, op, resource) {
                ("context", "read", "call") => json!({"now":"2026-11-09T12:00:00Z"}),
                ("db", "query", "app.notes_sync_checkpoints") if params["kind"] == "delete" => {
                    self.0.borrow_mut().push(params);
                    json!([])
                }
                ("db", "query", "app.notes_sync_checkpoints") if params["kind"] == "select" => {
                    json!([
                        {"id":ID,"checkpoint":{"sourcePath":"/private"}},
                        {"id":"00000000-0000-4000-8000-000000000002",
                         "checkpoint":{"workerResult":{"ingested":1,"skipped":0,"errors":0}}}
                    ])
                }
                ("jobs", "enqueue-after-commit", "notes.sync") => {
                    self.0.borrow_mut().push(params);
                    json!({"deferred":true})
                }
                ("vault", "folder.get", "source") => json!({"status":200,"body":""}),
                _ => panic!("Unexpected maintenance access: {port}/{op}/{resource}"),
            })
        }
    }
    let host = Maintenance(RefCell::new(vec![]));
    let out = handle(&host, "job", r#"{"queue":"notes.sync-tick","parameters":{}}"#).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!({"noOp":true}));
    let calls = host.0.borrow();
    let delete = &calls[0];
    assert_eq!(delete["filter"]["column"], "created_at");
    assert_eq!(delete["filter"]["value"], "2026-11-08T12:00:00Z");
    // Only the unfinished checkpoint is published again, with its own identity.
    let publishes: Vec<_> = calls.iter().filter(|c| c.get("idempotencyKey").is_some()).collect();
    assert_eq!(publishes.len(), 1);
    assert_eq!(publishes[0]["idempotencyKey"], ID);
}

/// Rows the recent-request lookup returns, and a record of inserts and publishes.
struct Pending {
    rows: Value,
    inserts: RefCell<u32>,
    published: RefCell<Vec<String>>,
}
impl Host for Pending {
    fn call(&self, port: &str, op: &str, resource: &str, params: Value) -> Result<Value> {
        Ok(match (port, op, resource) {
            ("vault", "folder.get", "source") => json!({"status":200,"body":"/notes"}),
            ("context", "read", "call") => json!({"now":"2026-11-09T12:00:00Z"}),
            ("context", "uuid", "new") => json!({"id":ID}),
            ("db", "query", "app.notes_sync_checkpoints") if params["kind"] == "select" => {
                assert_eq!(params["filter"]["value"], "2026-11-09T11:58:00Z");
                self.rows.clone()
            }
            ("db", "query", "app.notes_sync_checkpoints") => {
                *self.inserts.borrow_mut() += 1;
                json!([params["values"]])
            }
            ("jobs", "enqueue-after-commit", "notes.sync") => {
                self.published
                    .borrow_mut()
                    .push(params["idempotencyKey"].as_str().unwrap().to_owned());
                json!({"deferred":true})
            }
            ("jobs", "schedule", "notes.sync-tick") => json!({"id":ID}),
            _ => panic!("Unexpected access: {port}/{op}/{resource}"),
        })
    }
}

fn manual(rows: Value) -> (Value, Pending) {
    let host = Pending {
        rows,
        inserts: RefCell::new(0),
        published: RefCell::new(vec![]),
    };
    let out = handle(&host, "route", r#"{"method":"POST","path":"/notes/sync"}"#).unwrap();
    (serde_json::from_str(&out).unwrap(), host)
}

#[test]
fn manual_sync_reuses_a_recent_unfinished_request_for_the_same_folder() {
    let other = "11111111-1111-4111-8111-111111111111";
    let (out, host) = manual(json!([
        {"id":other,"checkpoint":{"sourcePath":"/notes"}},
    ]));
    assert_eq!(out, json!({"status":202,"body":{"jobId":other}}));
    assert_eq!(*host.inserts.borrow(), 0);
    assert_eq!(*host.published.borrow(), vec![other.to_owned()]);
}

#[test]
fn manual_sync_makes_a_new_request_when_nothing_matching_is_waiting() {
    let finished = json!({"id":"22222222-2222-4222-8222-222222222222",
        "checkpoint":{"workerResult":{"ingested":1,"skipped":0,"errors":0}}});
    let elsewhere = json!({"id":"33333333-3333-4333-8333-333333333333",
        "checkpoint":{"sourcePath":"/elsewhere"}});
    let continuation = json!({"id":"44444444-4444-4444-8444-444444444444",
        "checkpoint":{"sourcePath":"/notes","filePath":"b.md","chunkOffset":0,"fileHash":"h"}});
    for rows in [json!([]), json!([finished, elsewhere, continuation])] {
        let (out, host) = manual(rows);
        assert_eq!(out, json!({"status":202,"body":{"jobId":ID}}));
        assert_eq!(*host.inserts.borrow(), 1);
        assert_eq!(*host.published.borrow(), vec![ID.to_owned()]);
    }
}
