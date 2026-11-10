//! Legacy HTTP request normalization. The preference port still accepts typed keys only.
use crate::{Error, Result};
use serde_json::{json, Map, Value};

fn invalid() -> Error {
    Error::coded(400, "FST_ERR_VALIDATION", "Bad Request")
}

const FIELDS: [(&str, &str); 7] = [
    ("lookaheadDays", "number"),
    ("prepTaskMode", "string"),
    ("timeBlockMode", "string"),
    ("suggestTasks", "boolean"),
    ("createTasks", "boolean"),
    ("suggestTimeBlocks", "boolean"),
    ("blockTime", "boolean"),
];

/// Fastify removes additional properties and coerces scalar/singleton-array values
/// before invoking the original route. Preserve that contract only at this boundary.
pub fn normalize(body: Value) -> Result<Value> {
    let object = body.as_object().ok_or_else(invalid)?;
    let mut output = Map::new();
    for (key, kind) in FIELDS {
        let Some(value) = object.get(key) else {
            continue;
        };
        let value = coerce(value, kind).ok_or_else(invalid)?;
        let allowed = match key {
            "lookaheadDays" => matches!(value.as_f64(), Some(0.0 | 1.0 | 2.0)),
            "prepTaskMode" | "timeBlockMode" => {
                matches!(value.as_str(), Some("off" | "suggest" | "auto"))
            }
            _ => true,
        };
        if !allowed {
            return Err(invalid());
        }
        let value = if key == "lookaheadDays" {
            json!(value.as_f64().unwrap() as u8)
        } else {
            value
        };
        output.insert(key.into(), value);
    }
    Ok(Value::Object(output))
}

fn coerce(value: &Value, kind: &str) -> Option<Value> {
    let value = match value {
        Value::Array(values) if values.len() == 1 => &values[0],
        _ => value,
    };
    match (kind, value) {
        ("number", Value::Number(_))
        | ("string", Value::String(_))
        | ("boolean", Value::Bool(_)) => Some(value.clone()),
        ("number", Value::Null) => Some(json!(0)),
        ("number", Value::Bool(value)) => Some(json!(u8::from(*value))),
        ("number", Value::String(value)) => {
            number(value).filter(|n| n.is_finite()).map(|n| json!(n))
        }
        ("boolean", Value::Null) => Some(json!(false)),
        ("boolean", Value::Number(n)) if n.as_f64() == Some(0.0) => Some(json!(false)),
        ("boolean", Value::Number(n)) if n.as_f64() == Some(1.0) => Some(json!(true)),
        ("boolean", Value::String(s)) if s == "false" => Some(json!(false)),
        ("boolean", Value::String(s)) if s == "true" => Some(json!(true)),
        _ => None,
    }
}

fn number(value: &str) -> Option<f64> {
    if value.is_empty() {
        return None;
    }
    // ECMAScript whitespace excludes the Unicode NEXT LINE character accepted by trim().
    let text =
        value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'));
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if text.to_ascii_lowercase().starts_with(prefix) {
            let digits = &text[2..];
            if digits.is_empty() {
                return None;
            }
            return digits.chars().try_fold(0.0, |n, c| {
                c.to_digit(radix)
                    .map(|v| n * f64::from(radix) + f64::from(v))
            });
        }
    }
    if !text
        .bytes()
        .all(|c| c.is_ascii_digit() || b"+-.eE".contains(&c))
    {
        return None;
    }
    text.parse::<f64>().ok().filter(|n| !n.is_nan())
}
