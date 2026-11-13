//! Status reads. The Mac reports what it observed and gets the current state back. The browser
//! reads the same state. Neither call waits: the browser repeats the call after `retryAfterMs`.
use crate::capture_auth as auth;
use crate::capture_connection::parsed;
use crate::capture_control::apply;
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_ingest as ingest;
use crate::capture_native as native;
use crate::capture_receipts as receipts;
use crate::capture_service::schedule_summary;
use crate::capture_state::{expire_lease, retain_gap, view};
use crate::capture_store::{self as store, new_id, now, parse, stamp};
use moss_module_sdk::{Host, Response};
use serde_json::{json, Value};

pub struct Report {
    pub meeting_id: String,
    pub grant_id: String,
    pub inventory: Value,
    pub observed: Value,
    pub gaps: Vec<Value>,
    pub finalized: bool,
    pub recorded_duration_ms: Option<i64>,
}

fn invalid() -> Stop {
    Failure::new(CaptureCode::InvalidInput).into()
}

/// `POST /capture/status`.
pub fn native_status<H: Host + ?Sized>(host: &H, report: &Report) -> Result<Response, Stop> {
    let grant = native::prove(host, &report.meeting_id, &report.grant_id)?;
    let at = now(host)?;
    let grant_id = report.grant_id.as_str();
    let mut state = store::state(&grant);
    receipts::reconcile_expired(host, grant_id, &mut state, at)?;
    expire_lease(&mut state, at, parse(&grant["expires_at"]), &[new_id(host)?, new_id(host)?]);
    let generation = state["generation"].as_i64().unwrap_or(0);
    let reported = report.observed["generation"].as_i64().unwrap_or(0);
    if reported > generation {
        return Err(Failure::new(CaptureCode::Conflict).into());
    }
    let mut observed = report.observed.clone();
    let phase = observed["phase"].as_str().unwrap_or_default().to_owned();
    if reported == generation && matches!(phase.as_str(), "error" | "paused") && state["desired"] == "recording" {
        apply(&mut state, "pause", generation, None, at, "")?;
        // A paused report already confirms the pause it caused. An error alone does not.
        if phase == "paused" {
            observed["generation"] = state["generation"].clone();
        }
    }
    for gap in &report.gaps {
        retain_gap(&mut state, gap.clone(), at)?;
    }
    state["inventory"] = report.inventory.clone();
    let seen = state["observed"]["generation"].as_i64().unwrap_or(0);
    let current = state["generation"].as_i64().unwrap_or(0);
    if observed["generation"].as_i64().unwrap_or(0) >= seen {
        if state["gapLimitReached"] != json!(true) {
            state["observed"] = observed;
        } else if observed["generation"].as_i64() == Some(current) && matches!(phase.as_str(), "paused" | "stopped") {
            // The loss warning stays, and a safe stop for the current generation still shows.
            let mut kept = observed;
            kept["errorCode"] = json!(CaptureCode::Limit.as_str());
            state["observed"] = kept;
        }
    }
    if let Some(duration) = report.recorded_duration_ms.filter(|_| reported == current) {
        let origin = parse(&state["originAt"]).map_or(0, |t| t.timestamp_millis());
        if duration < state["recordedDurationMs"].as_i64().unwrap_or(0) || duration > at.timestamp_millis() - origin {
            return Err(invalid());
        }
        state["recordedDurationMs"] = json!(duration);
    }
    if report.finalized && state["desired"] == "stopped" && phase == "stopped" && reported == current && !receipts::has_pending(host, grant_id)? {
        state["finalized"] = json!(true);
    }
    state["lastSeenAt"] = json!(stamp(at));
    store::save(host, &grant, &state)?;
    schedule_summary(host, &report.meeting_id, &grant, &state, false)?;
    let capture = view(&grant, &state, at);
    Ok(Response::new(200, json!({"capture": capture})))
}

/// `GET /records/:id/capture`.
pub fn browser_status<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<Response, Stop> {
    auth::browser(host)?;
    store::lock(host, "meeting", meeting)?;
    let at = now(host)?;
    let grants = store::grants_for_meeting(host, meeting)?;
    let grant = grants.iter().find(|g| g["status"] == "active").or_else(|| grants.iter().find(|g| !g["state_json"].is_null())).cloned();
    let mut capture = Value::Null;
    if let Some(grant) = grant.filter(|g| !g["state_json"].is_null()) {
        let id = grant["id"].as_str().unwrap_or_default();
        let mut state = store::state(&grant);
        receipts::reconcile_expired(host, id, &mut state, at)?;
        if grant["status"] == "approved" {
            if state["desired"] != "paused" && !parse(&grant["claim_expires_at"]).is_some_and(|t| t > at) {
                state["desired"] = json!("revoked");
            }
        } else {
            expire_lease(&mut state, at, parse(&grant["expires_at"]), &[new_id(host)?, new_id(host)?]);
        }
        if matches!(grant["status"].as_str(), Some("active" | "approved" | "finalizing")) {
            let device = grant["device_id"].as_str().unwrap_or_default();
            if auth::recording(host, device, grant["capability_revision"].as_i64().unwrap_or(0))?.is_none() {
                state["desired"] = json!("revoked");
                state["revocationReason"] = json!("recording-permission-revoked");
            }
        }
        let expired = !parse(&grant["expires_at"]).is_some_and(|t| t > at);
        if expired || grant["status"] == "revoked" {
            state["desired"] = json!("revoked");
            if expired && state["revocationReason"].is_null() {
                state["revocationReason"] = json!("expired");
            }
        }
        if state["desired"] == "stopped" && parse(&state["finalizationDeadline"]).is_some_and(|d| at >= d) {
            state["finalized"] = json!(true);
        }
        if let Some((receipt, _)) = ingest::head(host, meeting)? {
            state["transcriptRevision"] = json!(receipt.transcript_revision);
        }
        if store::state(&grant) != state {
            store::save(host, &grant, &state)?;
        }
        if grant["status"] == "approved" {
            if let Some(c) = store::connection(host, grant["device_id"].as_str().unwrap_or_default())?
                .filter(|c| c["connection_id"] == grant["connection_id"] && c["capability_revision"] == grant["capability_revision"])
            {
                state["inventory"] = parsed(&c)["inventory_json"].clone();
                state["lastSeenAt"] = c["last_seen_at"].clone();
            }
        }
        schedule_summary(host, meeting, &grant, &state, false)?;
        capture = view(&grant, &state, at);
    }
    let ready = auth::processing_route(host)?.is_some();
    Ok(Response::new(
        200,
        json!({"capture": capture, "pendingLinks": [], "processingReady": ready, "revision": if capture.is_null() { json!("none") } else { capture["revision"].clone() }, "retryAfterMs": 1000}),
    ))
}

