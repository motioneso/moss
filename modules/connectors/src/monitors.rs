//! Proactive monitors. Each account gets an email check every 15 minutes and, for Google, a
//! calendar check every 30 minutes. A check reads only saved or live context the person already
//! allowed, records a small health row, and carries no mail text. Job parameters hold the
//! account id and nothing else.
use crate::{calendar_context, email_context, kv, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const EMAIL_QUEUE: &str = "email-monitor";
pub const CALENDAR_QUEUE: &str = "calendar-monitor";
const EMAIL_CRON: &str = "*/15 * * * *";
const CALENDAR_CRON: &str = "*/30 * * * *";
/// Labels that count as something the person may need to act on.
const ACTIONABLE: [&str; 3] = ["needs_reply", "needs_action", "time_sensitive_info"];

fn schedules(calendar: bool) -> Vec<(&'static str, &'static str)> {
    let mut all = vec![(EMAIL_QUEUE, EMAIL_CRON)];
    if calendar {
        all.push((CALENDAR_QUEUE, CALENDAR_CRON));
    }
    all
}

fn schedule(host: &impl Host, queue: &str, cron: &str, account: &str) -> Result<Value> {
    Ok(host.call(
        "jobs",
        "schedule",
        queue,
        json!({"cron":cron,"timezone":"UTC","key":account,"params":{"account-id":account}}),
    )?)
}

/// Keeps the account's monitor schedules. The account id is the key, so a repeat call replaces
/// the row. A scheduling failure never fails the caller.
pub fn reconcile(host: &impl Host, account: &str, calendar: bool) {
    for (queue, cron) in schedules(calendar) {
        let _ = schedule(host, queue, cron, account);
    }
}

/// Stops the account's monitor schedules. The keyed schedule call is idempotent and returns
/// the stable row id to cancel.
pub fn cancel(host: &impl Host, account: &str, calendar: bool) {
    for (queue, cron) in schedules(calendar) {
        let Ok(saved) = schedule(host, queue, cron, account) else { continue };
        if let Some(id) = saved["id"].as_str() {
            let _ = host.call("jobs", "unschedule", queue, json!({"id":id}));
        }
    }
}

/// gap when the account cannot be read, degraded when only the cache answered, else ok.
fn status_of(context: &Value) -> &'static str {
    if context["gaps"].as_array().is_some_and(|g| !g.is_empty()) {
        "gap"
    } else if context["accounts"].as_array().into_iter().flatten().any(|a| {
        a["source"] == "cache" || !a["degradedReason"].is_null()
    }) {
        "degraded"
    } else {
        "ok"
    }
}

fn planned(context: &Value) -> u64 {
    context["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| ACTIONABLE.contains(&i["actionability"].as_str().unwrap_or("")))
        .count() as u64
}

pub fn handle(host: &impl Host, payload: &str) -> std::result::Result<String, String> {
    let job: Value = serde_json::from_str(payload).map_err(|_| "Invalid monitor job")?;
    let account = job["parameters"]["account-id"].as_str().ok_or("Invalid monitor job")?;
    let (status, planned) = match job["queue"].as_str() {
        Some(EMAIL_QUEUE) => {
            let context = email_context::list_saved(host, account).map_err(|e| e.message)?;
            (status_of(&context), planned(&context))
        }
        Some(CALENDAR_QUEUE) => {
            let context = calendar_context::list(host, &json!({"accountId":account})).map_err(|e| e.message)?;
            (status_of(&context), 0)
        }
        _ => return Err("Connectors job is unavailable".into()),
    };
    let clock = host.call("context", "read", "call", json!({})).map_err(|e| e.message.to_string())?;
    kv(
        host,
        "set",
        "connectors.monitor-status",
        json!({"accountId":account,"record":{
            "lastRunAt":clock["now"],"status":status,"planned":planned,"created":0}}),
    )
    .map_err(|e| e.message)?;
    Ok(json!({"status":status,"planned":planned}).to_string())
}
