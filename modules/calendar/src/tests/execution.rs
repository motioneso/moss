//! The apply routes against a scripted Connectors package, approvals store and
//! policy routes. Every provider answer is recorded, so each test can assert
//! not just the reply but exactly which provider and database effects ran.
use moss_calendar::{execution, handle};
use moss_module_sdk::{query::Query, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;

const PLAN: &str = "11111111-1111-4111-8111-111111111111";
const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/// Everything the scripted Connectors package holds: the provider events it
/// created, the answers it is told to give, and every call it saw.
#[derive(Default)]
struct Provider {
    /// The events the stand-in provider holds, by id.
    events: RefCell<BTreeMap<String, Value>>,
    /// Busy intervals the facts reads answer.
    busy: Vec<Value>,
    /// Refuse the next N creates with a filled window.
    refuse_next_create: std::cell::Cell<u32>,
    /// Fail the lookup call at this ordinal (1-based), for the unknown path.
    fail_lookup_number: std::cell::Cell<u32>,
    lookups: std::cell::Cell<u32>,
    calls: RefCell<Vec<(&'static str, Value)>>,
}

impl Provider {
    fn provenance(&self, params: &Value, actor: &str) -> Value {
        let p = &params["provenance"];
        json!({
            "jarvisCreated": "true", "jarvisTool": "applyAddition",
            "jarvisActorUserId": actor,
            "jarvisPlanId": p["jarvisPlanId"], "jarvisBlockId": p["jarvisBlockId"],
            "jarvisPlanRevision": p["jarvisPlanRevision"].to_string().replace("\"", ""),
            "jarvisOperationId": p["jarvisOperationId"],
        })
    }
}

/// The full host stand-in: the module tables, the approvals store, the policy
/// routes and the scripted Connectors package.
struct Script {
    tables: RefCell<BTreeMap<String, Vec<Value>>>,
    approvals: RefCell<Vec<Value>>,
    kv: RefCell<BTreeMap<String, Value>>,
    policy: RefCell<BTreeMap<String, String>>,
    provider: Provider,
    next: RefCell<u32>,
}

fn matches(row: &Value, filter: &Value) -> bool {
    match filter["type"].as_str() {
        Some("and") => filter["filters"].as_array().unwrap().iter().all(|f| matches(row, f)),
        Some("or") => filter["filters"].as_array().unwrap().iter().any(|f| matches(row, f)),
        Some("compare") => {
            let op = filter["op"].as_str().unwrap_or("eq");
            let (column, want) = (filter["column"].as_str().unwrap_or(""), &filter["value"]);
            match op {
                "eq" => row[column] == *want,
                "neq" => row[column] != *want,
                "gt" => row[column].as_i64() > want.as_i64(),
                "lt" => row[column].as_i64() < want.as_i64(),
                _ => row[column] == *want,
            }
        }
        Some("in") => filter["values"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|want| row[filter["column"].as_str().unwrap_or("")] == *want),
        Some("null") => {
            let null = row[filter["column"].as_str().unwrap_or("")].is_null();
            if filter["not"] == true { !null } else { null }
        }
        _ => true,
    }
}

impl Host for Script {
    fn call(&self, port: &str, op: &str, resource: &str, body: Value) -> Result<Value> {
        match (port, op, resource) {
            ("context", "read", "call") => {
                return Ok(json!({"actorUserId":"actor-1","now":"2026-11-10T08:00:00.000Z"}));
            }
            ("context", "uuid", "new") => {
                let mut n = self.next.borrow_mut();
                *n += 1;
                return Ok(json!({"id": format!("00000000-0000-4000-8000-{:012}", *n)}));
            }
            ("approvals", "create", "calendar.day-plan-changes") => {
                let n = self.approvals.borrow().len() + 1;
                let id = format!("cccccccc-cccc-4ccc-8ccc-cccccccccc{:02x}", n);
                let summary = body["inputSummary"].clone();
                self.approvals.borrow_mut().push(json!({
                    "id": id, "ownerUserId": "actor-1", "status": "pending", "inputSummary": summary,
                }));
                return Ok(json!({"id": id, "ownerUserId": "actor-1", "status": "pending", "inputSummary": summary}));
            }
            ("approvals", "get", "calendar.day-plan-changes") => {
                let id = body["id"].as_str().unwrap_or_default();
                let found = self
                    .approvals
                    .borrow()
                    .iter()
                    .find(|record| record["id"] == id && record["ownerUserId"] == "actor-1")
                    .cloned();
                return found.map_or_else(
                    || Err(moss_module_sdk::Error::new("Approval not found")),
                    |record| Ok(record),
                );
            }
            ("approvals", "confirm", "calendar.day-plan-changes") => {
                let id = body["id"].as_str().unwrap_or_default();
                let mut approvals = self.approvals.borrow_mut();
                let found = approvals
                    .iter_mut()
                    .find(|record| record["id"] == id && record["status"] == "pending");
                return match found {
                    None => Err(moss_module_sdk::Error::new("The approval is not pending")),
                    Some(record) => {
                        record["status"] = json!("confirmed");
                        Ok(record.clone())
                    }
                };
            }
            ("approvals", operation, "calendar.day-plan-changes") => {
                let status = if operation == "find-pending" { "pending" } else { "confirmed" };
                let operation_id = body["operationId"].as_str().unwrap_or_default();
                let found = self
                    .approvals
                    .borrow()
                    .iter()
                    .filter(|record| record["status"] == status)
                    .find(|record| {
                        record["inputSummary"]["operationId"].as_str() == Some(operation_id)
                    })
                    .cloned();
                return Ok(json!({"approval": found.unwrap_or(Value::Null)}));
            }
            ("action-policy", "route-read", family) => {
                let tier = self
                    .policy
                    .borrow()
                    .get(family)
                    .cloned()
                    .unwrap_or_else(|| "always_confirm".into());
                return Ok(json!({"tier": tier}));
            }
            ("action-policy", "route-write", family) => {
                let tier = body["tier"].as_str().unwrap_or("ask_each_time").to_owned();
                self.policy.borrow_mut().insert(family.to_string(), tier.clone());
                return Ok(json!({"tier": tier}));
            }
            ("kv", "get", key) => {
                return Ok(self.kv.borrow().get(key).cloned().unwrap_or(json!({})));
            }
            ("kv", "set", key) => {
                self.kv.borrow_mut().insert(key.to_string(), body.clone());
                return Ok(body);
            }
            ("api", "call", "connectors") => {
                let name = body["name"].as_str().unwrap_or_default().to_owned();
                let params = body["parameters"].clone();
                self.provider.calls.borrow_mut().push((
                    match name.as_str() {
                        "listCalendarContext" => "facts",
                        "createCalendarEvent" => "create",
                        "lookupCalendarEvent" => "lookup",
                        "rescheduleCalendarEvent" => "reschedule",
                        "deleteCalendarEvent" => "delete",
                        _ => "other",
                    },
                    params.clone(),
                ));
                return Ok(match name.as_str() {
                    "listCalendarContext" => json!({
                        "items": self.provider.busy, "accounts": [{"source": "live"}],
                        "gaps": [], "truncated": false, "asOf": "2026-11-10T08:00:00.000Z",
                    }),
                    "lookupCalendarEvent" => {
                        let ordinal = self.provider.lookups.get() + 1;
                        self.provider.lookups.set(ordinal);
                        if self.provider.fail_lookup_number.get() == ordinal {
                            return Err(moss_module_sdk::Error::new("Google could not be reached"));
                        }
                        let id = params["eventId"].as_str().unwrap_or_default();
                        let found = self.provider.events.borrow().get(id).cloned();
                        found.map_or(json!({"found": false}), |event| {
                            json!({"found": true, "id": id, "start": event["start"], "end": event["end"],
                                "provenance": event["provenance"], "attendeeCount": event["attendeeCount"]})
                        })
                    }
                    "createCalendarEvent" => {
                        if self.provider.refuse_next_create.get() > 0 {
                            self.provider.refuse_next_create.set(self.provider.refuse_next_create.get() - 1);
                            return Ok(json!({"created": false, "resolvedStart": params["windowStart"],
                                "resolvedEnd": params["windowEnd"], "shifted": false,
                                "conflict": "no-clear-slot", "calendarMirror": "skipped-error"}));
                        }
                        let provenance = self.provider.provenance(&params, "actor-1");
                        let id = execution::apply_addition_event_id(
                            "actor-1",
                            provenance["jarvisPlanId"].as_str().unwrap_or_default(),
                            provenance["jarvisBlockId"].as_str().unwrap_or_default(),
                            provenance["jarvisPlanRevision"].as_str().unwrap_or_default().parse().unwrap_or(0),
                            provenance["jarvisOperationId"].as_str().unwrap_or_default(),
                        );
                        self.provider.events.borrow_mut().insert(
                            id.clone(),
                            json!({"start": params["windowStart"], "end": params["windowEnd"],
                                "provenance": provenance, "attendeeCount": 0}),
                        );
                        json!({"created": true, "resolvedStart": params["windowStart"],
                            "resolvedEnd": params["windowEnd"], "shifted": false, "conflict": "none",
                            "googleEventId": id, "calendarMirror": "written"})
                    }
                    "rescheduleCalendarEvent" => {
                        let id = params["eventRef"].as_str().unwrap_or_default().to_owned();
                        if let Some(event) = self.provider.events.borrow_mut().get_mut(&id) {
                            event["start"] = params["newStart"].clone();
                            event["end"] = params["newEnd"].clone();
                        }
                        json!({"ok": true})
                    }
                    "deleteCalendarEvent" => {
                        let id = params["eventId"].as_str().unwrap_or_default().to_owned();
                        self.provider.events.borrow_mut().remove(&id);
                        json!({"deleted": true, "googleDeleted": true, "cacheMirror": "evicted"})
                    }
                    _ => return Err(moss_module_sdk::Error::new("Unknown api")),
                });
            }
            ("db", "query", table) => {
                let q: Query = serde_json::from_value(body).unwrap();
                let mut tables = self.tables.borrow_mut();
                let rows = tables.entry(table.to_owned()).or_default();
                let filter = serde_json::to_value(&q.filter).unwrap();
                match serde_json::to_value(&q.kind).unwrap().as_str().unwrap() {
                    "select" => Ok(Value::Array(
                        rows.iter().filter(|r| matches(r, &filter)).cloned().collect(),
                    )),
                    "insert" => {
                        let row = Value::Object(q.values.clone().into_iter().collect());
                        let dup = rows.iter().any(|r| {
                            r["id"] == row["id"]
                                || (table.ends_with("operations")
                                    && r["plan_id"] == row["plan_id"]
                                    && r["idempotency_key"] == row["idempotency_key"])
                                || (table.ends_with("items")
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
                        let mut updated = Vec::new();
                        for row in rows.iter_mut() {
                            if !matches(row, &filter) {
                                continue;
                            }
                            for (column, value) in &q.values {
                                row[column] = value.clone();
                            }
                            updated.push(row.clone());
                        }
                        Ok(Value::Array(updated))
                    }
                    "delete" => {
                        rows.retain(|r| !matches(r, &filter));
                        Ok(json!([]))
                    }
                    other => panic!("unexpected query {other}"),
                }
            }
            _ => panic!("Unexpected call {port}.{op}.{resource}: {body}"),
        }
    }
}

fn script(blocks: Vec<Value>) -> Script {
    let s = Script {
        tables: RefCell::new(BTreeMap::new()),
        approvals: RefCell::new(Vec::new()),
        kv: RefCell::new(BTreeMap::new()),
        policy: RefCell::new(BTreeMap::from([
            ("calendar_management".to_string(), "always_confirm".to_string()),
            ("calendar_writeback".to_string(), "ask_each_time".to_string()),
        ])),
        provider: Provider::default(),
        next: RefCell::new(0),
    };
    s.tables.borrow_mut().insert(
        "app.day_plans".into(),
        vec![json!({"id":PLAN,"revision":3,"local_day":"2026-11-10","time_zone":"UTC"})],
    );
    s.tables
        .borrow_mut()
        .insert("app.day_plan_blocks".into(), blocks);
    s
}

fn addition_plan() -> Script {
    script(vec![json!({
        "id":A,"plan_id":PLAN,"position":0,"kind":"task","title":"Write the chapter","task_id":null,
        "actual_placement":null,
        "pending_change":{"kind":"add","startsAt":"2026-11-10T09:00:00Z","durationMinutes":30},
    })])
}

fn placed_move_plan() -> Script {
    // One block already on the calendar, with a pending move to 14:00.
    let s = script(vec![json!({
        "id":A,"plan_id":PLAN,"position":0,"kind":"task","title":"Write the chapter","task_id":null,
        "actual_placement":{"startsAt":"2026-11-10T09:00:00Z","durationMinutes":30,"calendarEventRef":"jap-existing"},
        "pending_change":{"kind":"move","startsAt":"2026-11-10T14:00:00Z","durationMinutes":30},
    })]);
    s.provider.events.borrow_mut().insert(
        "jap-existing".into(),
        json!({"start":"2026-11-10T09:00:00Z","end":"2026-11-10T09:30:00Z",
            "provenance":{"jarvisTool":"applyAddition","jarvisActorUserId":"actor-1",
                "jarvisPlanId":PLAN,"jarvisBlockId":A,"jarvisPlanRevision":"1","jarvisOperationId":"old"},
            "attendeeCount":0}),
    );
    s
}

/// An apply call that names its selection, as the review screen does.
fn select_call(s: &Script, key: &str, ids: &[&str]) -> (u16, Value) {
    route(
        s,
        "POST",
        "/day-plans/:id/apply",
        json!({"id": PLAN}),
        json!({"expectedRevision":3,"idempotencyKey":key,"selectedBlockIds":ids}),
    )
}

fn route(s: &Script, method: &str, path: &str, params: Value, body: Value) -> (u16, Value) {
    let payload = json!({"method":method,"path":path,"params":params,"query":{},"body":body}).to_string();
    let reply = handle(s, "route", &payload).unwrap();
    let reply: Value = serde_json::from_str(&reply).unwrap();
    (reply["status"].as_u64().unwrap_or(0) as u16, reply["body"].clone())
}

fn apply_call(s: &Script, key: &str) -> (u16, Value) {
    route(
        s,
        "POST",
        "/day-plans/:id/apply",
        json!({"id": PLAN}),
        json!({"expectedRevision":3,"idempotencyKey":key}),
    )
}

fn item_ids(s: &Script, operation: &str) -> Vec<String> {
    s.tables
        .borrow()
        .get("app.day_plan_operation_items")
        .unwrap()
        .iter()
        .filter(|item| item["operation_id"] == json!(operation))
        .map(|item| item["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn operation_of(s: &Script) -> String {
    s.tables
        .borrow()
        .get("app.day_plan_operations")
        .unwrap()
        .first()
        .unwrap()["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn block(s: &Script, id: &str) -> Value {
    s.tables
        .borrow()
        .get("app.day_plan_blocks")
        .unwrap()
        .iter()
        .find(|b| b["id"] == json!(id))
        .cloned()
        .unwrap()
}

fn provider_calls(s: &Script) -> Vec<(String, Value)> {
    s.provider
        .calls
        .borrow()
        .iter()
        .map(|(name, params)| ((*name).to_owned(), params.clone()))
        .collect()
}

fn provider_writes(s: &Script) -> usize {
    s.provider
        .calls
        .borrow()
        .iter()
        .filter(|(name, _)| matches!(*name, "create" | "reschedule" | "delete"))
        .count()
}

#[test]
fn apply_creates_the_event_with_the_operation_identity_and_mirrors_the_block() {
    let s = addition_plan();
    let (status, report) = apply_call(&s, "k1");
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["status"], "completed");
    assert_eq!(report["planId"], PLAN);
    let item = &report["items"][0];
    assert_eq!(item["outcome"], "applied");
    let result = &item["result"];
    let event_id = result["providerEventId"].as_str().unwrap().to_owned();
    assert!(event_id.starts_with("jap") && event_id.len() == 35, "{event_id}");
    assert_eq!(result["startsAt"], "2026-11-10T09:00:00Z");
    assert_eq!(result["durationMinutes"], 30);
    assert_eq!(result["calendarMirror"], "written");
    assert_eq!(result["blockMirror"], "mirrored");
    // The provider carries exactly the operation identity on the event.
    let stored = s.provider.events.borrow().get(&event_id).cloned().unwrap();
    assert_eq!(stored["provenance"]["jarvisTool"], "applyAddition");
    assert_eq!(stored["provenance"]["jarvisPlanId"], PLAN);
    assert_eq!(stored["provenance"]["jarvisBlockId"], A);
    assert_eq!(stored["provenance"]["jarvisPlanRevision"], "3");
    // The block mirrors the placement and clears its pending change; the plan
    // revision advances so a stale draft cannot re-propose the addition.
    let mirrored = block(&s, A);
    assert_eq!(mirrored["pending_change"], Value::Null);
    assert_eq!(mirrored["actual_placement"]["calendarEventRef"], event_id.as_str());
    let revision = s.tables.borrow().get("app.day_plans").unwrap()[0]["revision"].clone();
    assert_eq!(revision, 4);
    // The stored item result stays readable by the status route.
    assert_eq!(
        s.tables.borrow().get("app.day_plan_operation_items").unwrap()[0]["outcome"],
        "applied"
    );
}

#[test]
fn a_replayed_apply_returns_the_settled_result_without_new_provider_work() {
    let s = addition_plan();
    let (first_status, first) = apply_call(&s, "k1");
    assert_eq!(first_status, 200);
    let writes = provider_writes(&s);
    let (status, again) = apply_call(&s, "k1");
    assert_eq!(status, 200);
    assert_eq!(again["status"], "completed");
    assert_eq!(again["items"][0]["outcome"], "applied");
    assert_eq!(
        again["items"][0]["result"]["providerEventId"],
        first["items"][0]["result"]["providerEventId"]
    );
    assert_eq!(provider_writes(&s), writes, "a replay re-executed an item");
}

#[test]
fn apply_gates_moves_behind_a_pending_approval_and_answers_202() {
    let s = placed_move_plan();
    let (status, gated) = select_call(&s, "k1", &[A]);
    assert_eq!(status, 202, "{gated}");
    assert_eq!(gated["status"], "confirmation-required");
    let approval_id = gated["approvalId"].as_str().unwrap().to_owned();
    assert_eq!(
        gated["changes"],
        json!([{
            "blockId": A, "kind": "move", "calendarEventRef": "jap-existing",
            "startsAt": "2026-11-10T14:00:00Z", "durationMinutes": 30,
        }]),
        "{gated}"
    );
    // The pending approval binds the exact operation and change set.
    let record = s.approvals.borrow().first().cloned().unwrap();
    assert_eq!(record["status"], "pending");
    assert_eq!(record["inputSummary"]["tool"], "calendar.applyDayPlanChanges");
    assert_eq!(record["inputSummary"]["operationId"], operation_of(&s));
    // Nothing executed and no item outcome was written.
    assert_eq!(provider_writes(&s), 0);
    assert_eq!(
        s.tables.borrow().get("app.day_plan_operation_items").unwrap()[0]["outcome"],
        "pending"
    );
    // Replaying apply returns the same pending approval, never a second one.
    let (status, replay) = select_call(&s, "k1", &[A]);
    assert_eq!(status, 202);
    assert_eq!(replay["approvalId"], json!(approval_id));
    assert_eq!(s.approvals.borrow().len(), 1);
}

#[test]
fn confirm_executes_the_gated_move_and_a_replay_is_refused() {
    let s = placed_move_plan();
    let (_, gated) = select_call(&s, "k1", &[A]);
    let approval_id = gated["approvalId"].as_str().unwrap().to_owned();
    let operation = operation_of(&s);
    let (status, report) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/confirm",
        json!({"id": PLAN, "operation_id": operation}),
        json!({"approvalId": approval_id}),
    );
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["status"], "completed");
    assert_eq!(report["items"][0]["outcome"], "applied");
    assert_eq!(report["items"][0]["result"]["providerEventId"], "jap-existing");
    // The provider saw the patch, and the block mirrors the new window.
    let rescheduled = provider_calls(&s)
        .into_iter()
        .find(|(name, _)| name == "reschedule")
        .map(|(_, params)| params)
        .expect("the move patched the provider");
    assert_eq!(rescheduled["eventRef"], "jap-existing");
    assert_eq!(rescheduled["newStart"], "2026-11-10T14:00:00Z");
    assert_eq!(block(&s, A)["actual_placement"]["startsAt"], "2026-11-10T14:00:00Z");
    assert_eq!(s.approvals.borrow()[0]["status"], "confirmed");
    // A replayed confirm finds no pending record and is refused.
    let (status, refused) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/confirm",
        json!({"id": PLAN, "operation_id": operation}),
        json!({"approvalId": approval_id}),
    );
    assert_eq!(status, 409);
    assert_eq!(refused["error"], "day plan apply approval is not available");
}

#[test]
fn confirm_refuses_a_foreign_or_drifted_approval_and_writes_nothing() {
    let s = placed_move_plan();
    let (_, gated) = select_call(&s, "k1", &[A]);
    let operation = operation_of(&s);
    let foreign = "99999999-9999-4999-8999-999999999999";
    let (status, refused) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/confirm",
        json!({"id": PLAN, "operation_id": operation}),
        json!({"approvalId": foreign}),
    );
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["error"], "day plan apply approval is not available");
    assert_eq!(provider_writes(&s), 0);
    // A draft that drifted under the reservation needs renewed approval.
    {
        let mut tables = s.tables.borrow_mut();
        tables.get_mut("app.day_plan_blocks").unwrap()[0]["pending_change"] =
            json!({"kind":"move","startsAt":"2026-11-10T15:00:00Z","durationMinutes":30});
    }
    let (status, mismatch) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/confirm",
        json!({"id": PLAN, "operation_id": operation}),
        json!({"approvalId": gated["approvalId"]}),
    );
    assert_eq!(status, 409, "{mismatch}");
    assert_eq!(mismatch["error"], "day plan apply approval does not match the operation");
    assert_eq!(provider_writes(&s), 0);
    assert_eq!(
        s.tables.borrow().get("app.day_plan_operation_items").unwrap()[0]["outcome"],
        "pending"
    );
}

#[test]
fn recover_on_a_gated_batch_denies_without_a_confirmed_approval() {
    let s = placed_move_plan();
    let (_, gated) = select_call(&s, "k1", &[A]);
    let operation = operation_of(&s);
    let (status, denied) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/recover",
        json!({"id": PLAN, "operation_id": operation}),
        json!({}),
    );
    assert_eq!(status, 200, "{denied}");
    assert_eq!(denied["status"], "denied");
    assert!(
        denied["denialReason"]
            .as_str()
            .unwrap()
            .starts_with("confirmation-required"),
        "{denied}"
    );
    assert_eq!(provider_writes(&s), 0);
    // The stored item stays pending: the denial recorded nothing.
    assert_eq!(
        s.tables.borrow().get("app.day_plan_operation_items").unwrap()[0]["outcome"],
        "pending"
    );
    let _ = gated;
}

#[test]
fn retry_reruns_a_failed_addition_after_the_window_clears() {
    let s = {
        let s = addition_plan();
        s.provider.refuse_next_create.set(1);
        s
    };
    let (status, first) = apply_call(&s, "k1");
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["status"], "completed");
    assert_eq!(first["items"][0]["outcome"], "failed");
    assert_eq!(first["items"][0]["result"]["reason"], "conflict");
    let operation = operation_of(&s);
    let item = item_ids(&s, &operation)[0].clone();
    let (status, retried) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/retry",
        json!({"id": PLAN, "operation_id": operation}),
        json!({"itemIds": [item]}),
    );
    assert_eq!(status, 200, "{retried}");
    assert_eq!(retried["items"][0]["outcome"], "applied");
    assert_eq!(retried["items"][0]["result"]["calendarMirror"], "written");
    // An applied item is never re-executed.
    let writes = provider_writes(&s);
    let (status, again) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/retry",
        json!({"id": PLAN, "operation_id": operation}),
        json!({"itemIds": [item]}),
    );
    assert_eq!(status, 409);
    assert_eq!(
        again["error"],
        "day plan apply retry selection is not eligible"
    );
    assert_eq!(provider_writes(&s), writes);
}

#[test]
fn recover_adopts_an_unknown_addition_from_the_provider_state() {
    let s = {
        let s = addition_plan();
        // The reconcile read succeeds (no event yet); the create succeeds; the
        // verification read fails, so the item records unknown with the event id.
        s.provider.fail_lookup_number.set(2);
        s
    };
    let (status, first) = apply_call(&s, "k1");
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["items"][0]["outcome"], "unknown");
    let operation = operation_of(&s);
    let (status, recovered) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/recover",
        json!({"id": PLAN, "operation_id": operation}),
        json!({}),
    );
    assert_eq!(status, 200, "{recovered}");
    assert_eq!(recovered["items"][0]["outcome"], "applied");
    // A reconciled match adopts the observed state with an honest mirror.
    assert_eq!(recovered["items"][0]["result"]["calendarMirror"], "not-checked");
    assert!(recovered["items"][0]["result"]["providerEventId"]
        .as_str()
        .unwrap()
        .starts_with("jap"));
}

#[test]
fn time_block_mode_off_denies_the_batch_and_records_access_denied() {
    let s = {
        let s = addition_plan();
        s.kv.borrow_mut().insert(
            "calendar.briefing-settings".into(),
            json!({"calendar.time_block_mode": "off"}),
        );
        s
    };
    let (status, denied) = apply_call(&s, "k1");
    assert_eq!(status, 200, "{denied}");
    assert_eq!(denied["status"], "denied");
    assert_eq!(
        denied["denialReason"],
        "access-denied: time blocking is off"
    );
    assert_eq!(denied["items"][0]["outcome"], "failed");
    assert_eq!(denied["items"][0]["result"]["reason"], "access-denied");
    // The denial settled durably with zero provider calls.
    assert_eq!(provider_writes(&s), 0);
    assert!(provider_calls(&s).iter().all(|(name, _)| name == "facts"));
}

#[test]
fn a_planned_removal_deletes_the_provider_event_and_clears_the_block() {
    let s = script(vec![json!({
        "id":A,"plan_id":PLAN,"position":0,"kind":"task","title":"Write the chapter","task_id":null,
        "actual_placement":{"startsAt":"2026-11-10T09:00:00Z","durationMinutes":30,"calendarEventRef":"jap-existing"},
        "pending_change":{"kind":"remove"},
    })]);
    // The stored event must carry our provenance to prove ownership.
    s.provider.events.borrow_mut().insert(
        "jap-existing".into(),
        json!({"start":"2026-11-10T09:00:00Z","end":"2026-11-10T09:30:00Z",
            "provenance":{"jarvisTool":"applyAddition","jarvisActorUserId":"actor-1",
                "jarvisPlanId":PLAN,"jarvisBlockId":A,"jarvisPlanRevision":"1","jarvisOperationId":"old"},
            "attendeeCount":0}),
    );
    let (status, gated) = select_call(&s, "k1", &[A]);
    assert_eq!(status, 202, "{gated}");
    let operation = operation_of(&s);
    let (status, report) = route(
        &s,
        "POST",
        "/day-plans/:id/operations/:operation_id/confirm",
        json!({"id": PLAN, "operation_id": operation}),
        json!({"approvalId": gated["approvalId"]}),
    );
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["items"][0]["outcome"], "applied");
    let result = &report["items"][0]["result"];
    assert_eq!(result["removed"], true);
    assert_eq!(result["providerEventId"], "jap-existing");
    assert_eq!(result["calendarMirror"], "evicted");
    assert!(s.provider.events.borrow().get("jap-existing").is_none(), "the event was deleted");
    let mirrored = block(&s, A);
    assert_eq!(mirrored["pending_change"], Value::Null);
    // A removal clears the placement: the recorded reference and timing are
    // gone, as the TypeScript removal mirror writes them.
    assert_eq!(mirrored["actual_placement"]["startsAt"], Value::Null);
    assert_eq!(mirrored["actual_placement"]["durationMinutes"], Value::Null);
    assert_eq!(mirrored["actual_placement"]["calendarEventRef"], Value::Null);
    let _ = B;
}
