//! Who is calling. Route requests carry no headers, so the host answers through its
//! `meetings.capture` resource. Every refusal is the same 401 the old routes sent.
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_store::{parse, CAPTURE};
use chrono::{DateTime, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub struct Browser {
    pub session_id: String,
    pub expires_at: DateTime<Utc>,
}

pub struct Native {
    pub device_id: String,
    pub device_name: String,
    pub capability_revision: i64,
    pub expires_at: DateTime<Utc>,
}

pub fn denied() -> Failure {
    Failure::with_status(CaptureCode::Unavailable, 401)
}

fn ask<H: Host + ?Sized>(host: &H, op: &str, params: Value) -> Result<Option<Value>, Stop> {
    let answer = host.call("kv", op, CAPTURE, params)?;
    Ok((answer["found"] == json!(true)).then_some(answer))
}

pub fn browser<H: Host + ?Sized>(host: &H) -> Result<Browser, Stop> {
    let a = ask(host, "browser", json!({}))?.ok_or(denied())?;
    match (a["sessionId"].as_str(), parse(&a["expiresAt"])) {
        (Some(id), Some(expires_at)) => Ok(Browser { session_id: id.to_owned(), expires_at }),
        _ => Err(denied().into()),
    }
}

pub fn native<H: Host + ?Sized>(host: &H) -> Result<Native, Stop> {
    let a = ask(host, "native", json!({}))?.ok_or(denied())?;
    match (a["deviceId"].as_str(), a["capabilityRevision"].as_i64(), parse(&a["expiresAt"])) {
        (Some(id), Some(capability_revision), Some(expires_at)) => Ok(Native {
            device_id: id.to_owned(),
            device_name: a["deviceName"].as_str().unwrap_or("Mac").to_owned(),
            capability_revision,
            expires_at,
        }),
        _ => Err(denied().into()),
    }
}

/// When the Mac's recording permission ends, or `None` when it may not record.
pub fn recording<H: Host + ?Sized>(host: &H, device_id: &str, capability_revision: i64) -> Result<Option<DateTime<Utc>>, Stop> {
    let answer = ask(host, "recording", json!({"deviceId": device_id, "capabilityRevision": capability_revision}))?;
    Ok(answer.and_then(|a| parse(&a["expiresAt"])))
}

/// The recording permission, or the 401 a missing one gets.
pub fn require_recording<H: Host + ?Sized>(host: &H, device_id: &str, capability_revision: i64) -> Result<DateTime<Utc>, Stop> {
    recording(host, device_id, capability_revision)?.ok_or_else(|| denied().into())
}

pub fn processing_route<H: Host + ?Sized>(host: &H) -> Result<Option<String>, Stop> {
    let answer = host.call("kv", "processing", CAPTURE, json!({}))?;
    Ok(answer["modelRoute"].as_str().filter(|_| answer["ready"] == json!(true)).map(str::to_owned))
}

pub fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares the hash of `verifier` with the stored hash without stopping at the first difference.
pub fn proof_matches(verifier: &str, stored_hash: &str) -> bool {
    let a = hash(verifier);
    a.len() == stored_hash.len() && a.bytes().zip(stored_hash.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}
