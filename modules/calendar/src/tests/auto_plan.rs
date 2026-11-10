use moss_calendar::{auto_plan, plans};
use moss_module_sdk::{query::Query, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;

const RUN: &str = "99999999-9999-4999-8999-999999999999";
const ACTOR: &str = "22222222-2222-4222-8222-222222222222";

/// In-memory stand-in for the host's typed database port.
#[derive(Default)]
struct Mem {
    tables: RefCell<BTreeMap<String, Vec<Value>>>,
    next: RefCell<u32>,
    /// Runs once when the plan's blocks are first read, to model a draft save landing mid-run.
    on_blocks: RefCell<Option<Box<dyn FnOnce(&mut BTreeMap<String, Vec<Value>>)>>>,
}
fn matches(row: &Value, filter: &Value) -> bool {
    match filter["type"].as_str() {
        Some("and") => filter["filters"].as_array().unwrap().iter().all(|f| matches(row, f)),
        Some("compare") => row[filter["column"].as_str().unwrap()] == filter["value"],
        Some("in") => filter["values"].as_array().unwrap().contains(&row[filter["column"].as_str().unwrap()]),
        _ => true,
    }
}
impl Host for Mem {
    fn call(&self, port: &str, op: &str, resource: &str, body: Value) -> Result<Value> {
        if port == "context" {
            let mut n = self.next.borrow_mut();
            *n += 1;
            return Ok(json!({"id": format!("00000000-0000-4000-8000-{:012}", *n), "actorUserId": ACTOR, "now": "2026-11-10T08:00:00Z"}));
        }
        if port == "kv" {
            return Ok(json!({"run": {"id": RUN, "ownerUserId": ACTOR}}));
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
                let mut row = Value::Object(q.values.into_iter().collect());
                if row["id"].is_null() {
                    row["id"] = json!(format!("00000000-0000-4000-8000-{:012}", 1000 + rows.len()));
                }
                let dup = rows.iter().any(|r| {
                    r["id"] == row["id"]
                        || (resource.ends_with("plans") && r["local_day"] == row["local_day"] && r["time_zone"] == row["time_zone"])
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
                rows.push(row.clone());
                Ok(json!([row]))
            }
            "update" => {
                let mut out = vec![];
                for row in rows.iter_mut().filter(|r| matches(r, &filter)) {
                    for (k, v) in &q.values {
                        row[k] = v.clone();
                    }
                    out.push(row.clone());
                }
                Ok(Value::Array(out))
            }
            other => panic!("unexpected {other}"),
        }
    }
}

fn input(signals: Value) -> auto_plan::Input {
    serde_json::from_value(json!({
        "runId": RUN, "definitionId": "def-1", "localDay": "2026-11-10", "timeZone": "UTC", "signals": signals,
    }))
    .unwrap()
}
fn block_signal(target: &str, task: Option<&str>) -> Value {
    json!({"type":"prep_needed","summary":"Prep for review","suggestedActions":[],
        "followThrough":{"targetRef":target,"taskId":task,"intents":[
            {"kind":"block_time","targetRef":target,"title":"t",
             "window":{"start":"2026-11-10T09:00:00.000Z","end":"2026-11-10T09:30:00.000Z","durationMinutes":30}}]}})
}
fn suggest_signal(kind: &str, start: &str, end: Option<&str>) -> Value {
    json!({"type":kind,"summary":"Think","suggestedActions":["suggest_time_block"],"startsAt":start,"endsAt":end})
}
fn legacy_event(id: &str, target: &str) -> Value {
    json!({"id":id,"external_id":format!("ext-{id}"),"starts_at":"2026-11-10T09:00:00Z","ends_at":"2026-11-10T09:45:00Z",
        "external_metadata":{"jarvisCreated":true,"followThroughTargetRef":target}})
}
fn count(h: &Mem, table: &str) -> usize {
    h.tables.borrow().get(table).map_or(0, Vec::len)
}

#[test]
fn block_id_matches_the_original_digest() {
    assert_eq!(auto_plan::block_id("def-1", "2026-11-10", "ref-a"), "1d9dbc0e-f084-47c5-80fb-605166cc572f");
    assert_eq!(auto_plan::batch_key("r1"), "day-plan-auto:r1");
}

#[test]
fn nothing_planned_returns_null_and_writes_nothing() {
    let h = Mem::default();
    let out = auto_plan::reserve(&h, input(json!([{"summary":"x","suggestedActions":[]}]))).unwrap();
    assert!(out.is_null());
    assert_eq!(count(&h, "app.day_plans"), 0);
}

#[test]
fn automatic_blocks_reserve_one_batch_and_suggestions_stay_proposals() {
    let h = Mem::default();
    let signals = json!([block_signal("ref-a", None), suggest_signal("conflict", "2026-11-10T14:00:00Z", Some("2026-11-10T18:00:00Z"))]);
    let out = auto_plan::reserve(&h, input(signals)).unwrap();
    let auto_id = auto_plan::block_id("def-1", "2026-11-10", "ref-a");
    assert_eq!(out["autoBlockIds"], json!([auto_id]));
    assert_eq!(out["suggestBlockIds"].as_array().unwrap().len(), 1);
    assert_eq!(out["batchKey"], format!("day-plan-auto:{RUN}"));
    assert!(out["operationId"].is_string());
    assert_eq!(out["revisionRace"], false);
    // The batch holds only the automatic block; the suggestion has no item.
    let items = h.tables.borrow()["app.day_plan_operation_items"].clone();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["block_id"], auto_id);
    // Suggestion window is capped to 120 minutes and kept pending.
    let blocks = h.tables.borrow()["app.day_plan_blocks"].clone();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[1]["pending_change"], json!({"kind":"add","startsAt":"2026-11-10T14:00:00.000Z","durationMinutes":120}));
    assert_eq!(h.tables.borrow()["app.day_plans"][0]["revision"], 2);
}

#[test]
fn prep_suggestion_takes_the_hour_before_and_unusable_windows_are_skipped() {
    let h = Mem::default();
    let signals = json!([
        suggest_signal("prep_needed", "2026-11-10T15:00:00Z", None),
        suggest_signal("conflict", "2026-11-10T15:00:00Z", Some("2026-11-10T15:00:00Z")),
        suggest_signal("conflict", "nope", Some("2026-11-10T16:00:00Z")),
    ]);
    let out = auto_plan::reserve(&h, input(signals)).unwrap();
    assert_eq!(out["suggestBlockIds"].as_array().unwrap().len(), 1);
    assert_eq!(out["autoBlockIds"], json!([]));
    assert!(out["operationId"].is_null());
    let blocks = h.tables.borrow()["app.day_plan_blocks"].clone();
    assert_eq!(blocks[0]["pending_change"], json!({"kind":"add","startsAt":"2026-11-10T14:00:00.000Z","durationMinutes":60}));
    assert_eq!(count(&h, "app.day_plan_operations"), 0);
}

#[test]
fn a_duplicate_fire_converges_without_a_second_batch() {
    let h = Mem::default();
    auto_plan::reserve(&h, input(json!([block_signal("ref-a", None)]))).unwrap();
    let again = auto_plan::reserve(&h, input(json!([block_signal("ref-a", None)]))).unwrap();
    assert_eq!(again["autoBlockIds"], json!([]));
    assert!(again["operationId"].is_null());
    assert_eq!(count(&h, "app.day_plan_blocks"), 1);
    assert_eq!(count(&h, "app.day_plan_operations"), 1);
}

#[test]
fn one_legacy_event_links_the_block_as_placed_with_no_reservation() {
    let h = Mem::default();
    h.tables.borrow_mut().insert("app.calendar_events".into(), vec![legacy_event("e1", "ref-a")]);
    let out = auto_plan::reserve(&h, input(json!([block_signal("ref-a", None)]))).unwrap();
    assert!(out["operationId"].is_null());
    assert_eq!(out["autoBlockIds"], json!([]));
    let block = h.tables.borrow()["app.day_plan_blocks"][0].clone();
    assert_eq!(block["pending_change"], Value::Null);
    assert_eq!(block["actual_placement"], json!({"startsAt":"2026-11-10T09:00:00.000Z","durationMinutes":45.0,"calendarEventRef":"ext-e1"}));
    assert_eq!(count(&h, "app.day_plan_operations"), 0);
}

#[test]
fn ambiguous_targets_are_dropped_while_other_targets_proceed() {
    let h = Mem::default();
    h.tables.borrow_mut().insert(
        "app.calendar_events".into(),
        vec![legacy_event("e1", "ref-a"), legacy_event("e2", "ref-a"), json!({"id":"e3","external_metadata":{"followThroughTargetRef":"ref-b"}})],
    );
    let signals = json!([block_signal("ref-a", None), block_signal("ref-b", None)]);
    let out = auto_plan::reserve(&h, input(signals)).unwrap();
    // ref-b's event is not Moss-created, so it does not link; ref-a is ambiguous and left alone.
    assert_eq!(out["autoBlockIds"], json!([auto_plan::block_id("def-1", "2026-11-10", "ref-b")]));
    assert_eq!(count(&h, "app.day_plan_blocks"), 1);
}

#[test]
fn a_draft_save_landing_mid_run_is_a_race_with_nothing_reserved() {
    let h = Mem::default();
    plans::create(&h, serde_json::from_value(json!({"localDay":"2026-11-10","timeZone":"UTC"})).unwrap()).unwrap();
    *h.on_blocks.borrow_mut() = Some(Box::new(|t| t.get_mut("app.day_plans").unwrap()[0]["revision"] = json!(5)));
    let out = auto_plan::reserve(&h, input(json!([block_signal("ref-a", None)]))).unwrap();
    assert_eq!(out["revisionRace"], true);
    assert!(out["operationId"].is_null());
    assert_eq!(count(&h, "app.day_plan_blocks"), 0);
    assert_eq!(count(&h, "app.day_plan_operations"), 0);
}

#[test]
fn an_unfinished_batch_is_found_until_every_item_settles() {
    let h = Mem::default();
    let out = auto_plan::reserve(&h, input(json!([block_signal("ref-a", None)]))).unwrap();
    let ask = || auto_plan::Unfinished { plan_id: out["planId"].as_str().unwrap().into(), batch_key: out["batchKey"].as_str().unwrap().into() };
    assert_eq!(auto_plan::find_unfinished(&h, ask()).unwrap()["operationId"], out["operationId"]);
    h.tables.borrow_mut().get_mut("app.day_plan_operation_items").unwrap()[0]["outcome"] = json!("succeeded");
    assert!(auto_plan::find_unfinished(&h, ask()).unwrap()["operationId"].is_null());
    let none = auto_plan::Unfinished { plan_id: out["planId"].as_str().unwrap().into(), batch_key: "day-plan-auto:other".into() };
    assert!(auto_plan::find_unfinished(&h, none).unwrap()["operationId"].is_null());
}
