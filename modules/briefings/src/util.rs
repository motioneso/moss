//! Small helpers shared by the definition and run routes.
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{Error, Host, Response, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn bad_request(message: impl Into<String>) -> Response {
    Response::new(400, json!({"error":message.into()}))
}

pub fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// Database timestamps become the `toISOString` form the old app returned.
pub fn iso(value: &Value) -> Result<String> {
    let text = value.as_str().ok_or_else(|| Error::new("Invalid briefing row"))?;
    let at = DateTime::parse_from_rfc3339(text).map_err(|_| Error::new("Invalid briefing row"))?;
    Ok(at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn iso_or_null(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    Ok(Value::String(iso(value)?))
}

pub struct Call {
    pub actor: String,
    pub now: String,
}

pub fn call<H: Host + ?Sized>(host: &H) -> Result<Call> {
    let read = host.call("context", "read", "call", json!({}))?;
    let text = |key: &str| {
        read[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::new("Invalid host context"))
    };
    Ok(Call { actor: text("actorUserId")?, now: iso(&read["now"])? })
}

pub fn new_id<H: Host + ?Sized>(host: &H) -> Result<String> {
    let made = host.call("context", "uuid", "new", json!({}))?;
    made["id"].as_str().map(str::to_owned).ok_or_else(|| Error::new("Invalid host id"))
}

/// The account's saved time zone, or `None` when the host cannot say.
pub fn owner_zone<H: Host + ?Sized>(host: &H, now: &str) -> Option<String> {
    let day = host
        .call("context", "local-date", "account", json!({"instant":now,"offsetDays":0}))
        .ok()?;
    day["timezone"].as_str().map(str::to_owned)
}
