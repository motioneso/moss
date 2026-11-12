//! Background jobs. The only handler is the automatic summary, and its payload is metadata only.
use crate::output_service;
use crate::outputs;
use crate::stop_summary::{self, QUEUE};
use crate::text::is_uuid;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

pub const QUEUES: [&str; 3] = [
    "meetings.recording-notice",
    QUEUE,
    "meetings.recording-import",
];

/// The only keys a job payload may carry. Anything else could be private content.
pub const METADATA_KEYS: [&str; 2] = ["queue", "parameters"];

/// The only parameter a summary job carries is the meeting it is for.
const PARAMETER_KEYS: [&str; 1] = ["meeting-id"];

pub fn is_metadata_only(payload: &Value) -> bool {
    let top = payload.as_object().is_some_and(|map| map.keys().all(|key| METADATA_KEYS.contains(&key.as_str())));
    let parameters = payload["parameters"]
        .as_object()
        .is_none_or(|map| map.keys().all(|key| PARAMETER_KEYS.contains(&key.as_str())));
    top && parameters
}

fn refused() -> Error {
    Error::new("Invalid job")
}

pub fn handle<H: Host + ?Sized>(host: &H, payload: &str) -> Result<String> {
    let value: Value = serde_json::from_str(payload).map_err(|_| refused())?;
    if !is_metadata_only(&value) {
        return Err(Error::new("Job payload is not metadata only"));
    }
    if value["queue"] != QUEUE {
        return Err(Error::new("No Meetings job handler for this queue"));
    }
    let meeting = value["parameters"]["meeting-id"].as_str().filter(|id| is_uuid(id)).ok_or_else(refused)?;
    let meeting = meeting.to_lowercase();
    // A deleted meeting cascades its intent, but its job may still be queued.
    if outputs::inputs(host, &meeting, true)?.is_none() {
        return Ok(json!({"status": "gone"}).to_string());
    }
    let reply = outputs::call(host, "summary", &meeting, json!({}))?;
    let Some(key) = reply["row"]["request_key"].as_str() else {
        return Ok(json!({"status": "none"}).to_string());
    };
    let Some(input) = stop_summary::admit(host, &meeting, key)? else {
        return Ok(json!({"status": "skipped"}).to_string());
    };
    let (status, body) = output_service::generate(host, &meeting, &input)?;
    if status == 202 {
        return Err(Error::new("Automatic meeting summary remains pending"));
    }
    Ok(json!({"status": body["status"]}).to_string())
}
