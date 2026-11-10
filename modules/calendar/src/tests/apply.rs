use moss_calendar::{apply, handle};
use moss_module_sdk::{query::Query, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;

const PLAN: &str = "11111111-1111-4111-8111-111111111111";
const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/// Small in-memory stand-in for the host's typed database port.
#[derive(Default)]
struct Mem {
    tables: RefCell<BTreeMap<String, Vec<Value>>>,
    next: RefCell<u32>,
    inserts: RefCell<u32>,
    /// Runs once when the plan's blocks are read, to model a draft save landing mid-reservation.
    on_blocks: RefCell<Option<Box<dyn FnOnce(&mut BTreeMap<String, Vec<Value>>)>>>,
}
fn matches(row: &Value, filter: &Value) -> bool {
    match filter["type"].as_str() {
        Some("and") => filter["filters"].as_array().unwrap().iter().all(|f| matches(row, f)),
        Some("compare") => row[filter["column"].as_str().unwrap()] == filter["value"],
        _ => true,
    }
}
impl Host for Mem {
    fn call(&self, port: &str, op: &str, resource: &str, body: Value) -> Result<Value> {
        if port == "context" {
            let mut n = self.next.borrow_mut();
            *n += 1;
            return Ok(json!({"id": format!("00000000-0000-4000-8000-{:012}", *n)}));
        }
        assert_eq!((port, op), ("db", "query"));
        let q: Query = serde_json::from_value(body).unwrap();
        if resource == "app.day_plan_blocks" {
            if let Some(hook) = self.on_blocks.borrow_mut().take() {
                hook(&mut self.tables.borrow_mut());
            }
        }
        let mut tables = self.tables.borrow_mut();
        let rows = tables.entry(resource.to_owned()).or_default();
        let filter = serde_json::to_value(&q.filter).unwrap();
        match serde_json::to_value(&q.kind).unwrap().as_str().unwrap() {
            "select" => Ok(Value::Array(rows.iter().filter(|r| matches(r, &filter)).cloned().collect())),
            "insert" => {
                let row = Value::Object(q.values.into_iter().collect());
                let dup = rows.iter().any(|r| {
                    r["id"] == row["id"]
                        || (resource.ends_with("operations")
                            && r["plan_id"] == row["plan_id"]
                            && r["idempotency_key"] == row["idempotency_key"])
                        || (resource.ends_with("items")
                            && r["operation_id"] == row["operation_id"]
                            && r["block_id"] == row["block_id"])
                });
                if dup {
                    return Ok(json!([]));
                }
                *self.inserts.borrow_mut() += 1;
                rows.push(row.clone());
                Ok(json!([row]))
            }
            other => panic!("unexpected {other}"),
        }
    }
}
fn host() -> Mem {
    let m = Mem::default();
    m.tables.borrow_mut().insert(
        "app.day_plans".into(),
        vec![json!({"id":PLAN,"revision":3,"local_day":"2026-11-10","time_zone":"UTC"})],
    );
    m.tables.borrow_mut().insert(
        "app.day_plan_blocks".into(),
        vec![
            json!({"id":A,"plan_id":PLAN,"position":0,"kind":"task","title":"a","task_id":null,"actual_placement":null,
                "pending_change":{"kind":"add","startsAt":"2026-11-10T09:00:00Z","durationMinutes":30}}),
            json!({"id":B,"plan_id":PLAN,"position":1,"kind":"task","title":"b","task_id":null,"actual_placement":null,
                "pending_change":{"kind":"remove"}}),
            json!({"id":C,"plan_id":PLAN,"position":2,"kind":"task","title":"c","task_id":null,"actual_placement":null,
                "pending_change":null}),
        ],
    );
    m
}
fn request(key: &str, revision: i64, ids: Option<Vec<&str>>) -> apply::Request {
    serde_json::from_value(json!({"expectedRevision":revision,"idempotencyKey":key,"selectedBlockIds":ids})).unwrap()
}

#[test]
fn reserves_pending_additions_plus_the_explicit_selection_in_plan_order() {
    let h = host();
    let out = apply::reserve(&h, PLAN, request(" k1 ", 3, Some(vec![B]))).unwrap();
    assert_eq!(out["idempotencyKey"], "k1");
    assert_eq!(out["outcome"], "pending");
    let ids: Vec<_> = out["selection"].as_array().unwrap().iter().map(|e| e["blockId"].as_str().unwrap()).collect();
    assert_eq!(ids, [A, B]);
    assert_eq!(out["selection"][1], json!({"blockId":B,"kind":"remove","startsAt":null,"durationMinutes":null}));
    assert_eq!(out["items"].as_array().unwrap().len(), 2);
    assert_eq!(out["items"][0]["outcome"], "pending");
}

#[test]
fn exact_replay_returns_the_stored_batch_after_the_revision_moves() {
    let h = host();
    let first = apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap();
    h.tables.borrow_mut().get_mut("app.day_plans").unwrap()[0]["revision"] = json!(4);
    let writes = *h.inserts.borrow();
    let again = apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap();
    assert_eq!(first, again);
    assert_eq!(*h.inserts.borrow(), writes, "replay writes nothing");
}

#[test]
fn replay_repairs_a_batch_whose_items_were_never_written() {
    let h = host();
    let first = apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap();
    h.tables.borrow_mut().get_mut("app.day_plan_operation_items").unwrap().clear();
    let again = apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap();
    assert_eq!(again["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["selection"], again["selection"]);
}

#[test]
fn a_changed_request_under_the_same_key_conflicts() {
    let h = host();
    apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap();
    for bad in [request("k1", 2, None), request("k1", 3, Some(vec![B]))] {
        assert_eq!(apply::reserve(&h, PLAN, bad).unwrap_err().status, 409);
    }
}

#[test]
fn new_key_on_a_stale_revision_conflicts_and_writes_nothing() {
    let h = host();
    assert_eq!(apply::reserve(&h, PLAN, request("k2", 2, None)).unwrap_err().status, 409);
    assert_eq!(*h.inserts.borrow(), 0);
}

#[test]
fn bad_selections_and_inputs_are_rejected_before_any_write() {
    let h = host();
    let unknown = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    for (req, status) in [
        (request("k", 3, Some(vec![unknown])), 400),
        (request("k", 3, Some(vec![C])), 400),
        (request("  ", 3, None), 400),
        (request("k", 0, None), 400),
    ] {
        assert_eq!(apply::reserve(&h, PLAN, req).unwrap_err().status, status);
    }
    let none = host();
    none.tables.borrow_mut().get_mut("app.day_plan_blocks").unwrap().truncate(0);
    assert_eq!(apply::reserve(&none, PLAN, request("k", 3, None)).unwrap_err().message, "no pending changes to reserve");
    assert_eq!(*h.inserts.borrow(), 0);
    let missing = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    assert_eq!(apply::reserve(&h, missing, request("k", 3, None)).unwrap_err().status, 404);
}

#[test]
fn the_route_validates_then_fails_closed_without_writing() {
    let h = host();
    let call = |id: &str, body: Value| {
        handle(&h, "route", &json!({"method":"POST","path":"/day-plans/:id/apply","params":{"id":id},"query":{},"body":body}).to_string())
    };
    let ok = json!({"expectedRevision":3,"idempotencyKey":"k"});
    assert!(call(PLAN, ok.clone()).unwrap().contains("\"status\":503"), "{:?}", call(PLAN, ok));
    for body in [
        json!({"expectedRevision":3}),
        json!({"expectedRevision":3,"idempotencyKey":"k","extra":1}),
        json!({"expectedRevision":3,"idempotencyKey":"k","selectedBlockIds":["nope"]}),
    ] {
        assert!(call(PLAN, body).unwrap().contains("\"status\":400"));
    }
    assert!(call("nope", json!({"expectedRevision":3,"idempotencyKey":"k"})).unwrap().contains("\"status\":400"));
    assert_eq!(*h.inserts.borrow(), 0);
}

#[test]
fn a_draft_save_during_reservation_conflicts_instead_of_freezing_the_newer_draft() {
    let h = host();
    *h.on_blocks.borrow_mut() = Some(Box::new(|tables| {
        tables.get_mut("app.day_plans").unwrap()[0]["revision"] = json!(4);
    }));
    assert_eq!(apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap_err().status, 409);
    assert_eq!(*h.inserts.borrow(), 0);
}

#[test]
fn replay_after_a_selected_block_is_deleted_returns_the_stored_batch_without_new_writes() {
    let h = host();
    let first = apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap();
    {
        let mut tables = h.tables.borrow_mut();
        tables.get_mut("app.day_plan_blocks").unwrap().retain(|b| b["id"] != A);
        tables.get_mut("app.day_plan_operation_items").unwrap()[0]["block_id"] = Value::Null;
    }
    let writes = *h.inserts.borrow();
    let again = apply::reserve(&h, PLAN, request("k1", 3, None)).unwrap();
    assert_eq!(*h.inserts.borrow(), writes);
    assert_eq!(first["selection"], again["selection"]);
    assert_eq!(again["items"][0]["blockId"], Value::Null);
}

#[test]
fn the_route_rejects_null_or_repeated_selections_and_empty_operation_keys() {
    let h = host();
    let call = |body: Value| {
        handle(&h, "route", &json!({"method":"POST","path":"/day-plans/:id/apply","params":{"id":PLAN},"query":{},"body":body}).to_string()).unwrap()
    };
    for extra in [json!({"selectedBlockIds":null}), json!({"selectedBlockIds":[A,A]}), json!({"operationKey":""})] {
        let mut body = json!({"expectedRevision":3,"idempotencyKey":"k"});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(call(body).contains("\"status\":400"));
    }
    assert!(call(json!({"expectedRevision":3,"idempotencyKey":"k","operationKey":null})).contains("\"status\":503"));
}

#[test]
fn retry_recover_and_confirm_validate_then_fail_closed() {
    let h = host();
    let op = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let call = |action: &str, plan: &str, operation: &str, body: Value| {
        handle(&h, "route", &json!({"method":"POST","path":format!("/day-plans/:id/operations/:operation_id/{action}"),"params":{"id":plan,"operation_id":operation},"query":{},"body":body}).to_string()).unwrap()
    };
    let closed = "\"status\":503";
    assert!(call("retry", PLAN, op, json!({"itemIds":[A,B]})).contains(closed));
    assert!(call("recover", PLAN, op, Value::Null).contains(closed));
    assert!(call("recover", PLAN, op, json!({})).contains(closed));
    assert!(call("confirm", PLAN, op, json!({"approvalId":A})).contains(closed));
    let bad = "\"status\":400";
    for body in [json!({}), json!({"itemIds":[]}), json!({"itemIds":["no"]}), json!({"itemIds":[A,A]}), json!({"itemIds":[A],"x":1}), json!([])] {
        assert!(call("retry", PLAN, op, body.clone()).contains(bad), "{body}");
    }
    assert!(call("recover", PLAN, op, json!({"x":1})).contains(bad));
    assert!(call("recover", PLAN, op, json!([])).contains(bad));
    for body in [json!({}), json!({"approvalId":" "}), json!({"approvalId":A,"y":1}), json!({"approvalId":"x"})] {
        assert!(call("confirm", PLAN, op, body.clone()).contains(bad), "{body}");
    }
    assert!(call("retry", "nope", op, json!({"itemIds":[A]})).contains(bad));
    assert!(call("confirm", PLAN, "nope", json!({"approvalId":A})).contains(bad));
    assert_eq!(*h.inserts.borrow(), 0);
}
