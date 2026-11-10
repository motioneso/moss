//! Apply-batch reservation. Freezes the reviewed selection as one durable batch
//! before any provider call, so a retried request settles once. Execution is not here.
use crate::{context, operations, plans, query, Error, Result};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Host,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const OPERATIONS: &str = "app.day_plan_operations";
const ITEMS: &str = "app.day_plan_operation_items";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub expected_revision: i64,
    pub idempotency_key: String,
    #[serde(default)]
    pub operation_key: Option<String>,
    #[serde(default)]
    pub selected_block_ids: Option<Vec<String>>,
}

fn invalid(message: &str) -> Error {
    Error::coded(400, "day_plan_invalid", message)
}
fn reuse() -> Error {
    Error::new(409, "idempotency key is already used for a different operation")
}
fn rows(value: Value) -> BTreeMap<String, Value> {
    value.as_object().unwrap().clone().into_iter().collect()
}

/// Trimmed, blanks dropped, deduplicated, sorted. Omitted and empty normalize alike.
pub fn normalize_intent(ids: Option<&[String]>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    for id in ids.unwrap_or(&[]) {
        let id = id.trim();
        if !id.is_empty() {
            seen.insert(id.to_owned());
        }
    }
    seen.into_iter().collect()
}

fn entry(block: &Value) -> Value {
    let change = &block["pendingChange"];
    let remove = change["kind"] == "remove";
    json!({
        "blockId": block["id"],
        "kind": change["kind"],
        "startsAt": if remove { Value::Null } else { change["startsAt"].clone() },
        "durationMinutes": if remove { Value::Null } else { change["durationMinutes"].clone() },
    })
}

/// The explicit selection plus every still-pending addition, in plan order.
pub fn resolve_selection(blocks: &[Value], intent: &[String]) -> Result<Vec<Value>> {
    let by_id: BTreeMap<&str, &Value> = blocks
        .iter()
        .filter_map(|b| b["id"].as_str().map(|id| (id, b)))
        .collect();
    let mut picked: BTreeMap<String, &Value> = BTreeMap::new();
    for id in intent {
        let block = by_id
            .get(id.as_str())
            .ok_or_else(|| invalid(&format!("selected change {id} is not part of this plan")))?;
        if block["pendingChange"].is_null() {
            return Err(invalid(&format!("selected change {id} has no pending change")));
        }
        picked.insert(id.clone(), block);
    }
    for block in blocks {
        if block["pendingChange"]["kind"] == "add" {
            if let Some(id) = block["id"].as_str() {
                picked.entry(id.to_owned()).or_insert(block);
            }
        }
    }
    let mut chosen: Vec<&Value> = picked.into_values().collect();
    chosen.sort_by(|a, b| {
        (a["position"].as_i64(), a["id"].as_str()).cmp(&(b["position"].as_i64(), b["id"].as_str()))
    });
    Ok(chosen.into_iter().map(entry).collect())
}

fn unreadable() -> Error {
    Error::new(500, "stored apply batch is unreadable")
}

/// Reads a stored snapshot as (intent, selection). Old snapshots held a bare list
/// with no intent, so they never replay.
fn snapshot(value: &Value) -> Result<(Option<Vec<String>>, Vec<Value>)> {
    if let Some(list) = value.as_array() {
        return Ok((None, list.clone()));
    }
    let intent = value["intent"]
        .as_array()
        .and_then(|ids| ids.iter().map(|i| i.as_str().map(str::to_owned)).collect())
        .ok_or_else(unreadable)?;
    let selection = value["selection"].as_array().ok_or_else(unreadable)?;
    Ok((Some(intent), selection.clone()))
}

fn header_by_key(host: &impl Host, plan_id: &str, key: &str) -> Result<Option<Value>> {
    let found = query(
        host,
        OPERATIONS,
        &Query::select(Filter::And {
            filters: vec![
                Filter::eq("plan_id", plan_id),
                Filter::eq("idempotency_key", key),
            ],
        }),
    )?;
    Ok(found.into_iter().next())
}

/// Whether a stored header is the same reservation. `selection` is compared only
/// when given (a fresh request has one; a replay is judged on intent alone).
fn same(header: &Value, revision: i64, op_key: &Option<String>, intent: &[String], selection: Option<&[Value]>) -> Result<bool> {
    if header["kind"] != "apply"
        || header["expected_revision"].as_i64() != Some(revision)
        || header["operation_key"].as_str() != op_key.as_deref()
    {
        return Ok(false);
    }
    let (stored_intent, stored_selection) = snapshot(&header["selection_snapshot"])?;
    Ok(stored_intent.as_deref() == Some(intent)
        && selection.is_none_or(|wanted| wanted == stored_selection.as_slice()))
}

/// Writes any missing item rows (unique per batch and block) and returns the batch.
/// Each host call commits alone, so a crash between header and items is repaired
/// by the next exact replay.
fn settle(host: &impl Host, header: &Value) -> Result<Value> {
    let id = header["id"].as_str().ok_or_else(unreadable)?;
    let plan_id = header["plan_id"].as_str().ok_or_else(unreadable)?;
    let (_, selection) = snapshot(&header["selection_snapshot"])?;
    let existing = query(host, ITEMS, &Query::select(Filter::eq("operation_id", id)))?;
    // A deleted block leaves its item behind with a null block id, so items are matched
    // by the frozen pending change and never recreated for a block that is gone.
    let live = plans::blocks(host, plan_id)?;
    for wanted in &selection {
        if existing
            .iter()
            .any(|row| row["pending_change"]["blockId"] == wanted["blockId"])
            || !live.iter().any(|b| b["id"] == wanted["blockId"])
        {
            continue;
        }
        let mut insert = Query::insert(rows(json!({
            "id": context(host, "uuid", "new")?["id"],
            "operation_id": id,
            "plan_id": plan_id,
            "block_id": wanted["blockId"],
            "kind": wanted["kind"],
            "pending_change": wanted,
            "outcome": "pending",
        })));
        insert.conflict = Conflict::Ignore;
        query(host, ITEMS, &insert)?;
    }
    let mut items = query(host, ITEMS, &Query::select(Filter::eq("operation_id", id)))?;
    let position = |row: &Value| {
        selection
            .iter()
            .position(|s| s["blockId"] == row["block_id"])
            .unwrap_or(selection.len())
    };
    items.sort_by_key(position);
    let items = items
        .iter()
        .map(|row| {
            if !matches!(row["kind"].as_str(), Some("add" | "move" | "remove")) {
                return Err(unreadable());
            }
            Ok(json!({
                "id": row["id"], "blockId": row["block_id"], "kind": row["kind"],
                "pendingChange": row["pending_change"], "outcome": row["outcome"],
                "result": operations::item_result(&row["result"])?,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({
        "id": header["id"], "planId": header["plan_id"],
        "idempotencyKey": header["idempotency_key"], "operationKey": header["operation_key"],
        "expectedRevision": header["expected_revision"], "outcome": header["outcome"],
        "selection": selection, "items": items,
    }))
}

/// Reserves one batch. An exact replay returns the stored reservation even after
/// the plan revision moves on; any difference conflicts; a new key must match the
/// current revision.
pub fn reserve(host: &impl Host, plan_id: &str, request: Request) -> Result<Value> {
    let key = request.idempotency_key.trim().to_owned();
    if key.is_empty() || key.len() > 128 {
        return Err(invalid("idempotencyKey must be non-empty text"));
    }
    if request.expected_revision < 1 || request.expected_revision > i32::MAX as i64 {
        return Err(invalid("expectedRevision must be a positive integer"));
    }
    if request.operation_key.as_deref() == Some("") {
        return Err(invalid("operationKey must be text or null"));
    }
    let revision = request.expected_revision;
    let intent = normalize_intent(request.selected_block_ids.as_deref());
    let plan = query(host, plans::PLANS, &Query::select(Filter::eq("id", plan_id)))?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new(404, "day plan is not available"))?;
    if let Some(header) = header_by_key(host, plan_id, &key)? {
        if !same(&header, revision, &request.operation_key, &intent, None)? {
            return Err(reuse());
        }
        return settle(host, &header);
    }
    if plan["revision"].as_i64() != Some(revision) {
        return Err(Error::new(409, "day plan changed since it was read"));
    }
    let blocks: Vec<Value> = plans::blocks(host, plan_id)?
        .iter()
        .map(plans::block_dto)
        .collect();
    // Each host call commits alone, so there is no row lock. A draft save raises the
    // revision before it rewrites blocks, so a changed revision here means the blocks
    // just read may belong to a newer draft.
    let after = query(host, plans::PLANS, &Query::select(Filter::eq("id", plan_id)))?;
    if after.first().map(|p| p["revision"].as_i64()) != Some(Some(revision)) {
        return Err(Error::new(409, "day plan changed since it was read"));
    }
    let selection = resolve_selection(&blocks, &intent)?;
    if selection.is_empty() {
        return Err(invalid("no pending changes to reserve"));
    }
    let mut insert = Query::insert(rows(json!({
        "id": context(host, "uuid", "new")?["id"],
        "plan_id": plan_id,
        "operation_key": request.operation_key,
        "kind": "apply",
        "idempotency_key": key,
        "expected_revision": revision,
        "outcome": "pending",
        "selection_snapshot": {"intent": intent, "selection": selection},
    })));
    insert.conflict = Conflict::Ignore;
    let inserted = query(host, OPERATIONS, &insert)?;
    let header = match inserted.into_iter().next() {
        Some(header) => header,
        None => {
            // Lost a race on the idempotency key. Accept only an identical winner.
            let winner = header_by_key(host, plan_id, &key)?.ok_or_else(reuse)?;
            if !same(&winner, revision, &request.operation_key, &intent, Some(&selection))? {
                return Err(reuse());
            }
            winner
        }
    };
    settle(host, &header)
}

/// The route. Reservation is complete but execution needs a Connectors package,
/// so the request is validated and then refused before anything is written.
pub fn route(_host: &impl Host, plan_id: &str, body: Value) -> Result<Value> {
    if !operations::uuid(plan_id) {
        return Err(invalid("id must be a uuid"));
    }
    if body.get("selectedBlockIds").is_some_and(|ids| {
        !ids.as_array().is_some_and(|list| {
            list.iter().all(|id| id.as_str().is_some_and(operations::uuid))
                && list.iter().filter_map(Value::as_str).collect::<std::collections::BTreeSet<_>>().len() == list.len()
        })
    }) {
        return Err(invalid("selectedBlockIds must be a list of distinct ids"));
    }
    let request: Request = serde_json::from_value(body)
        .map_err(|_| invalid("request must hold expectedRevision, idempotencyKey and optional operationKey and selectedBlockIds"))?;
    if request.expected_revision < 1
        || request.idempotency_key.trim().is_empty()
        || request.idempotency_key.trim().len() > 128
    {
        return Err(invalid("expectedRevision and idempotencyKey are required"));
    }
    if request.operation_key.as_deref() == Some("") {
        return Err(invalid("operationKey must be text or null"));
    }
    Err(Error::new(503, "day plan apply is unavailable"))
}

fn operation_ids(plan_id: &str, operation_id: &str) -> Result<()> {
    if !operations::uuid(plan_id) || !operations::uuid(operation_id) {
        return Err(invalid("id and operationId must be uuids"));
    }
    Ok(())
}

fn only_keys(body: &Value, allowed: &[&str]) -> Result<()> {
    let object = body
        .as_object()
        .ok_or_else(|| invalid("request must be an object"))?;
    match object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(invalid(&format!("unknown field: {key}"))),
        None => Ok(()),
    }
}

/// Retry. The selection is checked like the original, then the request is refused
/// before anything is read or written because execution needs a Connectors package.
pub fn retry_route(plan_id: &str, operation_id: &str, body: Value) -> Result<Value> {
    only_keys(&body, &["itemIds"])?;
    let ids = body["itemIds"]
        .as_array()
        .filter(|list| !list.is_empty() && list.iter().all(|id| id.as_str().is_some_and(operations::uuid)))
        .ok_or_else(|| invalid("itemIds must be a non-empty list of ids"))?;
    if ids.iter().filter_map(Value::as_str).collect::<std::collections::BTreeSet<_>>().len() != ids.len() {
        return Err(invalid("itemIds must not repeat an id"));
    }
    operation_ids(plan_id, operation_id)?;
    Err(Error::new(503, "day plan apply is unavailable"))
}

/// Recover takes no selection: the body is absent or an empty object.
pub fn recover_route(plan_id: &str, operation_id: &str, body: Value) -> Result<Value> {
    if !body.is_null() {
        only_keys(&body, &[])?;
    }
    operation_ids(plan_id, operation_id)?;
    Err(Error::new(503, "day plan apply is unavailable"))
}

/// Confirm needs a stored approval to match, which the host does not offer yet.
pub fn confirm_route(plan_id: &str, operation_id: &str, body: Value) -> Result<Value> {
    only_keys(&body, &["approvalId"])?;
    if !body["approvalId"].as_str().is_some_and(|id| !id.trim().is_empty()) {
        return Err(invalid("approvalId must be a non-empty string"));
    }
    operation_ids(plan_id, operation_id)?;
    Err(Error::new(503, "day plan apply is unavailable"))
}
