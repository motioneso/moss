//! One background job, the deferred task status change. The deferred-status route queues it as
//! the app role, and a worker runs it under the worker role inside the actor's data context.
//!
//! A small table in `spike_jobs` stands in for pg-boss (`sql/0001_spike_job_queue.sql`). The
//! payload, queue name, poll interval and result shape follow `packages/tasks/src/jobs.ts`.

use std::time::Duration;

use deadpool_postgres::Pool;
use serde_json::{json, Map, Value};
use tokio::sync::watch;
use uuid::Uuid;

use crate::auth::is_uuid;
use crate::db::{AccessContext, DataContext};
use crate::error::ApiError;
use crate::model::TaskStatus;
use crate::parse::{Patch, TaskFields};
use crate::repo;

pub const DEFERRED_STATUS_QUEUE: &str = "tasks-deferred-status";

const PAYLOAD_KEYS: &[&str] = &["actorUserId", "taskId", "requestedStatus", "idempotencyKey"];
const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub struct DeferredStatusPayload {
    pub actor_user_id: Uuid,
    pub task_id: String,
    pub requested_status: TaskStatus,
    pub idempotency_key: Option<String>,
}

impl DeferredStatusPayload {
    /// Ids, the requested status and the idempotency key, and nothing else.
    fn to_json(&self) -> Value {
        let mut data = Map::new();
        data.insert("actorUserId".into(), json!(self.actor_user_id));
        data.insert("taskId".into(), json!(self.task_id));
        data.insert("requestedStatus".into(), json!(self.requested_status.as_str()));
        if let Some(key) = &self.idempotency_key {
            data.insert("idempotencyKey".into(), json!(key));
        }
        Value::Object(data)
    }
}

/// Queues the job and returns its id. The id is made here because the app role cannot read
/// queue rows back.
pub async fn send(pool: &Pool, payload: &DeferredStatusPayload) -> Result<Uuid, ApiError> {
    let id = Uuid::new_v4();
    let client = pool.get().await?;
    client
        .execute(
            "INSERT INTO spike_jobs.jobs (id, queue, data) VALUES ($1, $2, $3)",
            &[&id, &DEFERRED_STATUS_QUEUE, &payload.to_json()],
        )
        .await?;
    Ok(id)
}

/// Polls the queue until `shutdown` turns true.
pub async fn run_worker(pool: Pool, mut shutdown: watch::Receiver<bool>) {
    while !*shutdown.borrow() {
        match run_next(&pool).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => eprintln!("tasks worker: {error}"),
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
            _ = shutdown.changed() => {}
        }
    }
}

/// Claims the oldest waiting job, runs it, and records the outcome. Returns whether a job ran.
async fn run_next(pool: &Pool) -> Result<bool, String> {
    let client = pool.get().await.map_err(|error| error.to_string())?;
    let claimed = client
        .query_opt(
            "UPDATE spike_jobs.jobs SET state = 'active', started_at = now() \
             WHERE id = (SELECT id FROM spike_jobs.jobs \
                         WHERE queue = $1 AND state = 'created' \
                         ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) \
             RETURNING id, data",
            &[&DEFERRED_STATUS_QUEUE],
        )
        .await
        .map_err(|error| error.to_string())?;
    let Some(row) = claimed else { return Ok(false) };
    let job_id: Uuid = row.get("id");
    let data: Value = row.get("data");

    let (state, output) = match run_deferred_status(pool, job_id, &data).await {
        Ok(result) => ("completed", result),
        Err(message) => ("failed", json!({ "message": message })),
    };
    client
        .execute(
            "UPDATE spike_jobs.jobs SET state = $2, output = $3, completed_at = now() \
             WHERE id = $1",
            &[&job_id, &state, &output],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// The job body: the actor checks from `registerDataContextWorker`, then `updateStatus` in the
/// actor's data context. Returns `{ taskId, updated, status }`.
async fn run_deferred_status(pool: &Pool, job_id: Uuid, data: &Value) -> Result<Value, String> {
    let payload = data.as_object().ok_or_else(|| format!("Job {job_id} has no payload"))?;
    let actor = payload
        .get("actorUserId")
        .and_then(Value::as_str)
        .filter(|actor| !actor.is_empty())
        .ok_or_else(|| format!("Job {job_id} is missing actorUserId"))?;
    if !is_uuid(actor) {
        return Err(format!("Job {job_id} actorUserId must be a UUID"));
    }
    let access = AccessContext {
        actor_user_id: Uuid::parse_str(actor).map_err(|error| error.to_string())?,
        request_id: format!("pgboss:{job_id}"),
    };

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
    let cx = DataContext::open(pool, &access).await.map_err(describe)?;
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
