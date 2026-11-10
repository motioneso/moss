//! Publication recovery only: core indexing and queue delivery are not exercised.
use moss_module_sdk::{
    query::{Compare, Filter, Query},
    Host, Result,
};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Recovery {
    rows: Vec<Value>,
    jobs: RefCell<Vec<Value>>,
}
impl Host for Recovery {
    fn call(&self, port: &str, op: &str, resource: &str, p: Value) -> Result<Value> {
        Ok(match (port, op) {
            ("db", "query") => {
                assert_eq!(resource, "app.notes_sync_checkpoints");
                let query: Query = serde_json::from_value(p).unwrap();
                assert_eq!(query.limit, Some(25));
                assert_eq!(query.order.len(), 1);
                assert_eq!(query.order[0].column, "id");
                assert!(!query.order[0].descending);
                let after = match query.filter {
                    Filter::All => String::new(),
                    Filter::Compare {
                        column,
                        op: Compare::Gt,
                        value,
                    } => {
                        assert_eq!(column, "id");
                        value.as_str().unwrap().to_owned()
                    }
                    filter => panic!("Unexpected recovery filter: {filter:?}"),
                };
                json!(self
                    .rows
                    .iter()
                    .filter(|r| r["id"].as_str().unwrap() > after.as_str())
                    .take(25)
                    .collect::<Vec<_>>())
            }
            ("context", "read") => json!({"now":"2026-11-09T00:00:00Z"}),
            ("jobs", "enqueue-after-commit") => {
                assert_eq!(resource, "notes.sync");
                assert_eq!(p["params"].as_object().unwrap().len(), 1);
                assert_eq!(p["params"]["checkpoint-id"], p["idempotencyKey"]);
                self.jobs.borrow_mut().push(p);
                json!({"deferred":true})
            }
            _ => panic!("Recovery touched unexpected port: {port} {op}"),
        })
    }
}
fn call(host: &impl Host, p: Value) -> Result<Value> {
    crate::handle(
        host,
        "api",
        &json!({"name":"recoverNotesSync","parameters":p}).to_string(),
    )
    .map(|out| serde_json::from_str(&out).unwrap())
}
#[test]
fn recovers_unpublished_requests_in_bounded_pages_without_private_output() {
    let host = Recovery {
        rows: (1..=52).map(|n| json!({
            "id":format!("00000000-0000-4000-8000-{n:012x}"),
            "checkpoint":if n % 2 == 0 { json!({"workerResult":{"ingested":1,"skipped":0,"errors":0}}) }
                else { json!({"filePath":"/private/note.md","expectedFileHash":"private hash"}) }
        })).collect(),
        jobs: RefCell::new(vec![]),
    };
    let mut p = json!({});
    for (scanned, published) in [(25, 13), (25, 12), (2, 1)] {
        let out = call(&host, p).unwrap();
        assert_eq!(out["scanned"], scanned);
        assert_eq!(out["requested"], published);
        assert!(!out.to_string().contains("private"));
        p = json!({"after":out["nextCursor"]});
    }
    assert_eq!(p, json!({"after":null}));
    assert_eq!(host.jobs.borrow().len(), 26);
    let first = host.jobs.borrow()[0].clone();
    call(&host, json!({})).unwrap();
    assert_eq!(
        host.jobs.borrow()[26],
        first,
        "Retry must reuse the queue identity"
    );
}
#[test]
fn recovery_refuses_caller_selected_account_and_invalid_cursor_before_host_access() {
    struct Deny;
    impl Host for Deny {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
            panic!("Invalid recovery request reached a port")
        }
    }
    for p in [
        json!({"after":"private/path"}),
        json!({"actorUserId":"other"}),
        json!({"limit":10000}),
        json!({"sourcePath":"private"}),
    ] {
        assert!(call(&Deny, p).is_err());
    }
}

#[test]
fn publication_refusal_returns_no_cursor_and_retry_reuses_ids() {
    struct Refuse<'a>(&'a Recovery);
    impl Host for Refuse<'_> {
        fn call(&self, port: &str, op: &str, resource: &str, p: Value) -> Result<Value> {
            if port == "jobs" {
                return Err(moss_module_sdk::Error::new("Synthetic refusal"));
            }
            self.0.call(port, op, resource, p)
        }
    }
    let host = Recovery {
        rows: vec![json!({"id":"00000000-0000-4000-8000-000000000001", "checkpoint":{}})],
        jobs: RefCell::new(vec![]),
    };
    assert!(call(&Refuse(&host), json!({})).is_err());
    assert!(host.jobs.borrow().is_empty());
    assert_eq!(
        call(&host, json!({})).unwrap(),
        json!({"scanned":1,"requested":1,"nextCursor":null})
    );
    assert_eq!(
        host.jobs.borrow()[0]["params"]["checkpoint-id"],
        host.rows[0]["id"]
    );
}

#[test]
fn tick_republishes_unfinished_and_deletes_only_old_finished_checkpoints() {
    const NEW: &str = "00000000-0000-4000-8000-0000000000ff";
    struct Tick {
        old: Vec<Value>,
        jobs: RefCell<Vec<Value>>,
        deleted: RefCell<Vec<Value>>,
    }
    impl Host for Tick {
        fn call(&self, port: &str, op: &str, _: &str, p: Value) -> Result<Value> {
            Ok(match (port, op) {
                ("context", "read") => json!({"now":"2026-11-10T08:00:00Z"}),
                ("context", "uuid") => json!({"id":NEW}),
                ("vault", "folder.get") => json!({"status":200,"body":"/notes"}),
                ("jobs", "schedule") => json!({"id":NEW}),
                ("jobs", "enqueue-after-commit") => {
                    self.jobs.borrow_mut().push(p);
                    json!({"deferred":true})
                }
                ("db", "query") => match p["kind"].as_str().unwrap() {
                    "delete" => {
                        self.deleted.borrow_mut().push(p["filter"]["value"].clone());
                        json!([])
                    }
                    "insert" => json!([p["values"]]),
                    _ if p["filter"]["column"] == "created_at" => {
                        assert_eq!(p["filter"]["value"], "2026-11-03T00:00:00Z");
                        json!(self.old)
                    }
                    _ => json!(self.old),
                },
                _ => panic!("unexpected {port}/{op}"),
            })
        }
    }
    let host = Tick {
        old: vec![
            json!({"id":"00000000-0000-4000-8000-000000000001","checkpoint":{"workerResult":{"ingested":1,"skipped":0,"errors":0}}}),
            json!({"id":"00000000-0000-4000-8000-000000000002","checkpoint":{"sourcePath":"/n"}}),
        ],
        jobs: RefCell::new(vec![]),
        deleted: RefCell::new(vec![]),
    };
    moss_notes::guest::handle(&host, "job", r#"{"queue":"notes.sync-tick","parameters":{}}"#)
        .unwrap();
    let ids: Vec<_> = host
        .jobs
        .borrow()
        .iter()
        .map(|j| j["params"]["checkpoint-id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, vec!["00000000-0000-4000-8000-000000000002", NEW]);
    assert_eq!(
        *host.deleted.borrow(),
        vec![json!("00000000-0000-4000-8000-000000000001")],
        "only the finished old row is deleted"
    );
}
