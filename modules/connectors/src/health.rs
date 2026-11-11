//! Connection health, with the same labels the old diagnostics produced.
use chrono::DateTime;
use serde_json::{json, Value};

pub const OUTLOOK_PROVIDER: &str = "outlook-browser-calendar";
const LABEL_MAX: usize = 120;
const OUTLOOK_STATES: [&str; 8] = [
    "collecting",
    "current",
    "partial",
    "stale",
    "sign-in-needed",
    "source-changed",
    "settings-not-found",
    "disconnected",
];

pub fn outlook_key(account_id: &str) -> String {
    format!("connector.{account_id}.outlook_calendar_health")
}

/// Normalised Outlook helper state. Anything unreadable counts as collecting.
pub fn read_outlook(stored: &Value) -> Value {
    match stored.as_object() {
        Some(object)
            if object
                .get("state")
                .and_then(Value::as_str)
                .is_some_and(|state| OUTLOOK_STATES.contains(&state)) =>
        {
            stored.clone()
        }
        _ => json!({"state":"collecting"}),
    }
}

fn outlook_labels(health: &Value, failures: i64) -> (&'static str, Option<&'static str>) {
    match health["state"].as_str().unwrap_or("collecting") {
        "partial" if failures > 0 => ("partial", Some("scan-incomplete-or-helper-unreachable")),
        "partial" => ("partial", Some("scan-incomplete")),
        "sign-in-needed" => ("sign-in-needed", Some("sign-in-needed")),
        "source-changed" => ("source-changed", Some("source-changed")),
        "settings-not-found" => ("settings-not-found", Some("settings-not-found")),
        "disconnected" => ("disconnected", Some("disconnected")),
        "stale" => ("stale", Some("stale")),
        "collecting" => ("collecting", None),
        _ => ("healthy", None),
    }
}

/// Re-renders a stored timestamp the way the old server did, or null if unreadable.
fn iso(value: &Value) -> Value {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|time| json!(time.to_utc().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()))
        .unwrap_or(Value::Null)
}

fn clip(text: &str) -> String {
    text.chars().take(LABEL_MAX).collect()
}

fn text<'a>(row: &'a Value, name: &str) -> Option<&'a str> {
    row[name].as_str()
}

/// One account row (as the host reads it) plus the Outlook state, if any.
pub fn observe(row: &Value, outlook: Option<&Value>) -> Value {
    let provider = clip(text(row, "providerId").unwrap_or(""));
    let account = clip(text(row, "id").unwrap_or(""));
    let status = text(row, "status").unwrap_or("");
    let started = iso(&row["lastSyncStartedAt"]);
    let finished = iso(&row["lastSyncFinishedAt"]);
    let item = |status: &str, attempt: Value, good: Value, failures: i64, label: Option<&str>| {
        json!({
            "provider": provider,
            "accountId": account,
            "status": status,
            "lastAttemptAt": attempt,
            "lastGoodAt": good,
            "failureCount": failures,
            "errorLabel": label,
        })
    };
    if !row["revokedAt"].is_null() || status == "revoked" {
        return item("revoked", started, Value::Null, 0, Some("revoked"));
    }
    if let (Some(health), "active") = (outlook, status) {
        let failures = health["failures"].as_i64().unwrap_or(0);
        let (state, label) = outlook_labels(health, failures);
        let attempt = match iso(&health["attemptedAt"]) {
            Value::Null => started,
            time => time,
        };
        return item(state, attempt, iso(&health["lastCompleteAt"]), failures, label);
    }
    let sync = text(row, "lastSyncStatus");
    let failed = sync == Some("failed");
    let state = if status == "error" {
        "error"
    } else {
        match sync {
            None => "never-synced",
            Some("success") => "healthy",
            Some("partial") => "sync-partial",
            Some(_) => "sync-failed",
        }
    };
    let attempt = if started.is_null() { finished.clone() } else { started };
    let good = if sync == Some("success") {
        finished
    } else if text(row, "previousStatus") == Some("success") {
        iso(&row["previousFinishedAt"])
    } else {
        Value::Null
    };
    let label = text(row, "errorLabel")
        .or(if failed || status == "error" { Some("sync-error") } else { None });
    item(state, attempt, good, i64::from(failed), label)
}

/// Section for the diagnostics page: at most `limit` items and a truncation flag.
pub fn section(rows: &[Value], outlook: &Value, limit: i64) -> Value {
    let limit = limit.clamp(1, 10) as usize;
    let items: Vec<Value> = rows
        .iter()
        .take(limit)
        .map(|row| {
            let id = row["id"].as_str().unwrap_or("");
            let health = (row["providerId"] == OUTLOOK_PROVIDER)
                .then(|| read_outlook(&outlook[id]));
            observe(row, health.as_ref())
        })
        .collect();
    json!({"items":items,"truncated":rows.len() > limit})
}
