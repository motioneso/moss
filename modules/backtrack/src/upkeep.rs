//! The hourly sweep. It runs as the person whose schedule it is, so it only ever sees their rows.
use crate::index::{enqueue, ids, remove_chunks};
use crate::store::{call, lock};
use moss_module_sdk::{Host, Result};
use serde_json::json;

pub const QUEUE: &str = "backtrack.upkeep";
/// Minute 7 of every hour.
/// Expired segments handled per round, matching what the store lists.
const EXPIRED_BATCH: usize = 500;
pub const CRON: &str = "7 * * * *";

/// Removes this person's text older than 37 days, with its search chunks, and deletion markers
/// older than 38 days. Text still unindexed after ten minutes is queued for indexing again.
pub fn run<H: Host + ?Sized>(host: &H) -> Result<String> {
    lock(host)?;
    let (mut segments, mut markers) = (0u64, 0u64);
    loop {
        let expired = ids(&call(host, "expired", json!({}))?);
        remove_chunks(host, &expired)?;
        let done = call(host, "upkeep", json!({"ids": expired}))?;
        segments += done["segments"].as_u64().unwrap_or(0);
        markers += done["markers"].as_u64().unwrap_or(0);
        if expired.len() < EXPIRED_BATCH {
            break;
        }
    }
    if call(host, "stale", json!({}))?["stale"].as_bool().unwrap_or(false) {
        enqueue(host);
    }
    Ok(json!({"segments": segments, "markers": markers}).to_string())
}

/// Makes sure this person's hourly sweep is scheduled. A failure never fails the request.
pub fn keep_scheduled<H: Host + ?Sized>(host: &H) {
    let _ = host.call(
        "jobs",
        "schedule",
        QUEUE,
        json!({"cron": CRON, "timezone": "UTC", "key": "backtrack-upkeep", "keepExisting": true, "params": {}}),
    );
}
