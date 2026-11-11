//! Fact lifecycle routes (pin, confirm, correct, status, mark-stale, supersede, delete), the
//! approval-gated `memory.forget` tool and the card details the approval screen shows. The
//! host runs the SQL under the signed-in person's row-level security.
use crate::schema::{validate, Schema};
use crate::{kv, score, Error, Result};
use moss_module_sdk::{Host, RouteRequest};
use serde_json::{json, Value};

const NOT_FOUND: &str = "Memory fact not found";
const CHANGED: &str = "The memory changed or is no longer available. Find it again and review a new request.";
const NOT_READY: &str = "Memory deletion is not ready. Start a new chat and try again.";
const STATUSES: &[&str] = &["active", "stale", "expired", "rejected"];

fn s() -> Schema {
    Schema::string()
}

fn checked(schema: &Schema, body: &Value) -> Result<Value> {
    let mut value = body.clone();
    validate(schema, &mut value, "body").map_err(|f| Error::new(400, f.message))?;
    Ok(value)
}

fn is_uuid(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| {
            p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit())
        })
}

/// The old routes cast the id in SQL, so a malformed id failed with a server error. It is
/// reported as not found instead.
fn fact_id(request: &RouteRequest) -> Result<String> {
    match request.params.get("id") {
        Some(id) if is_uuid(id) => Ok(id.to_ascii_lowercase()),
        _ => Err(Error::new(404, NOT_FOUND)),
    }
}

/// A host answer that carries a refusal becomes that plain status.
fn answer(value: Value) -> Result<Value> {
    if let Some(refused) = value.get("refused") {
        return Err(Error::new(
            refused["status"].as_u64().unwrap_or(503) as u16,
            refused["message"].as_str().unwrap_or("Memory is unavailable"),
        ));
    }
    Ok(value)
}

fn lifecycle(host: &impl Host, action: &str, id: &str, extra: Value) -> Result<Value> {
    let mut params = json!({"action": action, "factId": id});
    if let (Some(into), Some(from)) = (params.as_object_mut(), extra.as_object()) {
        into.extend(from.clone());
    }
    answer(kv(host, "set", "memory.lifecycle", params)?)
}

/// The fact in the shape the old routes returned, with its confidence tier.
fn with_tier(mut result: Value) -> Value {
    let mut fact = result["fact"].take();
    let tier = score::confidence_tier(&fact);
    fact["confidenceTier"] = json!(tier);
    json!({"fact": fact})
}

fn empty_body() -> Schema {
    Schema::object(&[], vec![])
}

pub fn confirm_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    checked(&empty_body(), &request.body)?;
    let id = fact_id(request)?;
    Ok(with_tier(lifecycle(host, "confirm", &id, json!({}))?))
}

pub fn mark_stale_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    checked(&empty_body(), &request.body)?;
    let id = fact_id(request)?;
    Ok(with_tier(lifecycle(host, "status", &id, json!({"status": "stale"}))?))
}

pub fn status_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(
        &["status"],
        vec![("status", Schema::one_of_strings(STATUSES)), ("reason", s())],
    );
    let body = checked(&schema, &request.body)?;
    let id = fact_id(request)?;
    Ok(with_tier(lifecycle(host, "status", &id, json!({"status": body["status"]}))?))
}

pub fn pin_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(&["pinned"], vec![("pinned", Schema::Boolean)]);
    let body = checked(&schema, &request.body)?;
    let id = fact_id(request)?;
    lifecycle(host, "pin", &id, json!({"pinned": body["pinned"] == true}))?;
    Ok(Value::Null)
}

pub fn supersede_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(&[], vec![("validTo", Schema::nullable(s()))]);
    let body = checked(&schema, &request.body)?;
    let id = fact_id(request)?;
    lifecycle(host, "supersede", &id, json!({"validTo": body["validTo"]}))?;
    Ok(Value::Null)
}

pub fn delete_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let id = fact_id(request)?;
    lifecycle(host, "delete", &id, json!({}))?;
    Ok(Value::Null)
}

/// Saves the corrected fact, then makes a best-effort attempt to give it a search vector. A
/// vector that cannot be stored leaves the correction saved.
pub fn correct_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(
        &["replacementText"],
        vec![("replacementText", s()), ("correctionReason", s())],
    );
    let body = checked(&schema, &request.body)?;
    let id = fact_id(request)?;
    let text = body["replacementText"].as_str().unwrap_or("").trim().to_owned();
    if text.is_empty() {
        return Err(Error::new(400, "Expected non-empty string"));
    }
    let saved = with_tier(lifecycle(host, "correct", &id, json!({"replacementText": text}))?);
    let _ = (0..2).any(|_| {
        kv(host, "set", "memory.index", json!({"factId": saved["fact"]["id"]}))
            .is_ok_and(|done| done["indexed"] == true)
    });
    Ok(saved)
}

fn failure(status: u16, message: &str) -> String {
    json!({"statusCode": status, "error": message}).to_string()
}

/// Only `factId`, and only as an id, is accepted.
fn forget_target(parameters: &Value) -> Option<String> {
    let map = parameters.as_object()?;
    let id = map.get("factId")?.as_str()?;
    (map.len() == 1 && is_uuid(id)).then(|| id.to_ascii_lowercase())
}

/// The readable label and version of the memory a forget request names, or an error string
/// when the memory is gone.
fn target(host: &impl Host, id: &str) -> std::result::Result<(String, String), String> {
    let found = kv(host, "get", "memory.target", json!({"factId": id}))
        .map_err(|_| failure(503, NOT_READY))?;
    match (found["target"]["label"].as_str(), found["target"]["version"].as_str()) {
        (Some(label), Some(version)) => Ok((label.to_owned(), version.to_owned())),
        _ => Err(failure(409, CHANGED)),
    }
}

/// The details the approval screen shows for a forget request. A malformed request has no
/// card (null); a missing memory is a conflict.
pub fn prepare_json(host: &impl Host, tool: &str, input_json: &str) -> std::result::Result<Value, String> {
    let input: Value = serde_json::from_str(input_json).map_err(|_| failure(400, "Invalid Memory input"))?;
    if tool != "memory.forget" {
        return Err(failure(400, "Unknown Memory action"));
    }
    let Some(id) = forget_target(&input) else {
        return Ok(Value::Null);
    };
    let (label, version) = target(host, &id)?;
    Ok(json!({"target": label, "fields": [], "version": version, "approvalKind": "memory_delete"}))
}

/// Deletes the memory the person approved. The host compares the approved version with the
/// live one under lock, so a changed memory is refused.
pub fn forget_tool(host: &impl Host, parameters: &Value, approval: Option<&str>) -> std::result::Result<Value, String> {
    let Some(id) = forget_target(parameters) else {
        return Err(failure(400, "Invalid memory forget request"));
    };
    let Some(version) = approval else {
        return Err(failure(503, NOT_READY));
    };
    let done = kv(host, "set", "memory.forget", json!({"factId": id, "version": version}))
        .map_err(|_| failure(503, NOT_READY))?;
    if done["deleted"] == true {
        Ok(json!({"data": {"deleted": true}}))
    } else {
        Err(failure(409, CHANGED))
    }
}
