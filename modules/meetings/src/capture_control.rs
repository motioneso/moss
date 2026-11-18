//! The state changes the record, pause, stop, revoke and source-change commands make. Each one
//! checks the caller's generation first, so a stale browser or Mac cannot move a newer state.
use crate::capture_auth::denied;
use crate::capture_errors::{CaptureCode, Failure};
use crate::capture_selection::{label, record, validate, LEASE_MS};
use crate::capture_state::{elapsed, stop};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

const MAX_EPOCHS: usize = 64;
const MAX_AUTOMATIC_RECOVERIES: i64 = 8;
const MANUAL_RESERVE: usize = 8;

fn invalid() -> Failure {
    Failure::new(CaptureCode::InvalidInput)
}

fn conflict() -> Failure {
    Failure::new(CaptureCode::Conflict)
}

fn bump(state: &mut Value) {
    state["generation"] = json!(state["generation"].as_i64().unwrap_or(0) + 1);
}

fn close_last(state: &mut Value, at_ms: i64) {
    if let Some(last) = state["epochs"].as_array_mut().and_then(|e| e.last_mut()) {
        if last["endMs"].is_null() {
            last["endMs"] = json!(at_ms);
        }
    }
}

fn since_seen(state: &Value, at: DateTime<Utc>) -> Option<i64> {
    state["lastSeenAt"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| at.timestamp_millis() - t.timestamp_millis())
}

/// Applies `pause`, `stop`, `revoke` or `record`. `selection` is only read by `record`.
pub fn apply(state: &mut Value, command: &str, expected_generation: i64, selection: Option<&Value>, at: DateTime<Utc>, model_route: &str) -> Result<(), Failure> {
    if state["generation"].as_i64() != Some(expected_generation) {
        return Err(conflict());
    }
    if state["desired"] == "revoked" {
        return Err(denied());
    }
    let at_ms = elapsed(state, at);
    match command {
        "record" => {
            let selection = selection.ok_or_else(invalid)?;
            record(state, selection, expected_generation, at_ms, since_seen(state, at), model_route)
        }
        "pause" => {
            if state["desired"] != "recording" {
                return Err(invalid());
            }
            close_last(state, at_ms);
            state["desired"] = json!("paused");
            bump(state);
            Ok(())
        }
        "stop" => {
            stop(state, at);
            Ok(())
        }
        "revoke" => {
            close_last(state, at_ms);
            state["desired"] = json!("revoked");
            bump(state);
            Ok(())
        }
        _ => Err(invalid()),
    }
}

/// A native change of sources or an automatic recovery. Either one opens a new epoch.
pub fn change_sources(state: &mut Value, command: &str, expected_generation: i64, expected_epoch: i64, selection: &Value, at: DateTime<Utc>) -> Result<(), Failure> {
    let epochs = state["epochs"].as_array().cloned().unwrap_or_default();
    let current = epochs.last().cloned();
    if state["generation"].as_i64() != Some(expected_generation) || current.as_ref().and_then(|c| c["epoch"].as_i64()) != Some(expected_epoch) {
        return Err(conflict());
    }
    let paused = state["desired"] == "paused";
    let current = match (&current, state["desired"].as_str(), state["inventory"].is_object()) {
        (Some(c), Some("recording" | "paused"), true) => c.clone(),
        _ => return Err(invalid()),
    };
    if command == "recover-sources" && (paused || !current["endMs"].is_null() || &current["selection"] != selection) {
        return Err(invalid());
    }
    if state["gapLimitReached"] == json!(true) || epochs.len() >= MAX_EPOCHS {
        return Err(Failure::new(CaptureCode::Limit));
    }
    let recoveries = state["automaticRecoveryCount"].as_i64().unwrap_or(0);
    if command == "recover-sources" && (recoveries < 0 || recoveries >= MAX_AUTOMATIC_RECOVERIES || epochs.len() >= MAX_EPOCHS - MANUAL_RESERVE) {
        return Err(Failure::new(CaptureCode::Limit));
    }
    if since_seen(state, at).is_none_or(|ms| ms > LEASE_MS) {
        return Err(Failure::new(CaptureCode::Interrupted));
    }
    validate(selection, &state["inventory"])?;
    // A source id keeps its kind across the whole transcript history.
    let mic = selection["microphone"]["sourceId"].as_str();
    let output = (selection["mode"] != "microphone-only").then(|| selection["outputSourceId"].as_str()).flatten();
    for epoch in &epochs {
        let old = &epoch["selection"];
        let old_output = (old["mode"] != "microphone-only").then(|| old["outputSourceId"].as_str()).flatten();
        if (mic.is_some() && mic == old_output) || (output.is_some() && output == old["microphone"]["sourceId"].as_str()) {
            return Err(invalid());
        }
    }
    let at_ms = elapsed(state, at);
    if at_ms < current["endMs"].as_i64().or(current["startMs"].as_i64()).unwrap_or(0) {
        return Err(conflict());
    }
    let (microphone_label, output_label) = label(&state["inventory"], selection);
    let next = json!({
        "modelRoute": current["modelRoute"], "epoch": epochs.len() + 1, "generation": expected_generation + 1,
        "startMs": at_ms, "endMs": if paused { json!(at_ms) } else { Value::Null },
        "selection": selection, "microphoneLabel": microphone_label, "outputLabel": output_label,
    });
    if command == "recover-sources" {
        state["automaticRecoveryCount"] = json!(recoveries + 1);
    }
    close_last(state, at_ms);
    state["epochs"].as_array_mut().ok_or_else(invalid)?.push(next);
    bump(state);
    Ok(())
}
