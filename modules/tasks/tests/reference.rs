//! Public `getTaskReference`: the small task fact other modules may read.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

const TASK: &str = "11111111-1111-4111-8111-111111111111";

struct Rows;
impl Host for Rows {
    fn call(&self, port: &str, operation: &str, table: &str, query: Value) -> Result<Value> {
        assert_eq!((port, operation, table), ("db", "query", "app.tasks"));
        let stamp = "2026-11-08T00:00:00.000Z";
        if !query.to_string().contains(TASK) {
            return Ok(json!([]));
        }
        Ok(json!([{"id":TASK,"owner_user_id":"o","list_id":"l","parent_task_id":null,
            "title":"Secret title","description":"Secret body","status":"todo","priority":null,
            "position":0,"due_at":"2026-11-09T10:00:00.000Z","do_at":null,"effort":null,
            "source":"user","source_ref":null,"completed_at":null,"created_at":stamp,
            "updated_at":stamp,"suggestion_metadata":null,"recurrence":null,
            "recurrence_series_id":null}]))
    }
}

fn call(id: &str) -> moss_module_sdk::Result<String> {
    let request = json!({"name":"getTaskReference","parameters":{"id":id}});
    moss_tasks_module::handle(&Rows, "api", &request.to_string())
}

#[test]
fn reference_carries_only_id_owner_status_and_due() {
    let out: Value = serde_json::from_str(&call(TASK).unwrap()).unwrap();
    assert_eq!(
        out,
        json!({"task":{"id":TASK,"ownerUserId":"o","status":"todo","dueAt":"2026-11-09T10:00:00.000Z"}})
    );
}

#[test]
fn a_task_the_caller_cannot_see_reads_as_absent() {
    let out: Value =
        serde_json::from_str(&call("99999999-9999-4999-8999-999999999999").unwrap()).unwrap();
    assert_eq!(out, json!({"task":null}));
}
