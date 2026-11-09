use moss_calendar::handle;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

const PLAN: &str = "11111111-1111-4111-8111-111111111111";
const OP: &str = "22222222-2222-4222-8222-222222222222";
struct Scoped {
    rows: RefCell<Vec<Value>>,
}
impl Host for Scoped {
    fn call(&self, port: &str, operation: &str, _: &str, body: Value) -> Result<Value> {
        assert_eq!((port, operation), ("db", "query"));
        assert_eq!(
            body["kind"], "select",
            "status must never mutate saved work"
        );
        Ok(self.rows.borrow_mut().remove(0))
    }
}
fn read(host: &Scoped, plan: &str, operation: &str) -> Value {
    serde_json::from_str(
        &handle(
            host,
            "route",
            &json!({
                "method":"GET", "path":"/day-plans/:id/operations/:operation_id",
                "params":{"id":plan,"operation_id":operation}, "query":{}, "body":null
            })
            .to_string(),
        )
        .unwrap(),
    )
    .unwrap()
}
fn item(block: &str, outcome: &str, result: Value) -> Value {
    json!({"id":format!("item-{block}"),"block_id":block,"kind":"remove",
        "pending_change":{"blockId":block,"kind":"remove"},"outcome":outcome,"result":result})
}
#[test]
fn status_preserves_selection_order_and_reports_denial_without_writing() {
    let host = Scoped {
        rows: RefCell::new(vec![
            json!([{"id":OP,"plan_id":PLAN,"kind":"apply", "selection_snapshot":{
            "intent":[],"selection":[{"blockId":"second","kind":"remove"},{"blockId":"first","kind":"remove"}]}}]),
            json!([
                item(
                    "first",
                    "failed",
                    json!({"status":"failed","reason":"access-denied"})
                ),
                item(
                    "second",
                    "unknown",
                    json!({"status":"unknown","reason":"unknown"})
                )
            ]),
        ]),
    };
    let out = read(&host, PLAN, OP);
    assert_eq!(
        out["status"], 200,
        "installed status route must be available"
    );
    assert_eq!(out["body"]["status"], "pending");
    assert_eq!(out["body"]["items"][0]["blockId"], "second");
    assert!(out["body"]["denial"].is_object());
    assert!(host.rows.borrow().is_empty());
}
#[test]
fn invisible_operation_is_not_found_and_never_reads_items() {
    let host = Scoped {
        rows: RefCell::new(vec![json!([])]),
    };
    let out = read(&host, PLAN, OP);
    assert_eq!(out["status"], 404);
    assert_eq!(
        out["body"]["error"],
        "day plan apply operation is not available"
    );
    assert!(
        host.rows.borrow().is_empty(),
        "scoped header lookup must run"
    );
}
#[test]
fn malformed_ids_are_rejected_before_host_access() {
    let host = Scoped {
        rows: RefCell::new(vec![]),
    };
    assert_eq!(read(&host, "bad", OP)["status"], 400);
    assert_eq!(read(&host, PLAN, "bad")["status"], 400);
}

#[test]
fn empty_batch_is_completed_and_nonbatch_header_is_hidden() {
    let host = Scoped {
        rows: RefCell::new(vec![
            json!([{"id":OP,"plan_id":PLAN,"kind":"apply","selection_snapshot":[]}]),
            json!([]),
        ]),
    };
    assert_eq!(
        read(&host, PLAN, OP)["body"],
        json!({"operationId":OP,"planId":PLAN,"status":"completed","items":[]})
    );
    let host = Scoped {
        rows: RefCell::new(vec![json!([{"kind":"remove"}])]),
    };
    assert_eq!(read(&host, PLAN, OP)["status"], 404);
}
#[test]
fn unreadable_snapshot_and_result_do_not_return_partial_status() {
    for snapshot in [
        json!(null),
        json!({"selection":[]}),
        json!([{"kind":"remove"}]),
    ] {
        let host = Scoped {
            rows: RefCell::new(vec![
                json!([{"id":OP,"kind":"apply","selection_snapshot":snapshot}]),
            ]),
        };
        assert_eq!(read(&host, PLAN, OP)["status"], 500);
    }
    let host = Scoped {
        rows: RefCell::new(vec![
            json!([{"id":OP,"kind":"apply","selection_snapshot":[]}]),
            json!([item("b", "applied", json!({"status":"applied"}))]),
        ]),
    };
    assert_eq!(read(&host, PLAN, OP)["status"], 500);
}
#[test]
fn all_pages_are_read() {
    let result = json!({"status":"failed","reason":"access-denied"});
    let rows: Vec<Value> = (0..1000)
        .map(|i| item(&i.to_string(), "pending", Value::Null))
        .collect();
    let host = Scoped {
        rows: RefCell::new(vec![
            json!([{"id":OP,"plan_id":PLAN,"kind":"apply","selection_snapshot":[]}]),
            json!(rows),
            json!([item("last", "failed", result)]),
        ]),
    };
    let out = read(&host, PLAN, OP);
    assert_eq!(out["status"], 200);
    let items = out["body"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1001);
    assert!(host.rows.borrow().is_empty());
}

#[test]
fn response_schema_rejects_result_extensions_and_unknown_reasons() {
    for result in [
        json!({"status":"failed","reason":"access-denied","privateDetail":"reject"}),
        json!({"status":"unknown","reason":"timeout"}),
        json!({"status":"failed","reason":"access-denied","removed":"yes"}),
    ] {
        let host = Scoped {
            rows: RefCell::new(vec![
                json!([{"id":OP,"plan_id":PLAN,"kind":"apply","selection_snapshot":[]}]),
                json!([item("block", "failed", result)]),
            ]),
        };
        assert_eq!(read(&host, PLAN, OP)["status"], 500);
    }
}
