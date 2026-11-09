//! Durable worker checkpoint seam. Not enabled in the ordinary package yet.
//! Private paths/hashes live in an owner-scoped table; jobs carry only its UUID.
//! Checkpoints are retained for retry after post-commit queue publication failure.
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const TABLE: &str = "app.notes_sync_checkpoints";

/// Only fixed counts, flags and an opaque child ID may leave a saved page.
/// This also refuses malformed persisted results before they can reach a job.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageResult {
    ingested: u64,
    skipped: u64,
    errors: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    no_op: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checkpoint_id: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedPage {
    worker_result: PageResult,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resume {
    #[serde(rename = "checkpoint-id", alias = "checkpointId")]
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
    if value["parameters"].get("checkpoint-id").is_none()
        && value["parameters"].get("checkpointId").is_none()
    {
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

pub(crate) fn publish(host: &impl Host, id: &str, now: &str) -> Result<()> {
    let result = host.call(
        "jobs",
        "enqueue-after-commit",
        "notes.sync",
        json!({
            "params":{"checkpoint-id":id},"idempotencyKey":id,"availableAt":now
        }),
    )?;
    if result["deferred"] != true {
        return Err(unavailable());
    }
    Ok(())
}

/// Read the authenticated account's saved source, matching the legacy manual
/// request. Filesystem resolution remains worker work. Never accept a caller path.
pub(crate) fn selected_source(host: &impl Host) -> Result<Option<String>> {
    let source: moss_module_sdk::Response = serde_json::from_value(
        host.call("vault", "folder.get", "source", json!({}))
            .map_err(|_| unavailable())?,
    )
    .map_err(|_| unavailable())?;
    if source.status != 200 {
        return Err(unavailable());
    }
    Ok(source
        .body
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned))
}

/// Trusted future sync/chat join. It accepts no source, actor or content.
pub fn request(host: &impl Host) -> Result<Value> {
    let source =
        selected_source(host)?.ok_or_else(|| Error::new("Notes source is not configured"))?;
    request_source(host, &source)
}

/// Preserve the HTTP handler's server-read source in private durable state,
/// never in the queue envelope. A later folder change cannot retarget this job.
pub(crate) fn request_source(host: &impl Host, source: &str) -> Result<Value> {
    enqueue(host, json!({"sourcePath":source}))
}

fn resume(host: &impl Host, input: Resume) -> Result<String> {
    let rows = Client(host).query(
        TABLE,
        // A no-op UPDATE takes a row lock until outer-call finalization and
        // returns the latest committed state after a competing worker finishes.
        // Assembly MUST use TransactionalDatabasePorts for this worker.
        &Query::update(
            Filter::eq("id", json!(input.checkpoint_id)),
            [("id".into(), json!(input.checkpoint_id))].into(),
        ),
    )?;
    let checkpoint = rows
        .first()
        .and_then(|row| row.get("checkpoint"))
        .ok_or_else(unavailable)?;
    if checkpoint.get("workerResult").is_some() {
        let saved: SavedPage =
            serde_json::from_value(checkpoint.clone()).map_err(|_| unavailable())?;
        let result = saved.worker_result;
        if result.deferred == Some(true) {
            let id = result.checkpoint_id.as_deref().ok_or_else(unavailable)?;
            uuid::Uuid::parse_str(id).map_err(|_| unavailable())?;
            record(host, json!({"outcome":"deferred"}));
            let context = host.call("context", "read", "call", json!({}))?;
            publish(host, id, context["now"].as_str().ok_or_else(unavailable)?)?;
        } else if result.checkpoint_id.is_some() {
            return Err(unavailable());
        }
        // A replay must not overwrite a newer successful sync status.
        return Ok(serde_json::to_value(result)?.to_string());
    }
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
        // Each invocation records one outcome; deferred pages skip completion below.
        record(host, json!({"outcome":"deferred"}));
        let saved = enqueue(host, next)?;
        result["checkpointId"] = saved["checkpointId"].clone();
    }
    let saved = SavedPage {
        worker_result: serde_json::from_value(result.clone()).map_err(|_| unavailable())?,
    };
    let updated = Client(host).query(
        TABLE,
        &Query::update(
            Filter::eq("id", json!(input.checkpoint_id)),
            [("checkpoint".into(), serde_json::to_value(saved)?)].into(),
        ),
    )?;
    if updated.len() != 1 {
        return Err(unavailable());
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
