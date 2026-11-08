use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::cell::RefCell;

struct Database {
    calls: RefCell<Vec<Value>>,
    fail: bool,
}
impl Host for Database {
    fn call(&self, port: &str, operation: &str, table: &str, query: Value) -> Result<Value> {
        assert_eq!((port, operation), ("db", "query"));
        self.calls.borrow_mut().push(query.clone());
        if self.fail {
            return Err(Error::new("Database unavailable"));
        }
        if table != "app.notes_managed_actors" {
            return Ok(json!([]));
        }
        let offset = query["offset"].as_u64().unwrap();
        let count = if offset == 0 { 100 } else { 1 };
        Ok(Value::Array(
            (offset..offset + count)
                .map(|n| {
                    json!({
                        "owner_user_id":format!("actor-{n}"), "generation":n,
                        "state":"active", "operation_id":null,
                        "updated_at":"must not be exported", "unexpected":"must not be exported"
                    })
                })
                .collect(),
        ))
    }
}
fn database() -> Database {
    Database {
        calls: RefCell::new(vec![]),
        fail: false,
    }
}
const REQUEST: &str = r#"{"name":"collectManagedNotesExportSection","parameters":{}}"#;

#[test]
fn export_reads_past_the_first_page_and_keeps_the_legacy_projection() {
    let db = database();
    let output: Value = serde_json::from_str(&handle(&db, "api", REQUEST).unwrap()).unwrap();
    assert_eq!(output.as_object().unwrap().len(), 6);
    assert_eq!(output["actors"].as_array().unwrap().len(), 101);
    assert_eq!(
        output["actors"][100],
        json!({"ownerUserId":"actor-100", "generation":100,"state":"active","operationId":null})
    );
    assert_eq!(db.calls.borrow()[1]["offset"], 100);
    for section in [
        "sources",
        "bindings",
        "contributions",
        "proposals",
        "operations",
    ] {
        assert_eq!(output[section], json!([]));
    }
}
#[test]
fn caller_cannot_choose_an_actor_table_or_query() {
    let db = database();
    for payload in [
        r#"{"name":"collectManagedNotesExportSection","parameters":{"actorUserId":"someone"}}"#,
        r#"{"name":"collectManagedNotesExportSection","parameters":{},"actorUserId":"someone"}"#,
        r#"{"name":"collectManagedNotesExportSection","parameters":{"table":"app.users"}}"#,
        r#"{"name":"collectManagedNotesExportSection","parameters":{"query":{"type":"all"}}}"#,
        r#"{"name":"unknown","parameters":{}}"#,
    ] {
        assert!(handle(&db, "api", payload).is_err());
    }
    assert!(db.calls.borrow().is_empty());
}
#[test]
fn failure_returns_no_partial_export_and_lifecycle_needs_no_host_service() {
    let db = Database {
        fail: true,
        ..database()
    };
    assert!(handle(&db, "api", REQUEST).is_err());
    assert_eq!(handle(&db, "health", "").unwrap(), "{}");
    assert_eq!(handle(&db, "install", "").unwrap(), "{}");
    assert!(handle(&db, "route", "{}").is_err());
}
