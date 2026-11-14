//! Decides whether the Outlook calendar copy is complete and fresh enough to place a new event
//! against. A person with no Outlook source is never blocked. A source that exists but is stale,
//! partial, uncertain or short of the requested dates blocks the write.
use crate::health::{read_outlook, OUTLOOK_PROVIDER};
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

pub const UNVERIFIED: &str = "Outlook calendar availability needs verification. Reconnect or sync in Connections, then retry within the covered dates.";
const FRESH_MINUTES: i64 = 15;

/// The refusal text, or `None` when writing is safe. `setup` is the `connectors.context-setup` answer.
pub fn issue(setup: &Value, start: DateTime<Utc>, end: DateTime<Utc>, now: DateTime<Utc>) -> Option<&'static str> {
    let account = setup["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["providerId"] == OUTLOOK_PROVIDER)?;
    let id = account["id"].as_str().unwrap_or("");
    let health = read_outlook(&setup["outlook"][id]);
    let usable = account["status"] == "active"
        && health["state"] == "current"
        && crate::grants::is_granted(&setup["grants"][id], "calendar")
        && health["unconfirmed"].as_i64() == Some(0)
        && covers(&health, start, end, now);
    (!usable).then_some(UNVERIFIED)
}

fn covers(health: &Value, start: DateTime<Utc>, end: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    let Some(finished) = health["lastCompleteAt"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()) else {
        return false;
    };
    let age = now - finished.with_timezone(&Utc);
    if age < Duration::zero() || age >= Duration::minutes(FRESH_MINUTES) {
        return false;
    }
    let zone = health["timeZone"].as_str().unwrap_or("");
    let (Some(from), Some(to)) = (
        health["windowStart"].as_str().and_then(|d| crate::outlook_source::day_start(d, zone)),
        health["windowEnd"].as_str().and_then(|d| crate::outlook_source::day_start(d, zone)),
    ) else {
        return false;
    };
    crate::outlook_source::zone(zone).is_some() && from <= start && end <= to
}
