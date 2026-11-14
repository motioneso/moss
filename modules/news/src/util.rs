//! Small helpers shared by the News routes.
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{Error, Response, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn bad_request(message: impl Into<String>) -> Response {
    error(400, message)
}

/// The error body the old server sent for every refused request.
pub fn error(status: u16, message: impl Into<String>) -> Response {
    Response::new(status, json!({"error":message.into()}))
}

pub fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// Database timestamps become the `toISOString` form the old app returned.
pub fn iso(value: &Value) -> Result<String> {
    let text = value.as_str().ok_or_else(|| Error::new("Invalid news row"))?;
    let at = DateTime::parse_from_rfc3339(text).map_err(|_| Error::new("Invalid news row"))?;
    Ok(at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn iso_or_null(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    Ok(Value::String(iso(value)?))
}

/// The same check the old route schema made on `:id`.
pub fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `String.prototype.trim`: whitespace plus the byte order mark.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The `:id` of a route, or the refusal the old route schema gave.
pub fn id_param(request: &moss_module_sdk::RouteRequest) -> std::result::Result<&str, Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default();
    if is_uuid(id) {
        Ok(id)
    } else {
        Err(bad_request("params/id must match format \"uuid\""))
    }
}

/// The host clock as milliseconds since the epoch.
pub fn now_ms<H: moss_module_sdk::Host + ?Sized>(host: &H) -> Result<i64> {
    Ok(now(host)?.timestamp_millis())
}

/// The host clock for this call.
pub fn now<H: moss_module_sdk::Host + ?Sized>(host: &H) -> Result<DateTime<Utc>> {
    let context = host.call("context", "read", "call", json!({}))?;
    context["now"]
        .as_str()
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&Utc))
        .ok_or_else(|| Error::new("Host clock unavailable"))
}

/// A new random id from the host.
pub fn new_id<H: moss_module_sdk::Host + ?Sized>(host: &H) -> Result<String> {
    let made = host.call("context", "uuid", "new", json!({}))?;
    made["id"].as_str().map(str::to_owned).ok_or_else(|| Error::new("Invalid host id"))
}
