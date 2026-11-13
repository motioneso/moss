//! The run job belongs to a later part. A delivery is accepted only when it is metadata only.
use moss_module_sdk::{Error, Result};
use serde_json::Value;

const KEYS: [&str; 2] = ["queue", "parameters"];

pub fn is_metadata_only(payload: &Value) -> bool {
    payload.as_object().is_some_and(|map| map.keys().all(|key| KEYS.contains(&key.as_str())))
}

pub fn handle(payload: &str) -> Result<String> {
    let value: Value = serde_json::from_str(payload).map_err(|_| Error::new("Invalid job"))?;
    if !is_metadata_only(&value) {
        return Err(Error::new("Job payload is not metadata only"));
    }
    Err(Error::new("The briefing run job is not part of this package yet"))
}
