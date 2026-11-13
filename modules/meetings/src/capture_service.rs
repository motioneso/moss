//! Record, pause, stop and revoke from the browser, and the same commands plus source changes
//! from the Mac. Every command is idempotent by request key: the stored receipt answers a repeat.
use crate::capture_auth::{self as auth, denied, hash};
use crate::capture_connection::parsed;
use crate::capture_control::{apply, change_sources};
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_ingest as ingest;
use crate::capture_native as native;
use crate::capture_receipts as receipts;
use crate::capture_selection::{resolve_source, saved_selection, LEASE_MS};
use crate::capture_state::{expire_lease, view};
use crate::capture_store::{self as store, new_id, now, parse, stamp};
use crate::stop_summary;
use chrono::{DateTime, Duration, Utc};
use moss_module_sdk::{query::{Filter, Query}, Client, Host, Response};
use serde_json::{json, Value};

/// A validated control body.
pub struct Control {
    pub meeting_id: Option<String>,
    pub grant_id: String,
    pub request_key: String,
    pub expected_generation: i64,
    pub command: String,
    pub selection: Option<Value>,
    pub expected_epoch: Option<i64>,
}

impl Control {
    fn fingerprint(&self) -> String {
        hash(&json!({"expectedGeneration": self.expected_generation, "command": self.command, "selection": self.selection}).to_string())
    }
}

fn conflict() -> Stop {
    Failure::new(CaptureCode::Conflict).into()
}

fn capture(grant: &Value, state: &Value, at: DateTime<Utc>) -> Value {
    json!({"capture": view(grant, state, at)})
}

/// Queues the automatic summary when a stop has a deadline.
pub fn schedule_summary<H: Host + ?Sized>(host: &H, meeting: &str, grant: &Value, state: &Value, stopped_now: bool) -> Result<(), Stop> {
    if state["desired"] == "stopped" && !state["stopCutoffMs"].is_null() {
        if let Some(deadline) = state["finalizationDeadline"].as_str() {
            stop_summary::schedule_capture(host, meeting, grant["id"].as_str().unwrap_or_default(), deadline, state["finalized"] == json!(true), stopped_now)?;
        }
    }
    Ok(())
}

fn live(grant: &Value, meeting: &str, at: DateTime<Utc>) -> Result<(), Stop> {
    if grant["meeting_id"] != json!(meeting) || grant["status"] == "revoked" || !parse(&grant["expires_at"]).is_some_and(|t| t > at) {
        return Err(denied().into());
    }
    Ok(())
}

/// `POST /records/:id/capture/control`.
pub fn browser_control<H: Host + ?Sized>(host: &H, meeting: &str, input: &Control) -> Result<Response, Stop> {
    if !matches!(input.command.as_str(), "record" | "pause" | "stop" | "revoke") {
        return Err(denied().into());
    }
    auth::browser(host)?;
    let first = store::grant(host, &input.grant_id)?.filter(|g| g["meeting_id"] == json!(meeting)).ok_or_else(denied)?;
    store::lock(host, "device", first["device_id"].as_str().unwrap_or_default())?;
    store::lock(host, "meeting", meeting)?;
    let grant = store::grant(host, &input.grant_id)?.filter(|g| g["meeting_id"] == json!(meeting)).ok_or_else(denied)?;
    if input.command != "revoke" {
        live(&grant, meeting, now(host)?)?;
        auth::require_recording(host, grant["device_id"].as_str().unwrap_or_default(), grant["capability_revision"].as_i64().unwrap_or(0))?;
    }
    Ok(Response::new(200, run(host, grant, meeting, input, false)?))
}

/// `POST /capture/control`.
pub fn native_control<H: Host + ?Sized>(host: &H, input: &Control) -> Result<Response, Stop> {
    let meeting = input.meeting_id.clone().ok_or_else(denied)?;
    let grant = native::prove(host, &meeting, &input.grant_id)?;
    if matches!(input.command.as_str(), "change-sources" | "recover-sources") {
        return Ok(Response::new(200, source_change(host, grant, input)?));
    }
    Ok(Response::new(200, run(host, grant, &meeting, input, true)?))
}

fn source_change<H: Host + ?Sized>(host: &H, grant: Value, input: &Control) -> Result<Value, Stop> {
    let at = now(host)?;
    let grant_id = grant["id"].as_str().unwrap_or_default().to_owned();
    let fingerprint = hash(&json!({"command": input.command, "expectedGeneration": input.expected_generation, "expectedEpoch": input.expected_epoch, "selection": input.selection}).to_string());
    let mut state = store::state(&grant);
    if let Some(prior) = receipts::receipt(host, &grant_id, &input.request_key, &fingerprint)? {
        if receipts::result(&prior).is_some() {
            return Ok(capture(&grant, &state, at));
        }
    }
    let connection = store::connection(host, grant["device_id"].as_str().unwrap_or_default())?;
    let fresh = connection.as_ref().is_some_and(|c| parse(&c["expires_at"]).is_some_and(|t| t > at) && parse(&c["last_seen_at"]).is_some_and(|t| (at - t).num_milliseconds() <= LEASE_MS));
    if grant["status"] != "active" || grant["credential_hash"].is_null() {
        return Err(conflict());
    }
    let Some(connection) = connection.filter(|_| fresh) else { return Err(Failure::new(CaptureCode::SourceUnavailable).into()) };
    receipts::reconcile_expired(host, &grant_id, &mut state, at)?;
    expire_lease(&mut state, at, parse(&grant["expires_at"]), &[new_id(host)?, new_id(host)?]);
    state["inventory"] = parsed(&connection)["inventory_json"].clone();
    let selection = input.selection.as_ref().ok_or_else(|| Failure::new(CaptureCode::InvalidInput))?;
    change_sources(&mut state, &input.command, input.expected_generation, input.expected_epoch.unwrap_or(0), selection, at)?;
    store::save(host, &grant, &state)?;
    let result = capture(&grant, &state, at);
    receipts::reserve(host, &grant_id, &input.request_key, "control", &fingerprint, &json!({"command": input.command}), Some(&result))?;
    Ok(result)
}

/// Extends the claim window of an approved grant by a minute, never past its expiry.
fn renew_claim<H: Host + ?Sized>(host: &H, grant: &Value, at: DateTime<Utc>) -> Result<(), Stop> {
    let until = (at + Duration::seconds(60)).min(parse(&grant["expires_at"]).unwrap_or(at));
    Client(host).query(store::GRANTS, &Query::update(Filter::eq("id", grant["id"].as_str().unwrap_or_default()), store::values(vec![("claim_expires_at", json!(stamp(until)))])))?;
    Ok(())
}

fn run<H: Host + ?Sized>(host: &H, grant: Value, meeting: &str, input: &Control, is_native: bool) -> Result<Value, Stop> {
    let at = now(host)?;
    let grant_id = grant["id"].as_str().unwrap_or_default().to_owned();
    let fingerprint = input.fingerprint();
    let mut state = store::state(&grant);
    if let Some(prior) = receipts::receipt(host, &grant_id, &input.request_key, &fingerprint)? {
        if receipts::result(&prior).is_some() {
            return Ok(capture(&grant, &state, at));
        }
    }
    let record = input.command == "record";
    let route = if record { auth::processing_route(host).ok().flatten() } else { None };
    if record && route.is_none() {
        return Err(Failure::new(CaptureCode::ProcessingUnavailable).into());
    }
    // A native record only resumes its own paused epoch.
    if is_native && record && (grant["status"] != "active" || grant["credential_hash"].is_null() || state["desired"] != "paused" || !state["epochs"].as_array().and_then(|e| e.last()).is_some_and(|e| e["selection"].is_object())) {
        return Err(denied().into());
    }
    receipts::reconcile_expired(host, &grant_id, &mut state, at)?;
    if grant["status"] != "approved" {
        expire_lease(&mut state, at, parse(&grant["expires_at"]), &[new_id(host)?, new_id(host)?]);
    }
    let mut selection = None;
    let mut resuming = false;
    if record {
        if input.selection.is_some() {
            return Err(Failure::new(CaptureCode::SourceUnavailable).into());
        }
        let unavailable = || Stop::from(Failure::new(CaptureCode::SourceUnavailable));
        let device = grant["device_id"].as_str().unwrap_or_default();
        let connection = store::connection(host, device)?.filter(|c| {
            c["connection_id"] == grant["connection_id"]
                && c["capability_revision"] == grant["capability_revision"]
                && parse(&c["expires_at"]).is_some_and(|t| t > at)
                && parse(&c["last_seen_at"]).is_some_and(|t| (at - t).num_milliseconds() <= LEASE_MS)
        });
        let connection = connection.ok_or_else(unavailable)?;
        state["inventory"] = parsed(&connection)["inventory_json"].clone();
        if grant["status"] == "approved" {
            state["lastSeenAt"] = connection["last_seen_at"].clone();
        }
        resuming = state["desired"] == "paused";
        selection = Some(if resuming {
            state["epochs"].as_array().and_then(|e| e.last()).map_or(Value::Null, |e| e["selection"].clone())
        } else {
            let source = resolve_source(&crate::preferences::current(host)?, device, &state["inventory"])?;
            saved_selection(&source, &state["inventory"])?
        });
    }
    if let Err(failure) = apply(&mut state, &input.command, input.expected_generation, selection.as_ref(), at, route.as_deref().unwrap_or("")) {
        // A retained source that no longer validates gets recovery guidance.
        return Err(if resuming && failure.code == CaptureCode::InvalidInput && failure.status == 400 { Failure::new(CaptureCode::SourceUnavailable).into() } else { failure.into() });
    }
    if grant["status"] == "approved" && record {
        renew_claim(host, &grant, at)?;
    }
    if grant["status"] == "approved" && grant["credential_hash"].is_null() {
        state["observed"] = if record {
            Value::Null
        } else {
            json!({"generation": state["generation"], "phase": if input.command == "pause" { "paused" } else { "stopped" }})
        };
    }
    store::save(host, &grant, &state)?;
    let stopping = input.command == "stop";
    if stopping {
        ingest::close(host, meeting, &input.request_key, state["stopCutoffMs"].as_i64())?;
    }
    schedule_summary(host, meeting, &grant, &state, stopping)?;
    let result = capture(&grant, &state, at);
    receipts::reserve(host, &grant_id, &input.request_key, "control", &fingerprint, &json!({"command": input.command}), Some(&result))?;
    Ok(result)
}
