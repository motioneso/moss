//! One background job, the deferred task status change. The deferred-status route queues it in
//! the request's data context, and a worker runs it under the worker role inside the actor's
//! data context.
//!
//! The platform's stand-in queue replaces pg-boss. The queue name, poll interval, payload field
//! names and result shape follow `packages/tasks/src/jobs.ts`. The payload carries the
//! idempotency key as a hash, so client text never reaches the queue.

use std::time::Duration;

use platform::access::AccessContext;
use platform::auth::is_uuid;
use platform::db::{DataContext, Database};
use platform::error::ApiError;
use platform::http::log;
use platform::payload::JobPayload;
use platform::queue;
use serde_json::{json, Value};
use tokio::sync::watch;
use uuid::Uuid;

use crate::model::TaskStatus;
use crate::parse::{Patch, TaskFields};
use crate::repo;

pub const DEFERRED_STATUS_QUEUE: &str = "tasks-deferred-status";

const PAYLOAD_KEYS: &[&str] = &["actorUserId", "taskId", "requestedStatus", "idempotencyKey"];
const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub struct DeferredStatus {
    pub task_id: Uuid,
    pub status: TaskStatus,
    pub idempotency_key: Option<String>,
}

/// Queues the status change in the caller's data context and returns the job id.
pub async fn send(cx: &DataContext, request: &DeferredStatus) -> Result<Uuid, ApiError> {
    let mut payload = JobPayload::builder()
        .id("actorUserId", cx.actor_user_id())
        .id("taskId", request.task_id)
        .choice("requestedStatus", request.status.as_str());
    if let Some(key) = &request.idempotency_key {
        payload = payload.key_hash("idempotencyKey", key);
    }
    let payload = payload
        .build()
        .map_err(|error| ApiError::Internal(format!("deferred status payload: {error:?}")))?;
    queue::enqueue(cx, DEFERRED_STATUS_QUEUE, &payload).await
}

/// Polls the queue until `shutdown` turns true.
pub async fn run_worker(worker: Database, mut shutdown: watch::Receiver<bool>) {
    while !*shutdown.borrow() {
        match run_next(&worker).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => log(json!({
                "level": "error",
                "event": "tasks.worker_error",
                "message": format!("{error:?}"),
            })),
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
            _ = shutdown.changed() => {}
        }
    }
}

/// Claims the oldest waiting job, runs it, and records the outcome. Returns whether a job ran.
async fn run_next(worker: &Database) -> Result<bool, ApiError> {
    let Some(job) = queue::claim(worker, DEFERRED_STATUS_QUEUE).await? else {
        return Ok(false);
    };
    let (succeeded, output) = match run_deferred_status(worker, job.id, &job.data).await {
        Ok(result) => (true, result),
        Err(message) => (false, json!({ "message": message })),
    };
    job.finish(succeeded, &output).await?;
    Ok(true)
}

/// The job body: the actor checks from `registerDataContextWorker`, then `updateStatus` in the
/// actor's data context. Returns `{ taskId, updated, status }`.
async fn run_deferred_status(
    worker: &Database,
    job_id: Uuid,
    data: &Value,
) -> Result<Value, String> {
    let payload = data.as_object().ok_or_else(|| format!("Job {job_id} has no payload"))?;
    let actor = payload
        .get("actorUserId")
        .and_then(Value::as_str)
        .filter(|actor| !actor.is_empty())
        .ok_or_else(|| format!("Job {job_id} is missing actorUserId"))?;
    if !is_uuid(actor) {
        return Err(format!("Job {job_id} actorUserId must be a UUID"));
    }
    let actor = Uuid::parse_str(actor).map_err(|error| error.to_string())?;
    let access = AccessContext::new(actor, format!("pgboss:{job_id}"));

    if !payload.keys().all(|key| PAYLOAD_KEYS.contains(&key.as_str())) {
        return Err(format!("Task job {job_id} contains non-metadata payload fields"));
    }
    let task_id = payload.get("taskId").and_then(Value::as_str).unwrap_or_default();
    let status = match payload.get("requestedStatus").and_then(Value::as_str) {
        Some("todo") => TaskStatus::Todo,
        Some("done") => TaskStatus::Done,
        Some("archived") => TaskStatus::Archived,
        other => return Err(format!("Job {job_id} has an unknown status {other:?}")),
    };

    let describe = |error: ApiError| format!("{error:?}");
    let cx = DataContext::open(worker, &access).await.map_err(describe)?;
    let task = repo::update(&cx, task_id, &status_only(status)).await.map_err(describe)?;
    cx.commit().await.map_err(describe)?;
    Ok(json!({
        "taskId": task_id,
        "updated": task.is_some(),
        "status": task.map(|task| task.status),
    }))
}

fn status_only(status: TaskStatus) -> TaskFields {
    TaskFields {
        title: None,
        description: Patch::Keep,
        status: Some(status),
        priority: Patch::Keep,
        due_at: Patch::Keep,
        list_id: None,
        do_at: Patch::Keep,
        effort: Patch::Keep,
        parent_task_id: Patch::Keep,
        recurrence: Patch::Keep,
    }
}
