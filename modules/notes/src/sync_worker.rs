//! Durable worker checkpoint seam. Not enabled in the ordinary package yet.
//! Private paths/hashes live in an owner-scoped table; jobs carry only its UUID.
//! Checkpoints are retained for retry after post-commit queue publication failure.
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub const TABLE: &str = "app.notes_sync_checkpoints";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resume {
    checkpoint_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    queue: String,
    parameters: Resume,
}

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let value: Value = serde_json::from_str(payload)?;
    if value["parameters"].get("checkpointId").is_none() {
        return crate::sync::handle(host, payload);
    }
    let job: Job = serde_json::from_value(value)?;
    if job.queue != "notes.sync" {
        return Err(unavailable());
    }
    uuid::Uuid::parse_str(&job.parameters.checkpoint_id).map_err(|_| unavailable())?;
    resume(host, job.parameters)
}

fn unavailable() -> Error {
    Error::new("Notes sync checkpoint is unavailable")
}

/// The surrounding transactional database adapter commits the checkpoint before
/// AfterCommitJobs publishes. Publication failure leaves it available to retry.
fn enqueue(host: &impl Host, checkpoint: Value) -> Result<Value> {
    let context = host.call("context", "read", "call", json!({}))?;
    let id = host.call("context", "uuid", "new", json!({}))?;
    let id = id["id"].as_str().ok_or_else(unavailable)?;
    uuid::Uuid::parse_str(id).map_err(|_| unavailable())?;
    let now = context["now"].as_str().ok_or_else(unavailable)?;
    Client(host).query(
        TABLE,
        &Query::insert([("id".into(), json!(id)), ("checkpoint".into(), checkpoint)].into()),
    )?;
    publish(host, id, now)?;
    Ok(json!({"checkpointId":id}))
}

fn publish(host: &impl Host, id: &str, now: &str) -> Result<()> {
    let result = host.call(
        "jobs",
        "enqueue-after-commit",
        "notes.sync",
        json!({
            "params":{"checkpointId":id},"idempotencyKey":id,"availableAt":now
        }),
    )?;
    if result["deferred"] != true {
        return Err(unavailable());
    }
    Ok(())
}

/// Trusted future manual-sync/chat join. It accepts no source, actor or content.
pub fn request(host: &impl Host) -> Result<Value> {
    enqueue(host, json!({}))
}

fn resume(host: &impl Host, input: Resume) -> Result<String> {
    let rows = Client(host).query(
        TABLE,
        &Query::select(Filter::eq("id", json!(input.checkpoint_id))),
    )?;
    let checkpoint = rows
        .first()
        .and_then(|row| row.get("checkpoint"))
        .ok_or_else(unavailable)?;
    let mut result = match crate::sync::checkpoint(host, checkpoint.clone()) {
        Ok(result) => result,
        Err(error) => {
            record(
                host,
                json!({"outcome":"failed","lastError":error.message()}),
            );
            return Err(error.into());
        }
    };
    if let Some(next) = result
        .as_object_mut()
        .and_then(|result| result.remove("continuation"))
    {
        // Record a deferred attempt so a later publication refusal can be shown,
        // while successful continuation pages leave the previous stats alone.
        record(host, json!({"outcome":"deferred"}));
        let saved = enqueue(host, next)?;
        result["checkpointId"] = saved["checkpointId"].clone();
    }
    if result["noOp"] != true && result["deferred"] != true {
        record(
            host,
            json!({"outcome":"completed","ingested":result["ingested"],"skipped":result["skipped"],"errors":result["errors"]}),
        );
    }
    // The raw coordinator result never leaves this worker with private paths.
    Ok(result.to_string())
}

/// The host persists after transaction finalization, including failed calls.
/// Like legacy, a status-write failure never changes the real sync result.
fn record(host: &impl Host, outcome: Value) {
    let _ = host.call("vault", "folder.record-sync", "source", outcome);
}
