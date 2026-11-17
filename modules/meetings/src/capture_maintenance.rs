//! The maintenance job that ends a silent or expired grant. Each run checks one grant, then
//! queues the next check five seconds later. The payload carries the grant id and a sequence
//! number only.
use crate::capture_auth as auth;
use crate::capture_errors::Stop;
use crate::capture_state::{elapsed, revoke};
use crate::capture_store::{self as store, now, parse, stamp};
use crate::text::is_uuid;
use chrono::{DateTime, Duration, Utc};
use moss_module_sdk::{Error, Host};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const QUEUE: &str = "meetings.capture-maintenance";
const NEXT_MS: i64 = 5_000;
const MAX_SEQUENCE: i64 = 1440;

/// One job id per grant and sequence, so a repeated enqueue is suppressed.
pub fn job_id(grant: &str, sequence: u32) -> String {
    let h: String = Sha256::digest(format!("meeting-maintenance:{grant}:{sequence}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-4{}-8{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// Queues the check for `sequence` to run five seconds after `at`.
pub fn schedule<H: Host + ?Sized>(host: &H, grant: &str, sequence: u32, at: DateTime<Utc>) -> Result<(), Stop> {
    host.call(
        "jobs",
        "enqueue-after-commit",
        QUEUE,
        json!({
            "params": {"grant-id": grant, "sequence": sequence},
            "idempotencyKey": job_id(grant, sequence),
            "availableAt": stamp(at + Duration::milliseconds(NEXT_MS)),
        }),
    )?;
    Ok(())
}

fn done(status: &str) -> Result<String, Error> {
    Ok(json!({"status": status}).to_string())
}

fn fault(stop: Stop) -> Error {
    match stop {
        Stop::Host(error) => error,
        Stop::Fail(_) => Error::new("Capture maintenance refused"),
    }
}

/// Runs one check. A grant that is gone, finished or no longer at this sequence is left alone.
pub fn run<H: Host + ?Sized>(host: &H, parameters: &Value) -> Result<String, Error> {
    let grant_id = parameters["grant-id"].as_str().filter(|id| is_uuid(id)).map(str::to_lowercase).ok_or_else(|| Error::new("Invalid job"))?;
    let sequence = parameters["sequence"].as_i64().filter(|n| (0..=MAX_SEQUENCE).contains(n)).ok_or_else(|| Error::new("Invalid job"))?;
    step(host, &grant_id, sequence).map_err(fault)
}

fn step<H: Host + ?Sized>(host: &H, grant_id: &str, sequence: i64) -> Result<String, Stop> {
    let Some(initial) = store::grant(host, grant_id)? else { return Ok(json!({"status": "gone"}).to_string()) };
    store::lock(host, "device", initial["device_id"].as_str().unwrap_or_default())?;
    let meeting = initial["meeting_id"].as_str().unwrap_or_default();
    if store::lock(host, "meeting", meeting).is_err() {
        return Ok(json!({"status": "gone"}).to_string());
    }
    let Some(grant) = store::grant(host, grant_id)? else { return Ok(json!({"status": "gone"}).to_string()) };
    if !grant["state_json"].is_string() {
        return Ok(json!({"status": "none"}).to_string());
    }
    let mut saved = store::state(&grant);
    let status = grant["status"].as_str().unwrap_or_default();
    let desired = saved["desired"].as_str().unwrap_or_default();
    if saved["maintenanceSequence"].as_i64().unwrap_or(0) != sequence
        || ["revoked", "stopped"].contains(&desired)
        || ["revoked", "complete", "finalizing"].contains(&status)
    {
        return Ok(json!({"status": "skipped"}).to_string());
    }
    let at = now(host)?;
    let expires = parse(&grant["expires_at"]);
    let lapsed = expires.is_none_or(|t| t <= at)
        || (status == "approved" && desired != "paused" && !parse(&grant["claim_expires_at"]).is_some_and(|t| t > at));
    let mut reason = lapsed.then_some("expired");
    if reason.is_none() {
        let revision = grant["capability_revision"].as_i64();
        let device = grant["device_id"].as_str().unwrap_or_default();
        let allowed = match revision {
            Some(r) => auth::recording(host, device, r)?.is_some(),
            None => false,
        };
        if !allowed {
            reason = Some("recording-permission-revoked");
        }
    }
    if let Some(reason) = reason {
        let end = at.min(expires.unwrap_or(at));
        let at_ms = elapsed(&saved, end);
        revoke(&mut saved, at_ms, Some(reason));
        store::save(host, &grant, &saved)?;
        return Ok(json!({"status": "revoked"}).to_string());
    }
    let next = sequence + 1;
    saved["maintenanceSequence"] = json!(next);
    store::save(host, &grant, &saved)?;
    schedule(host, grant_id, next as u32, at)?;
    Ok(json!({"status": "renewed"}).to_string())
}
