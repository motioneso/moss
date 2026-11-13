//! The index job. It puts each stored segment's text into Memory's search index under the screen
//! source, and removes those chunks when the segment goes. Memory embeds through the router.
//! Chunk text only ever travels inside the call to Memory, never in a job payload or a log.
use crate::chunking::split_segment_text;
use crate::store::{call, lock, now};
use chrono::SecondsFormat;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

pub const QUEUE: &str = "backtrack.index";
pub const SOURCE_KIND: &str = "screen";
/// The most segments one run indexes before it queues another run.
pub const BATCH: usize = 200;
/// Memory deletes at most this many paths per call.
const DELETE_BATCH: usize = 500;

/// The path every chunk of one segment shares.
pub fn source_path(segment_id: &str) -> String {
    format!("backtrack/{segment_id}")
}

fn memory<H: Host + ?Sized>(host: &H, name: &str, parameters: Value) -> Result<Value> {
    let reply = host.call("api", "call", "memory", json!({"name": name, "parameters": parameters}))?;
    if reply.get("error").is_some() {
        return Err(Error::new("Memory refused the screen chunks"));
    }
    Ok(reply)
}

/// Removes the screen chunks of the given segments, in the batches Memory accepts.
pub fn remove_chunks<H: Host + ?Sized>(host: &H, ids: &[String]) -> Result<()> {
    for batch in ids.chunks(DELETE_BATCH) {
        let paths: Vec<String> = batch.iter().map(|id| source_path(id)).collect();
        memory(host, "deleteChunksForSources", json!({"sourceKind": SOURCE_KIND, "sourcePaths": paths}))?;
    }
    Ok(())
}

pub fn ids(value: &Value) -> Vec<String> {
    value["ids"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// Asks for an index run once the current request commits. A failure never fails the request,
/// because the hourly sweep queues unindexed text again.
pub fn enqueue<H: Host + ?Sized>(host: &H) {
    let _ = (|| -> Result<()> {
        let key = call(host, "index-key", json!({}))?;
        let at = now(host)?.to_rfc3339_opts(SecondsFormat::Millis, true);
        host.call("jobs", "enqueue-after-commit", QUEUE, json!({"params": {}, "idempotencyKey": key["key"], "availableAt": at}))?;
        Ok(())
    })();
}

/// Indexes this person's unindexed segments. Segments a delete or the sweep removed are not
/// listed, because both hold the same lock.
pub fn run<H: Host + ?Sized>(host: &H) -> Result<String> {
    lock(host)?;
    let pending = call(host, "pending", json!({}))?;
    let segments = pending["segments"].as_array().cloned().unwrap_or_default();
    let mut done: Vec<String> = Vec::new();
    let mut failed = None;
    for segment in &segments {
        let id = segment["id"].as_str().unwrap_or_default();
        let chunks = split_segment_text(
            segment["windowTitle"].as_str().unwrap_or_default(),
            segment["address"].as_str(),
            segment["body"].as_str().unwrap_or_default(),
        );
        if !chunks.is_empty() {
            let rows: Vec<Value> =
                chunks.iter().map(|c| json!({"lineStart": c.line_start, "lineEnd": c.line_end, "text": c.text})).collect();
            let sent = memory(
                host,
                "upsertChunks",
                json!({"sourceKind": SOURCE_KIND, "sourcePath": source_path(id), "chunks": rows, "replaceExisting": true}),
            );
            if let Err(error) = sent {
                failed = Some(error);
                break;
            }
        }
        done.push(id.to_owned());
    }
    if !done.is_empty() {
        call(host, "mark-indexed", json!({"ids": done}))?;
    }
    if let Some(error) = failed {
        return Err(error);
    }
    if segments.len() >= BATCH || pending["more"].as_bool().unwrap_or(false) {
        enqueue(host);
    }
    Ok(json!({"indexed": done.len()}).to_string())
}
