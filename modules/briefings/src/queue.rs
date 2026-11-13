//! Reading and writing the briefing queues. `briefings-run` carries the scheduled fires and
//! `briefings-run-now` carries manual runs. A manual job also holds its run id, so the route can
//! hand the id back before the job runs. Payloads hold ids and choices only.
use crate::util::{call, new_id};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const SCHEDULED: &str = crate::schedule::QUEUE;
pub const MANUAL: &str = "briefings-run-now";

/// A job's state as the old queue named it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Pending,
    Failed,
    Completed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub id: String,
    pub state: JobState,
    pub run_id: Option<String>,
    pub definition_id: Option<String>,
}

fn state_of(text: &str) -> JobState {
    match text {
        "pending" | "running" => JobState::Pending,
        "completed" => JobState::Completed,
        _ => JobState::Failed,
    }
}

fn job_of(value: &Value) -> Option<Job> {
    Some(Job {
        id: value["id"].as_str()?.to_owned(),
        state: state_of(value["state"].as_str()?),
        run_id: value["params"]["briefing-run-id"].as_str().map(str::to_owned),
        definition_id: value["params"]["definition-id"].as_str().map(str::to_owned),
    })
}

/// One of the caller's own jobs on the manual queue. Row security hides everyone else's.
pub fn read_job<H: Host + ?Sized>(host: &H, job_id: &str) -> Result<Option<Job>> {
    let answer = host.call("jobs", "read", MANUAL, json!({"id":job_id}))?;
    Ok(job_of(&answer["job"]))
}

/// One of the caller's own jobs from either queue. A scheduled fire holds no run id yet.
pub fn read_any_job<H: Host + ?Sized>(host: &H, job_id: &str) -> Result<Option<Job>> {
    for queue in [MANUAL, SCHEDULED] {
        let answer = host.call("jobs", "read", queue, json!({"id":job_id}))?;
        if let Some(job) = job_of(&answer["job"]) {
            return Ok(Some(job));
        }
    }
    Ok(None)
}

/// The caller's oldest queued or running job for one definition, from the manual queue or the
/// schedule. Chat and Today share one answer, so neither starts a second run.
pub fn find_open<H: Host + ?Sized>(host: &H, definition_id: &str) -> Result<Option<Job>> {
    if let Some(job) = find_in_flight(host, definition_id)? {
        return Ok(Some(job));
    }
    let answer = host.call("jobs", "list-open", SCHEDULED, json!({}))?;
    Ok(answer["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(job_of)
        .find(|job| job.definition_id.as_deref() == Some(definition_id)))
}

fn read_by_key<H: Host + ?Sized>(host: &H, key: &str) -> Result<Option<Job>> {
    let answer = host.call("jobs", "read", MANUAL, json!({"idempotencyKey":key}))?;
    Ok(job_of(&answer["job"]))
}

/// The caller's oldest queued or running manual job for one definition.
pub fn find_in_flight<H: Host + ?Sized>(host: &H, definition_id: &str) -> Result<Option<Job>> {
    let answer = host.call("jobs", "list-open", MANUAL, json!({}))?;
    Ok(answer["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(job_of)
        .find(|job| job.definition_id.as_deref() == Some(definition_id)))
}

/// The zone a definition's cron was registered in, if it is still registered.
pub fn registered_zone<H: Host + ?Sized>(host: &H, definition_id: &str) -> Result<Option<String>> {
    let answer = host.call("jobs", "read-schedule", SCHEDULED, json!({"key":definition_id}))?;
    Ok(answer["schedule"]["timezone"].as_str().map(str::to_owned))
}

/// A stable id for one client key. The queue keeps one job per id, so a repeated key
/// finds the first job. The extra part lets a key be reused after its first job finished.
pub fn key_id(definition_id: &str, key: &str, after: Option<&str>) -> String {
    let mut hash = Sha256::new();
    for part in [definition_id, key, after.unwrap_or("")] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    let b = hash.finalize();
    let h = |from: usize, to: usize| b[from..to].iter().map(|x| format!("{x:02x}")).collect::<String>();
    // Version 4 and variant bits keep it a well-formed id.
    format!(
        "{}-{}-4{}-{:x}{}-{}",
        h(0, 4),
        h(4, 6),
        &h(6, 8)[1..],
        8 + (b[8] & 3),
        &h(8, 10)[1..],
        h(10, 16)
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum Started {
    Queued { job_id: String, run_id: String },
    /// The key already names a job that is still queued or running.
    InFlight,
    /// The job could not be queued.
    Failed,
}

fn send<H: Host + ?Sized>(
    host: &H,
    definition_id: &str,
    run_id: &str,
    briefing_type: &str,
    id: &str,
    now: &str,
) -> Result<Option<String>> {
    let sent = host.call(
        "jobs",
        "enqueue-options",
        MANUAL,
        json!({
            "params": {"definition-id":definition_id,"briefing-run-id":run_id,"briefing-type":briefing_type},
            "idempotencyKey": id,
            "availableAt": now,
        }),
    )?;
    Ok(sent["id"].as_str().map(str::to_owned))
}

/// Queues one manual run. A keyless run gets a fresh key, so it never collides.
pub fn start_manual<H: Host + ?Sized>(
    host: &H,
    definition_id: &str,
    briefing_type: &str,
    key: Option<&str>,
) -> Result<Started> {
    let now = call(host)?.now;
    let run_id = new_id(host)?;
    let Some(key) = key else {
        return Ok(match send(host, definition_id, &run_id, briefing_type, &run_id, &now)? {
            Some(job_id) => Started::Queued { job_id, run_id },
            None => Started::Failed,
        });
    };
    let first = key_id(definition_id, key, None);
    if let Some(job_id) = send(host, definition_id, &run_id, briefing_type, &first, &now)? {
        return Ok(Started::Queued { job_id, run_id });
    }
    let Some(held) = read_by_key(host, &first)? else { return Ok(Started::Failed) };
    if held.state == JobState::Pending {
        return Ok(Started::InFlight);
    }
    // The first job is finished, so the same key starts a new run. Each finished job leads to the
    // next derived key, until one is free or still running.
    let mut held = held;
    for _ in 0..50 {
        let again = key_id(definition_id, key, Some(&held.id));
        if let Some(job_id) = send(host, definition_id, &run_id, briefing_type, &again, &now)? {
            return Ok(Started::Queued { job_id, run_id });
        }
        match read_by_key(host, &again)? {
            Some(next) if next.state != JobState::Pending => held = next,
            _ => return Ok(Started::InFlight),
        }
    }
    Ok(Started::Failed)
}
