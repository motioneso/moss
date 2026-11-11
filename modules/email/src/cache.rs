//! The public API Connectors calls to fill the message cache. The guest checks the
//! shape and caps the excerpt. The host writes under the caller's row-level security.
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

pub const MAX_BODY_EXCERPT_CHARS: usize = 500;

fn bad(message: &str) -> Error {
    Error::new(400, message)
}

fn text(input: &Value, name: &str) -> Result<String> {
    match &input[name] {
        Value::String(text) if !text.is_empty() => Ok(text.clone()),
        _ => Err(bad(&format!("{name} is required"))),
    }
}

fn optional_text(input: &Value, name: &str) -> Result<Option<Value>> {
    match input.get(name) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(Value::String(text)) => Ok(Some(json!(text))),
        _ => Err(bad(&format!("{name} must be text"))),
    }
}

fn excerpt(value: Value) -> Value {
    match value.as_str() {
        Some(text) => json!(text.chars().take(MAX_BODY_EXCERPT_CHARS).collect::<String>()),
        None => value,
    }
}

fn recipients(input: &Value) -> Result<Option<Value>> {
    match input.get("recipients") {
        None => Ok(None),
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
            Ok(Some(Value::Array(items.clone())))
        }
        _ => Err(bad("recipients must be a list of text")),
    }
}

fn object(input: &Value, name: &str) -> Result<Option<Value>> {
    match input.get(name) {
        None => Ok(None),
        Some(value) if value.is_object() => Ok(Some(value.clone())),
        _ => Err(bad(&format!("{name} must be an object"))),
    }
}

/// Fields present in the request, checked. Absent fields stay absent.
fn fields(input: &Value) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    for name in ["snippet", "bodyExcerpt", "summary"] {
        if let Some(value) = optional_text(input, name)? {
            let value = if name == "bodyExcerpt" { excerpt(value) } else { value };
            out.insert(name.into(), value);
        }
    }
    for name in ["sender", "subject", "receivedAt"] {
        if input.get(name).is_some() {
            out.insert(name.into(), json!(text(input, name)?));
        }
    }
    if let Some(value) = recipients(input)? {
        out.insert("recipients".into(), value);
    }
    for name in ["externalMetadata", "signals"] {
        if let Some(value) = object(input, name)? {
            out.insert(name.into(), value);
        }
    }
    Ok(out)
}

fn written(result: Value) -> Result<Value> {
    if result.is_null() {
        return Err(Error::new(404, "Email message not found"));
    }
    if result["rejected"] == true {
        return Err(bad("Email message was refused"));
    }
    Ok(json!({"message":result}))
}

/// Inserts a message, or replaces the content of the one the account already cached
/// under the same external id.
pub fn insert(host: &impl Host, input: &Value) -> Result<Value> {
    let mut fields = fields(input)?;
    for name in ["sender", "subject", "receivedAt"] {
        fields.insert(name.into(), json!(text(input, name)?));
    }
    let account = text(input, "connectorAccountId")?;
    let external = text(input, "externalId")?;
    written(kv(
        host,
        "set",
        "email.cache-write",
        json!({"action":"insert","connectorAccountId":account,"externalId":external,"fields":fields}),
    )?)
}

/// Changes only the named content fields of one cached message.
pub fn update(host: &impl Host, input: &Value) -> Result<Value> {
    let id = text(input, "id")?;
    let fields = fields(input)?;
    if fields.is_empty() {
        return Err(bad("Nothing to update"));
    }
    written(kv(
        host,
        "set",
        "email.cache-write",
        json!({"action":"update","id":id,"fields":fields}),
    )?)
}
