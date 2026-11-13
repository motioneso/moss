//! The hourly sweep. It runs as the person whose schedule it is, so it only ever sees their rows.
use crate::store::{call, lock};
use moss_module_sdk::{Host, Result};
use serde_json::json;

pub const QUEUE: &str = "backtrack.upkeep";
/// Minute 7 of every hour.
pub const CRON: &str = "7 * * * *";

/// Removes this person's text older than 37 days and deletion markers older than 38 days.
pub fn run<H: Host + ?Sized>(host: &H) -> Result<String> {
    lock(host)?;
    let done = call(host, "upkeep", json!({}))?;
    Ok(json!({
        "segments": done["segments"].as_u64().unwrap_or(0),
        "markers": done["markers"].as_u64().unwrap_or(0),
    })
    .to_string())
}

/// Makes sure this person's hourly sweep is scheduled. A failure never fails the request.
pub fn keep_scheduled<H: Host + ?Sized>(host: &H) {
    let _ = host.call(
        "jobs",
        "schedule",
        QUEUE,
        json!({"cron": CRON, "timezone": "UTC", "key": "backtrack-upkeep", "params": {}}),
    );
}
