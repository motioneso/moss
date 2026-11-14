//! The Outlook web calendar reader: four routes under `/outlook-calendar` and a job that reads
//! one week view per run step. The reader is read-only and bound to one person's own account.
//! Job parameters hold ids only. Scan results go to Calendar through its public import.
use crate::health::{read_outlook, OUTLOOK_PROVIDER};
use crate::{kv, Error, Result};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Map, Value};

pub const QUEUE: &str = "outlook-calendar";
const CRON: &str = "*/5 * * * *";
const FRESH_MINUTES: i64 = 15;
const STALLED_MINUTES: i64 = 2;
const MAX_FAILURES: i64 = 3;
const NO_BROWSER: &str = "No dedicated Outlook browser is configured for this account.";
const CHANGED: &str = "Dedicated browser binding changed. Restore the configured source before reconnecting.";
const CONNECT_FIRST: &str = "Connect Outlook calendar first.";

fn now(host: &impl Host) -> Result<DateTime<Utc>> {
    let clock = host.call("context", "read", "call", json!({}))?;
    clock["now"]
        .as_str()
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
        .ok_or_else(|| Error::new(500, "Clock unavailable"))
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn time(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|t| t.with_timezone(&Utc))
}

fn account(host: &impl Host) -> Result<Option<Value>> {
    let rows = kv(host, "get", "connectors.accounts", json!({}))?;
    Ok(rows.as_array().into_iter().flatten().find(|a| a["providerId"] == OUTLOOK_PROVIDER).cloned())
}

fn health(host: &impl Host, id: &str) -> Result<Value> {
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    Ok(read_outlook(&setup["outlook"][id]))
}

fn save(host: &impl Host, id: &str, previous: &Value, update: Value) -> Result<()> {
    let mut next: Map<String, Value> = previous.as_object().cloned().unwrap_or_default();
    for (k, v) in update.as_object().into_iter().flatten() {
        next.insert(k.clone(), v.clone());
    }
    kv(host, "set", "connectors.outlook-health", json!({"accountId":id,"value":next}))?;
    Ok(())
}

/// Saves only while the stored health still names this run as current. The check and the write
/// are one database statement, so a newer run cannot be overwritten. False means superseded.
fn save_fenced(host: &impl Host, id: &str, previous: &Value, update: Value, run: &str) -> Result<bool> {
    let mut next: Map<String, Value> = previous.as_object().cloned().unwrap_or_default();
    for (k, v) in update.as_object().into_iter().flatten() {
        next.insert(k.clone(), v.clone());
    }
    next.insert("currentRun".into(), json!(run));
    let done = kv(host, "set", "connectors.outlook-health", json!({"accountId":id,"value":next,"fenceRun":run}))?;
    Ok(done["saved"] == true)
}

/// The state the screen and tools see. A reader that stopped answering, or a copy that is too
/// old, reads as stale even when the saved state still says collecting or current.
fn shown_state(health: &Value, at: DateTime<Utc>) -> &'static str {
    let state = health["state"].as_str().unwrap_or("collecting");
    let finished = time(&health["lastCompleteAt"]);
    match state {
        "collecting" if time(&health["attemptedAt"]).is_some_and(|t| at - t > Duration::minutes(STALLED_MINUTES)) => "stale",
        "current" if finished.is_none_or(|f| at - f > Duration::minutes(FRESH_MINUTES)) => "stale",
        "collecting" => "collecting",
        "current" => "current",
        "partial" => "partial",
        "stale" => "stale",
        "sign-in-needed" => "sign-in-needed",
        "source-changed" => "source-changed",
        "settings-not-found" => "settings-not-found",
        _ => "disconnected",
    }
}

fn status_body(host: &impl Host) -> Result<Value> {
    let binding = kv(host, "get", "connectors.outlook-binding", json!({}))?;
    let available = binding["available"] == true && binding["mine"] == true;
    let found = account(host)?.filter(|a| a["status"] == "active");
    let Some(found) = found else {
        return Ok(json!({"available":available,"connected":false,"state":"disconnected",
            "lastCompleteAt":null,"windowStart":null,"windowEnd":null,"unconfirmed":0}));
    };
    let h = health(host, found["id"].as_str().unwrap_or(""))?;
    Ok(json!({"available":available,"connected":true,"state":shown_state(&h, now(host)?),
        "lastCompleteAt":h["lastCompleteAt"],"windowStart":h["windowStart"],"windowEnd":h["windowEnd"],
        "unconfirmed":h["unconfirmed"].as_i64().unwrap_or(0)}))
}

pub fn status(host: &impl Host) -> Result<(u16, Value)> {
    status_body(host).map(|b| (200, b))
}

/// The helper binding when it belongs to this person, or the refusal the old server gave.
fn guard(host: &impl Host, existing: Option<&Value>) -> Result<Value> {
    let binding = kv(host, "get", "connectors.outlook-binding", json!({}))?;
    if binding["available"] != true || binding["mine"] != true {
        return Err(Error::new(403, NO_BROWSER));
    }
    let saved = existing.and_then(|a| a["id"].as_str()).map(|id| health(host, id)).transpose()?;
    let drifted = saved
        .as_ref()
        .and_then(|h| h["bindingFingerprint"].as_str())
        .is_some_and(|f| Some(f) != binding["fingerprint"].as_str());
    if drifted {
        return Err(Error::new(409, CHANGED));
    }
    Ok(binding)
}

/// Placeholder run id for a first step. The job schema needs a UUID in every key.
const NO_RUN: &str = "00000000-0000-0000-0000-000000000000";

fn enqueue(host: &impl Host, id: &str, run: Option<&str>) -> Result<Value> {
    let clock = host.call("context", "read", "call", json!({}))?;
    let key = host.call("context", "uuid", "new", json!({}))?;
    let params = json!({"account-id":id,"run-id":run.unwrap_or(NO_RUN),"begun":run.is_some()});
    Ok(host.call(
        "jobs",
        "enqueue-options",
        QUEUE,
        json!({"params":params,"idempotencyKey":key["id"],"availableAt":clock["now"]}),
    )?)
}

/// Queues a run the person asked for. It has its own run id, so the stalled-run check that
/// protects scheduled sweeps does not mistake it for a second run.
fn start(host: &impl Host, id: &str) -> Result<Value> {
    let run = host.call("context", "uuid", "new", json!({}))?;
    let run = run["id"].as_str().unwrap_or("");
    save(host, id, &health(host, id)?, json!({"currentRun":run}))?;
    enqueue(host, id, Some(run))
}

fn schedule(host: &impl Host, id: &str) {
    let _ = host.call(
        "jobs",
        "schedule",
        QUEUE,
        json!({"cron":CRON,"timezone":"UTC","key":id,"params":{"account-id":id,"run-id":NO_RUN,"begun":false}}),
    );
}

fn unschedule(host: &impl Host, id: &str) {
    let saved = host.call(
        "jobs",
        "schedule",
        QUEUE,
        json!({"cron":CRON,"timezone":"UTC","key":id,"params":{"account-id":id,"run-id":NO_RUN,"begun":false}}),
    );
    if let Some(row) = saved.ok().and_then(|s| s["id"].as_str().map(String::from)) {
        let _ = host.call("jobs", "unschedule", QUEUE, json!({"id":row}));
    }
}

fn collecting(host: &impl Host, id: &str, binding: &Value) -> Result<()> {
    let previous = health(host, id)?;
    save(host, id, &previous, json!({
        "state":"collecting","attemptedAt":iso(now(host)?),"failures":0,
        "bindingFingerprint":binding["fingerprint"],
    }))
}

pub fn connect(host: &impl Host) -> Result<(u16, Value)> {
    let existing = account(host)?;
    let binding = guard(host, existing.as_ref())?;
    let secret = json!({"kind":"browser-binding","readOnly":true});
    let saved = match &existing {
        Some(a) => kv(host, "set", "connectors.account-write", json!({
            "action":"update","id":a["id"],"status":"active","scopes":["calendar.readonly"],"tokenPayload":secret,
        }))?,
        None => kv(host, "set", "connectors.account-write", json!({
            "action":"create","providerId":OUTLOOK_PROVIDER,"status":"active",
            "scopes":["calendar.readonly"],"tokenPayload":secret,
        }))?,
    };
    let Some(id) = saved["id"].as_str() else {
        return Err(Error::new(409, CONNECT_FIRST));
    };
    kv(host, "set", "connectors.feature-grants", json!({"accountId":id,"value":{"calendar":true,"email":false},"audit":[]}))?;
    collecting(host, id, &binding)?;
    schedule(host, id);
    start(host, id)?;
    status(host)
}

pub fn refresh(host: &impl Host) -> Result<(u16, Value)> {
    let existing = account(host)?.filter(|a| a["status"] == "active");
    let binding = guard(host, existing.as_ref())?;
    let Some(found) = existing else {
        return Err(Error::new(409, CONNECT_FIRST));
    };
    let id = found["id"].as_str().unwrap_or("");
    collecting(host, id, &binding)?;
    start(host, id)?;
    status(host)
}

pub fn disconnect(host: &impl Host) -> Result<(u16, Value)> {
    let existing = account(host)?;
    guard(host, existing.as_ref())?;
    if let Some(found) = existing.filter(|a| a["status"] == "active") {
        let id = found["id"].as_str().unwrap_or("");
        kv(host, "set", "connectors.account-write", json!({"action":"revoke","id":id}))?;
        let previous = health(host, id)?;
        save(host, id, &previous, json!({"state":"disconnected"}))?;
        unschedule(host, id);
    }
    status(host)
}

fn outcome(name: &str) -> std::result::Result<String, String> {
    Ok(json!({"outcome":name}).to_string())
}

/// One job step. The first step checks the account and starts a run. Each later step reads one
/// view through the host and queues the next. The last step imports into Calendar.
pub fn handle(host: &impl Host, payload: &str) -> std::result::Result<String, String> {
    let job: Value = serde_json::from_str(payload).map_err(|_| "Invalid Outlook calendar job")?;
    let id = job["parameters"]["account-id"].as_str().ok_or("Invalid Outlook calendar job")?;
    let run = job["parameters"]["run-id"].as_str().filter(|_| job["parameters"]["begun"] == true);
    run_step(host, id, run).map_err(|e| e.message).and_then(outcome)
}

fn run_step(host: &impl Host, id: &str, run: Option<&str>) -> Result<&'static str> {
    let found = account(host)?.filter(|a| a["id"] == id && a["status"] == "active");
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let previous = read_outlook(&setup["outlook"][id]);
    if found.is_none() || !crate::grants::is_granted(&setup["grants"][id], "calendar") {
        return Ok("inactive");
    }
    let binding = kv(host, "get", "connectors.outlook-binding", json!({}))?;
    let at = now(host)?;
    let run = match run {
        // A newer run began after this one, so this one must not write over its result.
        Some(run) if previous["currentRun"].as_str().is_some_and(|c| c != run) => return Ok("superseded"),
        Some(run) => run.to_string(),
        None => {
            let state = previous["state"].as_str().unwrap_or("collecting");
            let busy = state == "collecting"
                && time(&previous["attemptedAt"]).is_some_and(|t| at - t <= Duration::minutes(STALLED_MINUTES));
            if matches!(state, "sign-in-needed" | "source-changed" | "disconnected")
                || previous["failures"].as_i64().unwrap_or(0) >= MAX_FAILURES
                || binding["available"] != true
                || binding["mine"] != true
            {
                return Ok("skipped");
            }
            if previous["bindingFingerprint"].as_str().is_some_and(|f| Some(f) != binding["fingerprint"].as_str()) {
                save(host, id, &previous, json!({"state":"source-changed","attemptedAt":iso(at)}))?;
                return Ok("skipped");
            }
            if busy {
                return Ok("busy");
            }
            let run = host.call("context", "uuid", "new", json!({}))?["id"].as_str().unwrap_or("").to_string();
            save(host, id, &previous, json!({"state":"collecting","attemptedAt":iso(at),"bindingFingerprint":binding["fingerprint"],"currentRun":run}))?;
            run
        }
    };
    let step = kv(host, "set", "connectors.outlook-scan", json!({"runId":run}))?;
    if let Some(code) = step["error"].as_str() {
        let state = match code {
            "sign-in-needed" | "source-changed" | "settings-not-found" => code,
            _ => "partial",
        };
        let failures = previous["failures"].as_i64().unwrap_or(0) + 1;
        let mut update = json!({"state":state,"failures":failures,"attemptedAt":iso(at)});
        if let Some(stage) = step["stage"].as_str() {
            update["errorStage"] = json!(stage);
        }
        if !save_fenced(host, id, &previous, update, &run)? {
            return Ok("superseded");
        }
        return Ok("failed");
    }
    if step["done"] != true {
        enqueue(host, id, Some(&run))?;
        return Ok("continued");
    }
    let scan = &step["scan"];
    let imported = Client(host).api("calendar", "importCalendarMirror", json!({"connectorAccountId":id,"batch":scan}));
    let finished = now(host)?;
    match imported {
        Ok(done) => {
            let saved = save_fenced(host, id, &previous, json!({
                "state":"current","lastCompleteAt":scan["observedAt"].as_str().map_or_else(|| iso(finished), String::from),"failures":0,"attemptedAt":iso(at),
                "windowStart":scan["windowStart"],"windowEnd":scan["windowEnd"],"timeZone":scan["timeZone"],
                "unconfirmed":done["unconfirmed"].as_i64().unwrap_or(0),
            }), &run)?;
            Ok(if saved { "imported" } else { "superseded" })
        }
        Err(_) => {
            let failures = previous["failures"].as_i64().unwrap_or(0) + 1;
            let saved = save_fenced(host, id, &previous, json!({"state":"partial","failures":failures,"attemptedAt":iso(at)}), &run)?;
            Ok(if saved { "failed" } else { "superseded" })
        }
    }
}
