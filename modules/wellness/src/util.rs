//! Small helpers shared by the Wellness routes.
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

fn parse(value: &Value) -> Result<DateTime<Utc>> {
    let text = value.as_str().ok_or_else(|| Error::new("Invalid check-in row"))?;
    let at = DateTime::parse_from_rfc3339(text).map_err(|_| Error::new("Invalid check-in row"))?;
    Ok(at.with_timezone(&Utc))
}

/// Database timestamps become the `toISOString` form the old app returned.
pub fn iso(value: &Value) -> Result<String> {
    Ok(parse(value)?.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// The same instant to the microsecond, as the old paging cursor carried it.
pub fn iso_micros(value: &Value) -> Result<String> {
    Ok(parse(value)?.to_rfc3339_opts(SecondsFormat::Micros, true))
}

pub fn iso_or_null(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    Ok(Value::String(iso(value)?))
}
