//! Request body checks that give the answers the old route schema gave. The old server coerced
//! numbers and booleans to text, dropped unknown fields and reported the first failure.
use serde_json::{Map, Value};

const OBJECT: &str = "body must be object";

fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e21 && !number.is_u64() && !number.is_i64() => {
            format!("{}", f as i64)
        }
        _ => number.to_string(),
    }
}

fn object(body: &Value) -> Result<&Map<String, Value>, String> {
    body.as_object().ok_or_else(|| OBJECT.to_owned())
}

fn required(map: &Map<String, Value>, names: &[&str]) -> Result<(), String> {
    for name in names {
        if !map.contains_key(*name) {
            return Err(format!("body must have required property '{name}'"));
        }
    }
    Ok(())
}

/// A text field as the old schema read it, or `None` when it is absent.
fn text(map: &Map<String, Value>, name: &str, min: usize, max: usize) -> Result<Option<String>, String> {
    let at = format!("body/{name}");
    let value = match map.get(name) {
        None => return Ok(None),
        Some(Value::Null) => String::new(),
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => return Err(format!("{at} must be string")),
    };
    let length = value.chars().count();
    if length < min {
        return Err(format!("{at} must NOT have fewer than {min} characters"));
    }
    if length > max {
        return Err(format!("{at} must NOT have more than {max} characters"));
    }
    Ok(Some(value))
}

/// `{kind, key}` for a new saved choice.
pub fn new_pref(body: &Value) -> Result<(String, String), String> {
    let map = object(body)?;
    required(map, &["kind", "key"])?;
    let kind = text(map, "kind", 0, usize::MAX)?.unwrap_or_default();
    if !["source", "source_exclude", "topic"].contains(&kind.as_str()) {
        return Err("body/kind must be equal to one of the allowed values".into());
    }
    let key = text(map, "key", 1, 100)?.unwrap_or_default();
    Ok((kind, key))
}

/// `{source}` for a new excluded publisher.
pub fn new_exclusion(body: &Value) -> Result<String, String> {
    let map = object(body)?;
    required(map, &["source"])?;
    Ok(text(map, "source", 1, 2048)?.unwrap_or_default())
}

/// `{label, guidance?}` for a new topic.
pub fn new_topic(body: &Value) -> Result<(String, Option<String>), String> {
    let map = object(body)?;
    required(map, &["label"])?;
    let label = text(map, "label", 1, 80)?.unwrap_or_default();
    Ok((label, text(map, "guidance", 0, 1000)?))
}

/// `{label?, guidance?}` for a topic change. An object with no properties is refused.
pub fn topic_change(body: &Value) -> Result<(Option<String>, Option<String>), String> {
    let map = object(body)?;
    if map.is_empty() {
        return Err("body must NOT have fewer than 1 properties".into());
    }
    Ok((text(map, "label", 1, 80)?, text(map, "guidance", 0, 1000)?))
}

/// `{input, replaceSourceId?}` for a source preview.
pub fn source_preview(body: &Value) -> Result<(String, Option<String>), String> {
    let map = object(body)?;
    required(map, &["input"])?;
    let input = text(map, "input", 1, 512)?.unwrap_or_default();
    let replace = text(map, "replaceSourceId", 0, usize::MAX)?;
    if let Some(id) = &replace {
        if !crate::util::is_uuid(id) {
            return Err("body/replaceSourceId must match format \"uuid\"".into());
        }
    }
    Ok((input, replace))
}

/// `{confirmationId, candidateId?}` for saving a previewed source.
pub fn source_confirm(body: &Value) -> Result<(String, Option<String>), String> {
    let map = object(body)?;
    required(map, &["confirmationId"])?;
    let confirmation = text(map, "confirmationId", 1, 256)?.unwrap_or_default();
    Ok((confirmation, text(map, "candidateId", 1, 256)?))
}
