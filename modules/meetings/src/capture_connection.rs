//! The Mac's side of the link: register a connection, list Macs for the browser, poll for a
//! command and claim a grant. Linking never starts capture.
use crate::capture_auth::{self as auth, denied, Native};
use crate::capture_devices::{entry, live};
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_input as input;
use crate::capture_selection::{validate, LEASE_MS};
use crate::capture_state::view;
use crate::capture_store::{self as store, now, parse, stamp, Registration};
use chrono::{DateTime, Utc};
use moss_module_sdk::{Host, Response};
use serde_json::{json, Value};

/// `POST /capture/connection`.
pub fn register<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response, Stop> {
    let map = input::object(body, &["connectionId", "verifierHash", "inventory"], &["connectionId", "verifierHash", "inventory"])?;
    let connection_id = input::uuid(&map["connectionId"])?;
    let verifier_hash = input::hex64(&map["verifierHash"])?;
    input::inventory(&map["inventory"])?;
    let native = auth::native(host)?;
    store::lock(host, "device", &native.device_id)?;
    let permission_ends = auth::require_recording(host, &native.device_id, native.capability_revision)?;
    let at = now(host)?;
    let saved = store::register(
        host,
        &Registration {
            device_id: &native.device_id,
            connection_id: &connection_id,
            device_name: &native.device_name,
            verifier_hash: &verifier_hash,
            capability_revision: native.capability_revision,
            inventory: &map["inventory"],
            at,
            expires_at: native.expires_at.min(permission_ends),
        },
    )?;
    Ok(Response::new(
        200,
        json!({"connectionId": saved["connection_id"], "revision": saved["revision"], "leaseMs": LEASE_MS, "expiresAt": saved["expires_at"]}),
    ))
}

/// The connection with its inventory parsed, as the pure rules expect it.
pub fn parsed(connection: &Value) -> Value {
    let mut out = connection.clone();
    out["inventory_json"] = connection["inventory_json"].as_str().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_else(|| json!({}));
    out
}

/// The grant with its state parsed.
pub fn with_state(grant: &Value) -> Value {
    let mut out = grant.clone();
    out["state_json"] = store::state(grant);
    out
}

/// The live connections the Mac's permission check accepts.
pub fn eligible<H: Host + ?Sized>(host: &H, page: &[Value], at: DateTime<Utc>) -> Result<Vec<Value>, Stop> {
    let mut out = Vec::new();
    for c in page {
        if !live(c, at) {
            continue;
        }
        let device = c["device_id"].as_str().unwrap_or_default();
        if auth::recording(host, device, c["capability_revision"].as_i64().unwrap_or(0))?.is_some() {
            out.push(c.clone());
        }
    }
    Ok(out)
}

/// `GET /capture/devices`.
pub fn devices<H: Host + ?Sized>(host: &H) -> Result<Response, Stop> {
    auth::browser(host)?;
    let at = now(host)?;
    let page = store::connections(host)?;
    let mut list = Vec::new();
    for c in eligible(host, &page, at)? {
        let held = store::occupying(host, &c, at)?.map(|g| with_state(&g));
        list.push(entry(&parsed(&c), held.as_ref(), at));
    }
    let ready = auth::processing_route(host)?.is_some();
    Ok(Response::new(200, json!({"devices": list, "processingReady": ready})))
}

/// Checks that the stored connection is the caller's, current, fresh and proven by the secret.
fn valid(connection: Option<Value>, native: &Native, connection_id: &str, verifier: &str, at: DateTime<Utc>) -> Result<Value, Stop> {
    let c = connection.ok_or(denied())?;
    let ok = c["connection_id"] == json!(connection_id)
        && c["device_id"] == json!(native.device_id)
        && c["capability_revision"].as_i64() == Some(native.capability_revision)
        && live(&c, at)
        && auth::proof_matches(verifier, c["verifier_hash"].as_str().unwrap_or_default());
    if ok { Ok(c) } else { Err(denied().into()) }
}

/// `POST /capture/commands`. The answer is immediate. The Mac polls again after `retryAfterMs`.
pub fn commands<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response, Stop> {
    let map = input::object(body, &["connectionId", "verifier"], &["connectionId", "verifier", "revision", "waitMs"])?;
    let connection_id = input::uuid(&map["connectionId"])?;
    let secret = input::verifier(&map["verifier"])?;
    if map.get("revision").is_some_and(|r| r.as_str().is_none_or(|t| t.len() > 64)) {
        return Err(Failure::new(CaptureCode::InvalidInput).into());
    }
    if map.get("waitMs").is_some_and(|w| w.as_i64().is_none_or(|n| !(0..=20_000).contains(&n))) {
        return Err(Failure::new(CaptureCode::InvalidInput).into());
    }
    let native = auth::native(host)?;
    let at = now(host)?;
    let connection = valid(store::connection(host, &native.device_id)?, &native, &connection_id, &secret, at)?;
    let Some(grant) = store::command(host, &connection, at)? else {
        return Ok(Response::new(200, json!({"revision": "none", "retryAfterMs": 1000, "command": null})));
    };
    let revision = grant["capability_revision"].as_i64().unwrap_or(0);
    auth::require_recording(host, grant["device_id"].as_str().unwrap_or_default(), revision)?;
    let saved = store::state(&grant);
    let claim_ms = parse(&grant["claim_expires_at"]).map_or(0, |t| t.timestamp_millis());
    let epoch = saved["epochs"].as_array().and_then(|e| e.last()).cloned().unwrap_or(Value::Null);
    Ok(Response::new(
        200,
        json!({
            "revision": format!("{}:{}:{}", grant["id"].as_str().unwrap_or_default(), saved["generation"], claim_ms),
            "retryAfterMs": 1000,
            "command": {
                "meetingId": grant["meeting_id"], "grantId": grant["id"], "ownerUserId": host_owner(host)?,
                "generation": saved["generation"], "capabilityRevision": revision,
                "expiresAt": grant["claim_expires_at"], "selection": epoch["selection"],
            },
        }),
    ))
}

fn host_owner<H: Host + ?Sized>(host: &H) -> Result<Value, Stop> {
    Ok(host.call("context", "read", "call", json!({}))?["actorUserId"].clone())
}

/// `POST /capture/claim`.
pub fn claim<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response, Stop> {
    let all = ["connectionId", "verifier", "grantId", "credentialHash"];
    let map = input::object(body, &all, &all)?;
    let connection_id = input::uuid(&map["connectionId"])?;
    let secret = input::verifier(&map["verifier"])?;
    let grant_id = input::uuid(&map["grantId"])?;
    let credential = input::hex64(&map["credentialHash"])?;
    let native = auth::native(host)?;
    store::lock(host, "device", &native.device_id)?;
    let at = now(host)?;
    let connection = valid(store::connection(host, &native.device_id)?, &native, &connection_id, &secret, at)?;
    let initial = store::grant(host, &grant_id)?.ok_or(denied())?;
    store::lock(host, "meeting", initial["meeting_id"].as_str().unwrap_or_default())?;
    let mut grant = store::grant(host, &grant_id)?.ok_or(denied())?;
    let theirs = grant["device_id"] == json!(native.device_id)
        && grant["connection_id"] == connection["connection_id"]
        && grant["capability_revision"].as_i64() == Some(native.capability_revision)
        && grant["verifier_hash"] == connection["verifier_hash"]
        && parse(&grant["expires_at"]).is_some_and(|t| t > at);
    if !theirs {
        return Err(denied().into());
    }
    auth::require_recording(host, &native.device_id, native.capability_revision)?;
    let status = grant["status"].as_str().unwrap_or_default().to_owned();
    let mut saved = store::state(&grant);
    if let Some(held) = grant["credential_hash"].as_str() {
        if held != credential || !["active", "finalizing", "complete"].contains(&status.as_str()) {
            return Err(Failure::new(CaptureCode::Conflict).into());
        }
    } else {
        if status != "approved" || !parse(&grant["claim_expires_at"]).is_some_and(|t| t > at) {
            return Err(denied().into());
        }
        if saved["desired"] != json!("recording") {
            return Err(Failure::new(CaptureCode::Conflict).into());
        }
        let epoch = saved["epochs"].as_array().and_then(|e| e.last()).cloned().ok_or(denied())?;
        let inventory = parsed(&connection)["inventory_json"].clone();
        validate(&epoch["selection"], &inventory)?;
        let started = stamp(at);
        saved["originAt"] = json!(started);
        let mut first = epoch.clone();
        first["epoch"] = json!(1);
        first["startMs"] = json!(0);
        first["endMs"] = Value::Null;
        saved["epochs"] = json!([first]);
        saved["lastSeenAt"] = json!(started);
        store::activate(host, &grant_id, &credential, &saved)?;
        grant["status"] = json!("active");
    }
    Ok(Response::new(
        200,
        json!({"meetingId": grant["meeting_id"], "grantId": grant["id"], "expiresAt": grant["expires_at"], "capture": view(&grant, &saved, at)}),
    ))
}
