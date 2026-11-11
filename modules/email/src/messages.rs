//! Message routes. The host returns finished message objects under the caller's
//! row-level security, so a message the person may not see is simply absent.
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const PAGE: usize = 200;

/// Reads every visible message in bounded pages, so no single host answer grows with the mailbox.
pub fn list(host: &impl Host) -> Result<Value> {
    let mut all = Vec::new();
    loop {
        let page = kv(host, "get", "email.messages", json!({"limit":PAGE,"offset":all.len()}))?;
        let rows = page.as_array().ok_or_else(|| Error::new(500, "Internal server error"))?;
        all.extend(rows.iter().cloned());
        if rows.len() < PAGE {
            return Ok(json!({"messages":all}));
        }
    }
}

pub fn detail(host: &impl Host, id: &str) -> Result<Value> {
    let rows = kv(host, "get", "email.messages", json!({"id":id}))?;
    match rows.as_array().and_then(|rows| rows.first()) {
        Some(message) => Ok(json!({"message":message})),
        None => Err(Error::new(404, "Email message not found")),
    }
}
