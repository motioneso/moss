//! The signed-in person's routes: status, the pause switch and deleting history.
use crate::clock::write;
use crate::codes::RANGE_MESSAGES;
use crate::range::{parse_range, Range};
use crate::index::{ids, remove_chunks};
use crate::store::{call, lock, now};
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

pub fn status<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let storage = if call(host, "storage", json!({}))?["on"] == json!(true) { "on" } else { "off" };
    let mut body = call(host, "status", json!({}))?;
    let map = body.as_object_mut().ok_or_else(|| moss_module_sdk::Error::new("Backtrack status is malformed"))?;
    map.insert("storage".into(), storage.into());
    Ok(Response::new(200, body))
}

pub fn set_paused<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let paused = match request.body.as_object() {
        Some(map) if map.len() == 1 => map.get("paused").and_then(Value::as_bool),
        _ => None,
    };
    let Some(paused) = paused else {
        return Ok(Response::new(400, json!({"error": "Invalid request"})));
    };
    lock(host)?;
    let saved = call(host, "set-paused", json!({"paused": paused}))?;
    crate::upkeep::keep_scheduled(host);
    Ok(Response::new(200, json!({"paused": saved["paused"] == json!(true)})))
}

/// Writes the deletion marker first, then deletes, under the person's lock. A range that starts
/// in the future holds nothing yet, so it writes no marker.
pub fn delete<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let range = parse_range(&request.body);
    if let Range::Invalid(message) = range {
        debug_assert!(RANGE_MESSAGES.contains(&message));
        return Ok(Response::new(400, json!({"error": message})));
    }
    lock(host)?;
    let at = now(host)?;
    let (from, to) = match range {
        Range::Between(from, to) => (Some(from), to.min(at)),
        _ => (None, at),
    };
    if from.is_some_and(|from| from >= to) {
        return Ok(Response::new(200, json!({"deleted": 0})));
    }
    // Search chunks go first, so a failure leaves the text and its marker untouched.
    let window = json!({"from": from.map(write), "to": write(to)});
    remove_chunks(host, &ids(&call(host, "segment-ids", window)?))?;
    let reply = call(
        host,
        "delete",
        json!({"from": from.map(write), "to": write(to), "deletedAt": write(at)}),
    )?;
    crate::upkeep::keep_scheduled(host);
    Ok(Response::new(200, json!({"deleted": reply["deleted"].as_u64().unwrap_or(0)})))
}
