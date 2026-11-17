//! Request body checks, with the old handlers' status codes and wording.
use bytes::Bytes;
use safety_core::error::ApiError;
use serde_json::{Map, Value};

pub const SEND_WITHOUT_ASKING_MAX_TOOLS: usize = 500;
pub const KEPT_OUT_MAX_TOOLS: usize = 1000;
pub const TOOL_NAME_MAX_LENGTH: usize = 200;

pub fn bad(message: impl Into<String>) -> ApiError {
    ApiError::http(400, message)
}

/// A JSON object body. An empty body reads as `{}` only when `optional` is set.
pub fn object(body: &Bytes, optional: bool) -> Result<Map<String, Value>, ApiError> {
    if body.is_empty() && optional {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(bad("Expected JSON object body")),
    }
}

pub fn required_string(value: Option<&Value>, field: &str) -> Result<String, ApiError> {
    let Some(Value::String(text)) = value else {
        return Err(bad(format!("{field} must be a string")));
    };
    let text = if field == "name" { text.trim().to_owned() } else { text.clone() };
    if text.is_empty() {
        return Err(bad(format!("{field} must not be empty")));
    }
    Ok(text)
}

pub fn required_string_array(value: Option<&Value>, field: &str) -> Result<Vec<String>, ApiError> {
    let Some(Value::Array(items)) = value else {
        return Err(bad(format!("{field} must be an array")));
    };
    items.iter().enumerate().map(|(i, item)| required_string(Some(item), &format!("{field}[{i}]"))).collect()
}

pub fn http_url(value: Option<&Value>, field: &str) -> Result<String, ApiError> {
    let text = required_string(value, field)?;
    let parsed = url::Url::parse(&text).map_err(|_| bad(format!("{field} must be a valid URL")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(bad(format!("{field} must be an http or https URL")));
    }
    Ok(text)
}

pub fn kind(value: Option<&Value>) -> Result<String, ApiError> {
    match value.and_then(Value::as_str) {
        Some(kind @ ("mcp" | "openapi")) => Ok(kind.to_owned()),
        _ => Err(bad("kind must be \"mcp\" or \"openapi\"")),
    }
}

/// `None` clears the placement.
pub fn placement(value: Option<&Value>) -> Result<Option<Value>, ApiError> {
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value,
    };
    let Value::Object(object) = value else {
        return Err(bad("credentialPlacement must be a JSON object"));
    };
    let kind = object.get("kind").and_then(Value::as_str);
    if !matches!(kind, Some("bearer" | "header" | "query")) {
        return Err(bad("credentialPlacement.kind must be bearer, header, or query"));
    }
    let mut out = Map::new();
    out.insert("kind".into(), Value::String(kind.unwrap_or_default().to_owned()));
    if let Some(name) = object.get("name") {
        let Value::String(_) = name else {
            return Err(bad("credentialPlacement.name must be a string"));
        };
        out.insert("name".into(), name.clone());
    }
    Ok(Some(Value::Object(out)))
}

fn tool_names(body: &Map<String, Value>, max: usize, label: &str) -> Result<Vec<String>, ApiError> {
    let names = required_string_array(body.get("toolNames"), "toolNames")?;
    if names.is_empty() || names.len() > max {
        return Err(bad(format!("toolNames must hold 1 to {max} names")));
    }
    let _ = label;
    if names.iter().any(|n| n.chars().map(char::len_utf16).sum::<usize>() > TOOL_NAME_MAX_LENGTH) {
        return Err(bad("A tool name is too long"));
    }
    let mut seen = std::collections::BTreeSet::new();
    Ok(names.into_iter().filter(|n| seen.insert(n.clone())).collect())
}

pub fn send_without_asking(body: &Map<String, Value>) -> Result<(bool, Vec<String>), ApiError> {
    let Some(Value::Bool(allow)) = body.get("allow") else {
        return Err(bad("allow must be a boolean"));
    };
    Ok((*allow, tool_names(body, SEND_WITHOUT_ASKING_MAX_TOOLS, "send")?))
}

pub fn kept_out(body: &Map<String, Value>) -> Result<(bool, Vec<String>), ApiError> {
    let Some(Value::Bool(kept)) = body.get("keptOut") else {
        return Err(bad("keptOut must be a boolean"));
    };
    Ok((*kept, tool_names(body, KEPT_OUT_MAX_TOOLS, "kept")?))
}
