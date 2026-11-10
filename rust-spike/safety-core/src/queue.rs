//! The Phase 0b stand-in job queue (`spike_jobs.jobs`), moved here so its connection stays
//! inside this crate. Jobs are queued inside the caller's data context, so a job exists only
//! if the request's transaction commits, and only a [`JobPayload`] can be queued. The real
//! queue replaces this in a later part of Phase 2.

use deadpool_postgres::Object;
use serde_json::Value;
use uuid::Uuid;

use crate::db::{DataContext, Database, RuntimeRole};
use crate::error::ApiError;
use crate::payload::JobPayload;

/// Queues a job and returns its id. The id is made here because the app role cannot read
/// queue rows back.
pub async fn enqueue(
    cx: &DataContext,
    queue: &str,
    payload: &JobPayload,
) -> Result<Uuid, ApiError> {
    let id = Uuid::new_v4();
    cx.db()
        .execute(
            "INSERT INTO spike_jobs.jobs (id, queue, data) VALUES ($1, $2, $3)",
            &[&id, &queue, &payload.to_json()],
        )
        .await?;
    Ok(id)
}

/// A job taken off the queue; finish it with [`ClaimedJob::finish`].
pub struct ClaimedJob {
    pub id: Uuid,
    pub data: Value,
    client: Object,
}

/// Claims the oldest waiting job in `queue`, on the worker role.
pub async fn claim(worker: &Database, queue: &str) -> Result<Option<ClaimedJob>, ApiError> {
    if worker.role() != RuntimeRole::Worker {
        return Err(ApiError::Internal(
            "jobs are claimed on the worker role".into(),
        ));
    }
    let client = worker.client().await?;
    let claimed = client
        .query_opt(
            "UPDATE spike_jobs.jobs SET state = 'active', started_at = now() \
             WHERE id = (SELECT id FROM spike_jobs.jobs \
                         WHERE queue = $1 AND state = 'created' \
                         ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) \
             RETURNING id, data",
            &[&queue],
        )
        .await?;
    Ok(claimed.map(|row| ClaimedJob {
        id: row.get("id"),
        data: row.get("data"),
        client,
    }))
}

impl ClaimedJob {
    pub async fn finish(self, succeeded: bool, output: &Value) -> Result<(), ApiError> {
        let state = if succeeded { "completed" } else { "failed" };
        self.client
            .execute(
                "UPDATE spike_jobs.jobs SET state = $2, output = $3, completed_at = now() \
                 WHERE id = $1",
                &[&self.id, &state, output],
            )
            .await?;
        Ok(())
    }
}
