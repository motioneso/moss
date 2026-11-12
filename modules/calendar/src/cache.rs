//! The public API Connectors calls to fill the event cache. The guest checks the shape.
//! The host writes under the caller's row-level security.
use crate::{Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

fn bad(message: &str) -> Error {
    Error::new(400, message)
}

fn text(input: &Value, name: &str) -> Result<String> {
    match &input[name] {
        Value::String(text) if !text.trim().is_empty() => Ok(text.clone()),
        _ => Err(bad(&format!("{name} is required"))),
    }
}

fn optional_text(input: &Value, name: &str) -> Result<Value> {
    match input.get(name) {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(text)) => Ok(json!(text)),
        _ => Err(bad(&format!("{name} must be text"))),
    }
}

/// Adds an event, or replaces the content of the one the account already cached under
/// the same external id. Saved metadata keys the new request leaves out stay.
pub fn upsert(host: &impl Host, input: &Value) -> Result<Value> {
    let metadata = match input.get("externalMetadata") {
        None => json!({}),
        Some(value) if value.is_object() => value.clone(),
        _ => return Err(bad("externalMetadata must be an object")),
    };
    let mut event = Map::new();
    for name in ["title", "startsAt", "endsAt"] {
        event.insert(name.into(), json!(text(input, name)?));
    }
    for name in ["location", "summary", "bodyExcerpt"] {
        event.insert(name.into(), optional_text(input, name)?);
    }
    event.insert("externalMetadata".into(), metadata);
    let result = host.call(
        "kv",
        "set",
        "calendar.cache-write",
        json!({
            "action":"upsert",
            "connectorAccountId":text(input, "connectorAccountId")?,
            "externalId":text(input, "externalId")?,
            "event":event,
        }),
    )?;
    if result["rejected"] == true {
        return Err(bad("Calendar event was refused"));
    }
    Ok(json!({"event":result}))
}

/// Deletes the account's cached events that no sync has touched since the given time.
pub fn prune(host: &impl Host, input: &Value) -> Result<Value> {
    let result = host.call(
        "kv",
        "set",
        "calendar.cache-write",
        json!({
            "action":"prune",
            "connectorAccountId":text(input, "connectorAccountId")?,
            "seenSince":text(input, "seenSince")?,
        }),
    )?;
    Ok(json!({"deleted":result["deleted"].as_i64().unwrap_or(0)}))
}
