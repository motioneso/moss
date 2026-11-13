//! Guest side of the Backtrack store. The host runs the SQL under the caller's own row policies.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

pub const STORE: &str = "backtrack.store";

pub fn call<H: Host + ?Sized>(host: &H, operation: &str, parameters: Value) -> Result<Value> {
    host.call("kv", operation, STORE, parameters)
}

/// The host's clock for this call.
pub fn now<H: Host + ?Sized>(host: &H) -> Result<chrono::DateTime<chrono::Utc>> {
    let context = host.call("context", "read", "call", json!({}))?;
    context["now"]
        .as_str()
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.with_timezone(&chrono::Utc))
        .ok_or_else(|| moss_module_sdk::Error::new("Host clock unavailable"))
}

/// Takes this person's Backtrack lock for the rest of the call. Ingest, delete and the hourly
/// sweep all take it first, so a late upload can never undo a delete.
pub fn lock<H: Host + ?Sized>(host: &H) -> Result<()> {
    call(host, "lock", json!({})).map(|_| ())
}
