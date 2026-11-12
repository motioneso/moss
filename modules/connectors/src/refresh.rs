//! Email refresh, package side. A person asks for a refresh of every connected mail account.
//! The host keeps the refresh rows. The package turns pending rows into one sync job per
//! account, and a per-person sweep repeats that until every account has an outcome. Job
//! parameters hold only ids, counts and fixed choices, never mail text.
use crate::{fastify, google_sync, kv, mail_sync, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const SWEEP: &str = "email-refresh-sweep";
const SWEEP_CRON: &str = "*/1 * * * *";
const SWEEP_KEY: &str = "email-refresh";
const NOT_FOUND: &str = "Email refresh not found";

/// The statuses the app tells the browser about: all but the first two end a refresh.
pub fn outcome(error: &str) -> (&'static str, Option<&'static str>) {
    match error {
        "none" => ("succeeded", None),
        "auth-error" => ("failed", Some("auth-error")),
        "no-active-connection" => ("failed", Some("no-active-connection")),
        "email-needs-config" => ("failed", Some("email-needs-config")),
        "email-message-error" => ("partial", Some("email-message-error")),
        _ => ("partial", Some("email-error")),
    }
}

/// Marks the account's refresh row as running. False means the row is already finished or
/// was never waiting, so the job has nothing to do.
pub fn begin(host: &impl Host, refresh: &str, account: &str, provider: &str) -> Result<bool> {
    let started = kv(
        host,
        "set",
        "connectors.refresh-account-start",
        json!({"refreshId":refresh,"accountId":account,"provider":provider}),
    )?;
    Ok(started["state"] == "started")
}

/// Records the account's outcome. A failure to record is left to the sweep, which fails any
/// row that stays unfinished.
pub fn finish(
    host: &impl Host,
    refresh: &str,
    account: &str,
    status: &str,
    error: Option<&str>,
    upserted: u64,
    failures: u64,
) {
    let _ = kv(
        host,
        "set",
        "connectors.refresh-account-finish",
        json!({
            "refreshId":refresh,"accountId":account,"status":status,"error":error,
            "counts":{"emailUpserted":upserted,"emailFailures":failures},
        }),
    );
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&groups).all(|(n, g)| g.len() == *n)
        && groups.iter().all(|g| g.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn uuid_param(value: &Value, path: &str, place: &str) -> Result<String> {
    let text = fastify::string(value, path)?;
    if is_uuid(&text) {
        Ok(text)
    } else {
        Err(Error::new(400, format!("{place}/{path} must match format \"uuid\"")))
    }
}

/// POST /email-refresh. Starts a refresh, or returns the one this key or an active refresh
/// already has.
pub fn request(host: &impl Host, body: &Value) -> Result<(u16, Value)> {
    let object = fastify::object(body)?;
    fastify::required(object, &["idempotencyKey"])?;
    let key = uuid_param(&object["idempotencyKey"], "idempotencyKey", "body")?;
    let made = kv(host, "set", "connectors.refresh-request", json!({"key":key}))?;
    let id = made["refreshId"].as_str().ok_or_else(|| Error::new(500, "Internal server error"))?;
    let mut enqueued = false;
    if made["created"] == true && made["active"] == true {
        ensure_sweep(host);
        enqueued = dispatch(host, Some(id)) > 0;
    }
    Ok((202, json!({"refreshId":id,"enqueued":enqueued,"deduped":made["deduped"]})))
}

/// GET /email-refresh/:refreshId. Another person's refresh looks the same as a missing one.
pub fn status(host: &impl Host, id: &str) -> Result<(u16, Value)> {
    let id = uuid_param(&json!(id), "refreshId", "params")?;
    let found = kv(host, "get", "connectors.refresh-status", json!({"refreshId":id}))?;
    if found.is_null() {
        return Err(Error::new(404, NOT_FOUND));
    }
    Ok((200, found))
}

fn ensure_sweep(host: &impl Host) {
    let _ = host.call(
        "jobs",
        "schedule",
        SWEEP,
        json!({"cron":SWEEP_CRON,"timezone":"UTC","key":SWEEP_KEY,"params":{"round":0}}),
    );
}

fn stop_sweep(host: &impl Host) {
    let Ok(saved) = host.call(
        "jobs",
        "schedule",
        SWEEP,
        json!({"cron":SWEEP_CRON,"timezone":"UTC","key":SWEEP_KEY,"params":{"round":0}}),
    ) else {
        return;
    };
    if let Some(id) = saved["id"].as_str() {
        let _ = host.call("jobs", "unschedule", SWEEP, json!({"id":id}));
    }
}

fn enqueue(host: &impl Host, queue: &str, params: Value, key: &str) -> Result<()> {
    let context = host.call("context", "read", "call", json!({}))?;
    host.call(
        "jobs",
        "enqueue-options",
        queue,
        json!({"params":params,"idempotencyKey":key,"availableAt":context["now"]}),
    )?;
    Ok(())
}

/// Queues one sync job for every account row still waiting. The key comes from the host and is
/// fixed per row, so a repeat dispatch never queues a second job. Returns how many rows it queued.
fn dispatch(host: &impl Host, refresh: Option<&str>) -> usize {
    let Ok(pending) = kv(host, "get", "connectors.refresh-pending", json!({"refreshId":refresh})) else {
        return 0;
    };
    let mut queued = 0;
    for row in pending.as_array().into_iter().flatten() {
        let (Some(id), Some(account), Some(provider), Some(key)) = (
            row["refreshId"].as_str(),
            row["accountId"].as_str(),
            row["provider"].as_str(),
            row["dedupeKey"].as_str(),
        ) else {
            continue;
        };
        let (queue, params) = if provider == "google" {
            (google_sync::REFRESH_QUEUE, google_sync::refresh_first(account, id))
        } else {
            mail_sync::refresh_first(account, id)
        };
        let sent = enqueue(host, queue, params, key).is_ok();
        let _ = kv(
            host,
            "set",
            "connectors.refresh-dispatch",
            json!({"refreshId":id,"accountId":account,"ok":sent}),
        );
        if sent {
            queued += 1;
        }
    }
    queued
}

pub fn handle(host: &impl Host, payload: &str) -> std::result::Result<String, String> {
    let job: Value = serde_json::from_str(payload).map_err(|_| "Invalid email refresh job")?;
    let outcome = match job["queue"].as_str() {
        Some(SWEEP) => sweep(host).map_err(|e| e.message)?,
        _ => return Err("Connectors job is unavailable".into()),
    };
    Ok(json!({"outcome":outcome}).to_string())
}

/// Fails rows that stayed unfinished too long, queues rows still waiting, and stops itself when
/// the person has no active refresh left.
fn sweep(host: &impl Host) -> Result<&'static str> {
    let state = kv(host, "set", "connectors.refresh-sweep", json!({}))?;
    if state["pending"] == true {
        dispatch(host, None);
    }
    if state["active"] == true {
        return Ok("active");
    }
    stop_sweep(host);
    Ok("idle")
}
