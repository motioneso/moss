//! Metadata-only queue declarations. No handler runs in this part.
use moss_module_sdk::{Error, Result};
use serde_json::Value;

pub const QUEUES: [&str; 3] = [
    "meetings.recording-notice",
    "meetings.stop-summary",
    "meetings.recording-import",
];

/// The only keys a job payload may carry. Anything else could be private content.
pub const METADATA_KEYS: [&str; 6] = [
    "actorUserId",
    "meetingId",
    "kind",
    "idempotencyKey",
    "requestId",
    "params",
];

pub fn is_metadata_only(payload: &Value) -> bool {
    payload
        .as_object()
        .is_some_and(|map| map.keys().all(|key| METADATA_KEYS.contains(&key.as_str())))
}

/// Part 1 declares the queues but owns no handler, so every job is refused.
pub fn handle(payload: &str) -> Result<String> {
    let value: Value = serde_json::from_str(payload).map_err(|_| Error::new("Invalid job"))?;
    if !is_metadata_only(&value) {
        return Err(Error::new("Job payload is not metadata only"));
    }
    Err(Error::new("No Meetings job handler yet"))
}
