//! Small helpers shared by the Goals routes.
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{Error, Response, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn bad_request(message: impl Into<String>) -> Response {
    error(400, message)
}

pub fn error(status: u16, message: impl Into<String>) -> Response {
    Response::new(status, json!({"error":message.into()}))
}

pub fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// Database timestamps become the `toISOString` form the old app returned.
pub fn iso(value: &Value) -> Result<String> {
    let text = value.as_str().ok_or_else(|| Error::new("Invalid goal row"))?;
    let at = DateTime::parse_from_rfc3339(text).map_err(|_| Error::new("Invalid goal row"))?;
    Ok(at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn iso_or_null(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    Ok(Value::String(iso(value)?))
}

pub fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub fn id_param(request: &moss_module_sdk::RouteRequest) -> std::result::Result<&str, Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default();
    if is_uuid(id) {
        Ok(id)
    } else {
        Err(bad_request("params/id must match format \"uuid\""))
    }
}
