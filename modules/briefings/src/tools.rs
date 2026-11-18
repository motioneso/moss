//! Chat tools. `briefings.rerun` queues one manual run of the caller's own briefing and
//! `briefings.getRunStatus` reports one run. The host picks the person and applies the approval
//! rules, so nothing here takes a person from the request. Run text is outside text.
use crate::queue::{self, Job, JobState, Started};
use crate::runs::{self, is_fallback, is_uuid, TABLE as RUNS};
use crate::util::{call, iso};
use crate::definitions;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Digest;

pub const RERUN: &str = "briefings.rerun";
pub const STATUS: &str = "briefings.getRunStatus";
pub const TYPES: [&str; 3] = ["morning", "evening", "weekly_review"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolRequest {
    pub tool: String,
    pub parameters: Value,
    pub approval_version: Option<String>,
}

fn refusal(message: &str) -> Value {
    json!({"data":{"error":message}})
}

/// The text a reader sees. A run written without the model has none.
fn display(row: &Value) -> Value {
    if is_fallback(&row["source_metadata"]) {
        return json!("");
    }
    row["summary_text"].clone()
}

pub fn handle<H: Host + ?Sized>(host: &H, request: ToolRequest) -> Result<Value> {
    match request.tool.as_str() {
        RERUN => rerun(host, &request),
        STATUS => status(host, &request.parameters),
        _ => Err(Error::new("Unknown Briefings tool")),
    }
}

/// The keys a re-run names, or the message that says what was wrong.
pub(crate) fn selector(input: &Value) -> std::result::Result<(Option<&str>, Option<&str>), &'static str> {
    let Some(fields) = input.as_object() else { return Err("Invalid Briefings tool input") };
    if fields.keys().any(|k| k != "definitionId" && k != "briefingType") {
        return Err("Invalid Briefings tool input");
    }
    let text = |key: &str| match fields.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err("Invalid Briefings tool input"),
    };
    let (id, kind) = (text("definitionId")?, text("briefingType")?);
    if id.is_some() == kind.is_some() {
        return Err("Give exactly one of briefingType or definitionId");
    }
    if kind.is_some_and(|k| !TYPES.contains(&k)) {
        return Err("briefingType must be morning, evening or weekly_review");
    }
    Ok((id, kind))
}

/// The caller's own definition the selector names. Another person's, shared or not, is absent.
pub(crate) fn resolve_owned<H: Host + ?Sized>(
    host: &H,
    actor: &str,
    id: Option<&str>,
    kind: Option<&str>,
) -> Result<Option<Value>> {
    match (id, kind) {
        (Some(id), _) if is_uuid(id) => Ok(definitions::find(host, id)?
            .filter(|row| row["owner_user_id"].as_str() == Some(actor))),
        (Some(_), _) => Ok(None),
        (None, Some(kind)) => definitions::owned_of_type(host, actor, kind),
        (None, None) => Ok(None),
    }
}

/// Binds an approval to the briefing it showed. A changed definition needs a fresh card.
pub(crate) fn version(definition: &Value) -> Result<String> {
    // A hash keeps the version inside the host's length limit however many tools are selected.
    let parts = json!([definition["id"], iso(&definition["updated_at"])?, definition["selected_tool_names"]]);
    Ok(format!("{:x}", sha2::Sha256::digest(parts.to_string().as_bytes())))
}

fn outcome(status: &str, definition: &Value, job: Option<(&str, Option<&str>)>) -> Value {
    json!({"data":{
        "status": status,
        "definitionId": definition["id"],
        "briefingType": definition["briefing_type"],
        "runId": job.and_then(|(_, run)| run),
        "jobId": job.map(|(id, _)| id),
    }})
}

fn running(definition: &Value, job: &Job) -> Value {
    outcome("already_running", definition, Some((&job.id, job.run_id.as_deref())))
}

fn rerun<H: Host + ?Sized>(host: &H, request: &ToolRequest) -> Result<Value> {
    let (id, kind) = match selector(&request.parameters) {
        Ok(pair) => pair,
        Err(message) => return Ok(refusal(message)),
    };
    let actor = call(host)?.actor;
    let Some(definition) = resolve_owned(host, &actor, id, kind)? else {
        return Ok(json!({"data":{
            "status": "no_briefing", "definitionId": null,
            "briefingType": kind, "runId": null, "jobId": null,
        }}));
    };
    // The approval named one version of this briefing. Anything newer needs a new card.
    if request.approval_version.as_deref() != Some(version(&definition)?.as_str()) {
        return Ok(refusal("Briefing changed since approval. Prepare the action again."));
    }
    let definition_id = definition["id"].as_str().unwrap_or_default();
    if let Some(job) = queue::find_open(host, definition_id)? {
        return Ok(running(&definition, &job));
    }
    let kind = definition["briefing_type"].as_str().unwrap_or("morning");
    match queue::start_manual(host, definition_id, kind, None)? {
        Started::Queued { job_id, run_id } => Ok(outcome("queued", &definition, Some((&job_id, Some(&run_id))))),
        Started::InFlight => match queue::find_open(host, definition_id)? {
            Some(job) => Ok(running(&definition, &job)),
            None => Err(Error::new("Briefing run could not be queued")),
        },
        Started::Failed => Err(Error::new("Briefing run could not be queued")),
    }
}

fn state(name: &str, run_id: Option<&str>) -> Value {
    json!({"data":{
        "state": name, "runId": run_id, "definitionId": null,
        "briefingType": null, "createdAt": null, "summaryText": null,
    }, "content": "outside"})
}

fn read_run(row: &Value) -> Result<Value> {
    let ready = row["status"] == "succeeded";
    Ok(json!({"data":{
        "state": if ready { "ready" } else { "failed" },
        "runId": row["id"],
        "definitionId": row["definition_id"],
        "briefingType": row["briefing_type"],
        "createdAt": iso(&row["created_at"])?,
        "summaryText": if ready { display(row) } else { Value::Null },
    }, "content": "outside"}))
}

fn owned_run<H: Host + ?Sized>(host: &H, actor: &str, id: &str) -> Result<Option<Value>> {
    let query = Query::select(Filter::And {
        filters: vec![Filter::eq("id", id), Filter::eq("owner_user_id", actor)],
    });
    Ok(Client(host).query(RUNS, &query)?.into_iter().next())
}

/// One run's state for the caller: ready with its text, pending, failed or not found. Another
/// person's run and a missing one look the same. A scheduled run has no run id while queued, so
/// it is followed by its job id and definition id.
fn status<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let Some(fields) = input.as_object() else { return Ok(refusal("Invalid Briefings tool input")) };
    if fields.keys().any(|k| !["runId", "jobId", "definitionId"].contains(&k.as_str()))
        || fields.values().any(|v| !v.is_string())
    {
        return Ok(refusal("Invalid Briefings tool input"));
    }
    let text = |key: &str| fields.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
    let (run_id, definition_id) = (text("runId"), text("definitionId"));
    let job_id = text("jobId").filter(|id| is_uuid(id));
    if run_id.is_none() && (job_id.is_none() || definition_id.is_none()) {
        return Ok(refusal("Give runId, or jobId with definitionId"));
    }
    let actor = call(host)?.actor;
    if let Some(id) = run_id.filter(|id| is_uuid(id)) {
        if let Some(row) = owned_run(host, &actor, id)? {
            return read_run(&row);
        }
    }
    let job = match job_id {
        Some(id) => queue::read_any_job(host, id)?,
        None => None,
    };
    let own = job.as_ref().filter(|job| match run_id {
        Some(run) => job.run_id.as_deref() == Some(run),
        None => job.definition_id.as_deref() == definition_id && job.run_id.is_none(),
    });
    match own.map(|job| job.state) {
        Some(JobState::Pending) => return Ok(state("pending", run_id)),
        Some(JobState::Failed) => return Ok(state("failed", run_id)),
        _ => {}
    }
    // A finished scheduled job. Its run is the newest one of this owned definition.
    if let (None, Some(id)) = (run_id, definition_id.filter(|id| is_uuid(id))) {
        if let Some(owned) = resolve_owned(host, &actor, Some(id), None)? {
            let newest = runs::run_rows(host, owned["id"].as_str().unwrap_or_default())?;
            if let Some(row) = newest.first().filter(|r| r["owner_user_id"].as_str() == Some(actor.as_str())) {
                return read_run(row);
            }
        }
    }
    Ok(state("not_found", run_id))
}
