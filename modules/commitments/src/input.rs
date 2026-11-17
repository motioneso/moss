//! Request checks that give the answers the old route schemas gave. The old server coerced
//! numbers and booleans to text, dropped unknown fields and reported the first failure.
use serde_json::{Map, Value};

pub const STATUSES: [&str; 6] =
    ["pending_review", "accepted", "rejected", "snoozed", "expired", "explicit_non_action"];
const SETTABLE: [&str; 4] = ["accepted", "rejected", "snoozed", "explicit_non_action"];

fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e21 && !number.is_u64() && !number.is_i64() => {
            format!("{}", f as i64)
        }
        _ => number.to_string(),
    }
}

fn object(body: &Value) -> Result<&Map<String, Value>, String> {
    body.as_object().ok_or_else(|| "body must be object".to_owned())
}

fn required(map: &Map<String, Value>, name: &str) -> Result<(), String> {
    if map.contains_key(name) {
        Ok(())
    } else {
        Err(format!("body must have required property '{name}'"))
    }
}

fn text(map: &Map<String, Value>, name: &str, min: usize) -> Result<Option<String>, String> {
    let at = format!("body/{name}");
    let value = match map.get(name) {
        None => return Ok(None),
        Some(Value::Null) => String::new(),
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => return Err(format!("{at} must be string")),
    };
    if value.chars().count() < min {
        return Err(format!("{at} must NOT have fewer than {min} characters"));
    }
    Ok(Some(value))
}

/// The old schema's union answer, word for word.
fn union_error(at: &str, count: usize) -> String {
    let one = format!("{at} must be equal to constant");
    format!("{}, {at} must match a schema in anyOf", vec![one; count].join(", "))
}

/// The optional `status` filter on the list route.
pub fn list_filter(status: Option<&Value>) -> Result<Option<String>, String> {
    let Some(value) = status else { return Ok(None) };
    match value.as_str() {
        Some(s) if STATUSES.contains(&s) => Ok(Some(s.to_owned())),
        _ => Err(union_error("querystring/status", STATUSES.len())),
    }
}

pub struct StatusChange {
    pub status: String,
    pub snoozed_until: Option<String>,
}

pub fn status_change(body: &Value) -> Result<StatusChange, String> {
    let map = object(body)?;
    required(map, "status")?;
    let status = text(map, "status", 0)?.unwrap_or_default();
    if !SETTABLE.contains(&status.as_str()) {
        return Err(union_error("body/status", SETTABLE.len()));
    }
    let snoozed_until = text(map, "snoozedUntil", 0)?;
    if let Some(v) = &snoozed_until {
        if chrono::DateTime::parse_from_rfc3339(v).is_err() {
            return Err("body/snoozedUntil must match format \"date-time\"".into());
        }
    }
    Ok(StatusChange { status, snoozed_until })
}

pub fn resolution_ref(body: &Value) -> Result<String, String> {
    let map = object(body)?;
    required(map, "resolutionRef")?;
    Ok(text(map, "resolutionRef", 1)?.unwrap_or_default())
}

pub fn suppressed_by(body: &Value) -> Result<String, String> {
    let map = object(body)?;
    required(map, "suppressedBy")?;
    Ok(text(map, "suppressedBy", 1)?.unwrap_or_default())
}

/// The extract body names one source kind. Anything else gets the old union answer.
pub fn extract_source(body: &Value) -> Result<String, String> {
    let map = object(body)?;
    required(map, "sourceKind")?;
    match map.get("sourceKind").and_then(Value::as_str) {
        Some(k @ ("chat" | "email" | "notes")) => Ok(k.to_owned()),
        _ => Err(union_error("body/sourceKind", 3)),
    }
}
