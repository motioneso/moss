//! The host captures the actor in its queue envelope; guest job input cannot select one.
use crate::{
    parse,
    repository::{Repository, Result},
};
use moss_module_sdk::Host;
use serde::Deserialize;
use serde_json::{json, Value};

pub const DEFERRED_STATUS: &str = "tasks-deferred-status";
pub const RECURRENCE: &str = "tasks-recurrence";

/// Keeps one nightly roll-forward schedule per account at 03:00 UTC. The stable key
/// makes repeat calls replace the schedule. Failures are swallowed so a scheduling
/// problem never fails the read or write that triggered it.
pub fn reconcile_recurrence_schedule<H: Host + ?Sized>(repo: &Repository<'_, H>) {
    let _ = repo.client.0.call(
        "jobs",
        "schedule",
        RECURRENCE,
        json!({"cron":"0 3 * * *","timezone":"UTC","key":"nightly","params":{}}),
    );
}

pub fn enqueue<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    id: &str,
    body: &Value,
) -> Result<Value> {
    let input = parse::parse_deferred_status(body)?;
    if repo.task(id)?.is_none() {
        return Err(crate::repository::Error::Http(404, "Task not found"));
    }
    // The legacy route never used idempotencyKey as a pg-boss singleton key.
    // The current host metadata schema cannot retain arbitrary string metadata.
    let _ = input.idempotency_key;
    let result = repo.client.0.call(
        "jobs",
        "enqueue",
        DEFERRED_STATUS,
        json!({"task-id":id, "requested-status":input.status.as_str()}),
    )?;
    Ok(json!({"jobId":result["id"]}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    queue: String,
    parameters: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Parameters {
    task_id: String,
    requested_status: crate::task_fields::TaskStatus,
}

pub fn handle<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    let job: Job = serde_json::from_str(payload)?;
    if job.queue == RECURRENCE {
        let rolled = crate::roll_forward::roll_forward_owned(&Repository::new(host))
            .map_err(|_| moss_module_sdk::Error::new("Tasks job failed"))?;
        return Ok(json!({"rolledForward":rolled}).to_string());
    }
    if job.queue != DEFERRED_STATUS {
        return Err(moss_module_sdk::Error::new("Unknown Tasks queue"));
    }
    let parameters: Parameters = serde_json::from_value(job.parameters)?;
    let body = json!({"status":parameters.requested_status.as_str()});
    let input = parse::parse_update_task(&body)
        .map_err(|_| moss_module_sdk::Error::new("Invalid job status"))?;
    let task = Repository::new(host)
        .update_task(&parameters.task_id, &input)
        .map_err(|_| moss_module_sdk::Error::new("Tasks job failed"))?;
    Ok(json!({"taskId":parameters.task_id,"updated":task.is_some(),"status":task.map(|t|t.status)}).to_string())
}
