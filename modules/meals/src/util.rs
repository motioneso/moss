//! Small helpers shared by the Meals routes and tools.
use moss_module_sdk::{Response, Result};
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

/// The host clock and the signed-in person's id, in one call.
pub fn context<H: moss_module_sdk::Host + ?Sized>(host: &H) -> Result<(String, String)> {
    let context = host.call("context", "read", "call", json!({}))?;
    let field = |key: &str| {
        context[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| moss_module_sdk::Error::new("Host context unavailable"))
    };
    Ok((field("actorUserId")?, field("now")?))
}
