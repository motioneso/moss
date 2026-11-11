//! Request-body checks that match the old server's schema validation: required
//! properties first, extra properties dropped, scalars coerced, then the handler's
//! own trimming rules.
use crate::{Error, Result};
use serde_json::{Map, Value};

fn invalid(message: impl Into<String>) -> Error {
    Error::new(400, message)
}

pub fn object(body: &Value) -> Result<&Map<String, Value>> {
    body.as_object().ok_or_else(|| invalid("body must be object"))
}

pub fn required(body: &Map<String, Value>, names: &[&str]) -> Result<()> {
    for name in names {
        if !body.contains_key(*name) {
            return Err(invalid(format!(
                "body must have required property '{name}'"
            )));
        }
    }
    Ok(())
}

fn single(value: &Value) -> &Value {
    match value {
        Value::Array(items) if items.len() == 1 => &items[0],
        _ => value,
    }
}

pub fn string(value: &Value, path: &str) -> Result<String> {
    match single(value) {
        Value::String(text) => Ok(text.clone()),
        Value::Number(_) | Value::Bool(_) => Ok(single(value).to_string()),
        Value::Null => Ok(String::new()),
        _ => Err(invalid(format!("body/{path} must be string"))),
    }
}

pub fn boolean(value: &Value, path: &str) -> Result<bool> {
    match single(value) {
        Value::Bool(flag) => Ok(*flag),
        Value::Null => Ok(false),
        Value::Number(n) if n.as_f64() == Some(0.0) => Ok(false),
        Value::Number(n) if n.as_f64() == Some(1.0) => Ok(true),
        Value::String(text) if text == "true" => Ok(true),
        Value::String(text) if text == "false" => Ok(false),
        _ => Err(invalid(format!("body/{path} must be boolean"))),
    }
}

pub fn string_array(value: &Value, path: &str) -> Result<Vec<String>> {
    match value {
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, item)| string(item, &format!("{path}/{i}")))
            .collect(),
        scalar => Ok(vec![string(scalar, &format!("{path}/0"))?]),
    }
}

pub fn status(value: &Value) -> Result<String> {
    let text = string(value, "status")?;
    if matches!(text.as_str(), "active" | "error") {
        Ok(text)
    } else {
        Err(invalid("body/status must be equal to one of the allowed values"))
    }
}

pub fn token_payload(value: &Value) -> Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("body/tokenPayload must be object"))
}

/// The handler trims every string and refuses empty ones.
pub fn trimmed(text: &str, name: &str) -> Result<String> {
    let text = text.trim();
    if text.is_empty() {
        Err(invalid(format!("{name} must not be empty")))
    } else {
        Ok(text.to_string())
    }
}
