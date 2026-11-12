//! Which Macs a person may start capture on, and what each one is doing. Pure rules over
//! connection and grant rows, so they run the same natively and in WebAssembly.
use crate::capture_errors::{CaptureCode, Failure};
use crate::capture_selection::LEASE_MS;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

/// A full page of connections cannot prove no other eligible Mac exists.
pub const CONNECTION_PAGE: usize = 32;

fn at(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    value[key].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc))
}

/// A connection is live while it is unexpired and the Mac was seen within one lease.
pub fn live(connection: &Value, now: DateTime<Utc>) -> bool {
    match (at(connection, "expires_at"), at(connection, "last_seen_at")) {
        (Some(expires), Some(seen)) => expires > now && (now - seen).num_milliseconds() <= LEASE_MS,
        _ => false,
    }
}

/// What a Mac is doing for a grant that holds it, or `None` when the Mac is free.
/// An active grant whose Mac has not been seen for a lease no longer holds the Mac.
pub fn phase(grant: &Value, now: DateTime<Utc>) -> Option<&'static str> {
    let state = &grant["state_json"];
    let status = grant["status"].as_str().unwrap_or_default();
    let seen = at(state, "lastSeenAt").or_else(|| at(state, "originAt"));
    let fresh = match (state["lastSeenAt"].is_null(), seen) {
        (true, _) => true,
        (false, Some(seen)) => (now - seen).num_milliseconds() < LEASE_MS,
        (false, None) => false,
    };
    if status == "active" && !fresh {
        return None;
    }
    Some(if status == "finalizing" {
        "finalizing"
    } else if state["desired"] == "paused" {
        "paused"
    } else if status == "approved" {
        "starting"
    } else {
        "recording"
    })
}

/// The device list entry for one eligible connection.
pub fn entry(connection: &Value, occupying: Option<&Value>, now: DateTime<Utc>) -> Value {
    let phase = occupying.and_then(|grant| phase(grant, now));
    let deadline = occupying.map(|g| g["state_json"]["finalizationDeadline"].clone()).unwrap_or(Value::Null);
    json!({
        "busy": phase.is_some(),
        "capturePhase": phase,
        "finalizationDeadline": if phase.is_some() { deadline } else { Value::Null },
        "deviceId": connection["device_id"],
        "deviceName": connection["device_name"],
        "connectionId": connection["connection_id"],
        "revision": connection["revision"],
        "capabilityRevision": connection["capability_revision"],
        "inventory": connection["inventory_json"],
        "lastSeenAt": connection["last_seen_at"],
        "expiresAt": connection["expires_at"],
    })
}

/// The one connection a start with no device named may use. `eligible` holds the live
/// connections the recording permission check accepted.
pub fn default_connection<'a>(page: &[Value], eligible: &'a [Value], named_device: bool) -> Result<&'a Value, Failure> {
    if !named_device && page.len() >= CONNECTION_PAGE {
        return Err(Failure::new(CaptureCode::SourceUnavailable));
    }
    match eligible {
        [one] => Ok(one),
        _ => Err(Failure::new(CaptureCode::SourceUnavailable)),
    }
}
