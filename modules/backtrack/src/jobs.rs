//! Background jobs. A payload may carry only the queue name and no parameters.
use moss_module_sdk::{Error, Host, Result};
use serde_json::Value;

pub const QUEUES: [&str; 1] = [crate::upkeep::QUEUE];

/// The only keys a job payload may carry. Anything else could be private content.
pub const METADATA_KEYS: [&str; 2] = ["queue", "parameters"];

pub fn is_metadata_only(payload: &Value) -> bool {
    payload.as_object().is_some_and(|map| map.keys().all(|key| METADATA_KEYS.contains(&key.as_str())))
        && payload["parameters"].as_object().is_none_or(|map| map.is_empty())
}

pub fn handle<H: Host + ?Sized>(host: &H, payload: &str) -> Result<String> {
    let value: Value = serde_json::from_str(payload).map_err(|_| Error::new("Invalid job"))?;
    if !is_metadata_only(&value) {
        return Err(Error::new("Job payload is not metadata only"));
    }
    match value["queue"].as_str() {
        Some(crate::upkeep::QUEUE) => crate::upkeep::run(host),
        _ => Err(Error::new("No Backtrack job handler for this queue")),
    }
}
