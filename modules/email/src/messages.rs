//! Message routes. The host returns finished message objects under the caller's
//! row-level security, so a message the person may not see is simply absent.
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub fn list(host: &impl Host) -> Result<Value> {
    Ok(json!({"messages":kv(host, "get", "email.messages", json!({}))?}))
}

pub fn detail(host: &impl Host, id: &str) -> Result<Value> {
    let rows = kv(host, "get", "email.messages", json!({"id":id}))?;
    match rows.as_array().and_then(|rows| rows.first()) {
        Some(message) => Ok(json!({"message":message})),
        None => Err(Error::new(404, "Email message not found")),
    }
}
