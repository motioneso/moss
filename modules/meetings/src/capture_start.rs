//! Start and cancel-start. A start binds the browser session, the meeting, the Mac, the
//! connection and the sources into one grant. It never records until the Mac claims it.
use crate::capture_auth::{self as auth, hash, Browser};
use crate::capture_connection::{eligible, parsed};
use crate::capture_devices::default_connection;
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_input as input;
use crate::capture_selection::{record, resolve_source, saved_selection};
use crate::capture_state::{initial, view};
use crate::capture_store::{self as store, now, parse, NewGrant, PREVIOUS_GRANTS};
use chrono::{DateTime, Duration, Utc};
use moss_module_sdk::{query::{Filter, Order, Query}, Client, Host, Response};
use serde_json::{json, Value};

const CLAIM_MS: i64 = 60_000;
const GRANT_MS: i64 = 7_200_000;

/// The start request body. Only the request key is accepted for a saved source. A body that
/// names a device is checked for shape and then refused, as the old route refused it.
struct Body {
    request_key: String,
    names_device: bool,
}

fn body(value: &Value) -> Result<Body, Failure> {
    if let Ok(map) = input::object(value, &["requestKey"], &["requestKey"]) {
        return Ok(Body { request_key: input::uuid(&map["requestKey"])?, names_device: false });
    }
    let all = ["deviceId", "connectionId", "expectedRevision", "requestKey", "selection"];
    let map = input::object(value, &all, &all)?;
    input::uuid(&map["deviceId"])?;
    input::uuid(&map["connectionId"])?;
    if map["expectedRevision"].as_i64().is_none_or(|n| n < 1) || !map["selection"].is_object() {
        return Err(Failure::new(CaptureCode::InvalidInput));
    }
    Ok(Body { request_key: input::uuid(&map["requestKey"])?, names_device: true })
}

fn conflict() -> Stop {
    Failure::new(CaptureCode::Conflict).into()
}

/// A stored start answers again with the same grant, or is refused when anything differs.
fn replay<H: Host + ?Sized>(host: &H, request_key: &str, meeting: &str, fingerprint: &str, at: DateTime<Utc>) -> Result<Option<Value>, Stop> {
    if store::cancelled(host, request_key)? {
        return Err(conflict());
    }
    let Some(previous) = store::by_request(host, request_key)? else { return Ok(None) };
    let saved = store::state(&previous);
    let stale_claim = previous["status"] == "approved"
        && saved["desired"] != json!("paused")
        && !parse(&previous["claim_expires_at"]).is_some_and(|t| t > at);
    if previous["start_fingerprint"] != json!(fingerprint)
        || previous["meeting_id"] != json!(meeting)
        || previous["status"] == "revoked"
        || stale_claim
        || !parse(&previous["expires_at"]).is_some_and(|t| t > at)
    {
        return Err(conflict());
    }
    auth::require_recording(host, previous["device_id"].as_str().unwrap_or_default(), previous["capability_revision"].as_i64().unwrap_or(0))?;
    Ok(Some(json!({"capture": view(&previous, &saved, at)})))
}

fn transcript_version<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<i64, Stop> {
    let mut latest = Query::select(Filter::eq("meeting_id", meeting));
    latest.order = vec![Order { column: "version".into(), descending: true }];
    latest.limit = Some(1);
    let rows = Client(host).query("app.meeting_transcript_batches", &latest)?;
    Ok(rows.first().and_then(|r| r["version"].as_i64()).unwrap_or(0))
}

/// `POST /records/:id/capture/start`.
pub fn start<H: Host + ?Sized>(host: &H, meeting: &str, value: &Value) -> Result<Response, Stop> {
    let request = body(value)?;
    let session: Browser = auth::browser(host)?;
    let at = now(host)?;
    store::take_budget(host, at)?;
    let fingerprint = hash(&json!({"meetingId": meeting, "sessionId": session.session_id, "body": value}).to_string());
    store::lock(host, "request", &request.request_key)?;
    let preferences = crate::preferences::current(host)?;
    let page = store::connections(host)?;
    let prior = store::by_request(host, &request.request_key)?;
    let remembered = preferences["rememberedSource"]["deviceId"].as_str();
    let connection = match &prior {
        Some(_) => None,
        None => {
            let candidates: Vec<Value> = match remembered {
                Some(id) => page.iter().filter(|c| c["device_id"] == json!(id)).cloned().collect(),
                None => page.clone(),
            };
            let live = eligible(host, &candidates, at)?;
            Some(default_connection(&candidates, &live, remembered.is_some())?.clone())
        }
    };
    let device = prior.as_ref().map(|p| p["device_id"].clone()).or_else(|| connection.as_ref().map(|c| c["device_id"].clone())).unwrap_or(Value::Null);
    let device = device.as_str().unwrap_or_default().to_owned();
    store::lock(host, "device", &device)?;
    store::lock(host, "meeting", meeting)?;
    if let Some(done) = replay(host, &request.request_key, meeting, &fingerprint, at)? {
        return Ok(Response::new(200, done));
    }
    if request.names_device {
        return Err(Failure::new(CaptureCode::SourceUnavailable).into());
    }
    let connection = parsed(&connection.ok_or_else(|| Failure::new(CaptureCode::SourceUnavailable))?);
    let inventory = connection["inventory_json"].clone();
    let source = resolve_source(&preferences, &device, &inventory)?;
    let Some(route) = auth::processing_route(host)? else {
        return Err(Failure::new(CaptureCode::ProcessingUnavailable).into());
    };
    let capability_ends = auth::require_recording(host, &device, connection["capability_revision"].as_i64().unwrap_or(0))?;
    let selection = saved_selection(&source, &inventory)?;
    store::retire(host, &device, at)?;
    let previous = store::grants_for_meeting(host, meeting)?;
    let holds = previous.iter().any(|g| g["status"] == "active" || g["status"] == "approved");
    if store::occupied(host, &device, connection["connection_id"].as_str().unwrap_or_default())? || holds {
        return Err(Failure::new(CaptureCode::Busy).into());
    }
    if previous.len() >= PREVIOUS_GRANTS as usize {
        return Err(Failure::new(CaptureCode::Limit).into());
    }
    if previous.iter().any(|g| g["state_json"].is_string() && !store::state(g)["observed"].is_null()) || transcript_version(host, meeting)? > 0 {
        return Err(conflict());
    }
    let mut saved = initial(&inventory, at, connection["last_seen_at"].as_str().unwrap_or_default());
    let since_seen = parse(&connection["last_seen_at"]).map(|seen| (at - seen).num_milliseconds());
    record(&mut saved, &selection, 0, 0, since_seen, &route)?;
    let expires = (at + Duration::milliseconds(GRANT_MS)).min(session.expires_at).min(capability_ends).min(parse(&connection["expires_at"]).unwrap_or(at));
    let grant = store::create(
        host,
        &NewGrant {
            meeting_id: meeting,
            session_id: &session.session_id,
            connection: &connection,
            request_key: &request.request_key,
            fingerprint: &fingerprint,
            expires_at: expires,
            claim_expires_at: at + Duration::milliseconds(CLAIM_MS),
            state: &saved,
        },
    )?;
    crate::capture_maintenance::schedule(host, grant["id"].as_str().unwrap_or_default(), 0, at)?;
    Ok(Response::new(200, json!({"capture": view(&grant, &saved, at)})))
}

/// `POST /records/:id/capture/cancel-start`.
pub fn cancel_start<H: Host + ?Sized>(host: &H, meeting: &str, value: &Value) -> Result<Response, Stop> {
    let map = input::object(value, &["requestKey"], &["requestKey", "deviceId", "connectionId"])?;
    let request_key = input::uuid(&map["requestKey"])?;
    let device = map.get("deviceId").map(input::uuid).transpose()?;
    let connection = map.get("connectionId").map(input::uuid).transpose()?;
    if device.is_some() != connection.is_some() {
        return Err(Failure::new(CaptureCode::InvalidInput).into());
    }
    auth::browser(host)?;
    store::lock(host, "request", &request_key)?;
    if let Some(initial) = store::by_request(host, &request_key)? {
        store::lock(host, "device", initial["device_id"].as_str().unwrap_or_default())?;
    }
    store::lock(host, "meeting", meeting)?;
    let grant = store::by_request(host, &request_key)?;
    let at = now(host)?;
    if let Some(g) = &grant {
        if g["meeting_id"] != json!(meeting)
            || device.as_ref().is_some_and(|d| g["device_id"] != json!(d))
            || connection.as_ref().is_some_and(|c| g["connection_id"] != json!(c))
        {
            return Err(conflict());
        }
    }
    store::cancel(host, meeting, &request_key, device.as_deref(), connection.as_deref())?;
    let Some(grant) = grant else {
        return Ok(Response::new(200, json!({"cancelled": true, "capture": null})));
    };
    let mut saved = store::state(&grant);
    if grant["status"] == "revoked" {
        saved["desired"] = json!("revoked");
    } else {
        crate::capture_state::stop(&mut saved, at);
    }
    if grant["credential_hash"].is_null() && saved["desired"] == "stopped" {
        saved["observed"] = json!({"generation": saved["generation"], "phase": "stopped"});
    }
    store::save(host, &grant, &saved)?;
    let mut current = grant.clone();
    if let Some(status) = saved["desired"].as_str().and_then(|d| match d {
        "revoked" => Some("revoked"),
        "stopped" => Some("finalizing"),
        _ => None,
    }) {
        current["status"] = json!(status);
    }
    Ok(Response::new(200, json!({"cancelled": true, "capture": view(&current, &saved, at)})))
}
