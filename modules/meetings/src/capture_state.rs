//! The stored state of a capture grant and the view the browser reads. State stays JSON so the
//! shape the Mac app and the browser read does not change.
use crate::capture_errors::{CaptureCode, Failure};
use crate::capture_selection::LEASE_MS;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_GAPS: usize = 256;

fn millis(text: &Value) -> Option<i64> {
    text.as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp_millis())
}

/// Milliseconds from the recording's origin to `at`, never negative.
pub fn elapsed(state: &Value, at: DateTime<Utc>) -> i64 {
    (at.timestamp_millis() - millis(&state["originAt"]).unwrap_or(0)).max(0)
}

/// The state a new grant starts from, before the first record command is applied.
pub fn initial(inventory: &Value, origin: DateTime<Utc>, last_seen: &str) -> Value {
    json!({
        "maintenanceSequence": 0,
        "automaticRecoveryCount": 0,
        "gaps": [],
        "gapLimitReached": false,
        "generation": 0,
        "desired": "idle",
        "originAt": origin.to_rfc3339_opts(SecondsFormat::Millis, true),
        "epochs": [],
        "stopCutoffMs": null,
        "finalizationDeadline": null,
        "inventory": inventory,
        "observed": null,
        "lastSeenAt": last_seen,
        "recordedDurationMs": 0,
        "processing": {"status": "ready"},
        "transcriptRevision": 0,
    })
}

/// Keeps one lost-audio span. A repeat of the same span is ignored and a different span with the
/// same id conflicts. The 257th span stops the recording and flags the limit.
pub fn retain_gap(state: &mut Value, gap: Value, at: DateTime<Utc>) -> Result<(), Failure> {
    let invalid = || Failure::new(CaptureCode::InvalidInput);
    let epochs = state["epochs"].as_array().cloned().unwrap_or_default();
    let epoch = epochs.iter().find(|e| e["epoch"] == gap["epoch"]).ok_or_else(invalid)?;
    let next_start = epochs.iter().find(|e| e["epoch"].as_i64() > gap["epoch"].as_i64()).and_then(|e| e["startMs"].as_i64());
    let (start, end) = (gap["startMs"].as_i64().ok_or_else(invalid)?, gap["endMs"].as_i64().ok_or_else(invalid)?);
    let source = gap["sourceId"].as_str().unwrap_or_default();
    let mic_source = epoch["selection"]["microphone"]["sourceId"].as_str();
    let output_ok = epoch["selection"]["mode"] != "microphone-only" && epoch["selection"]["outputSourceId"].as_str() == Some(source);
    if start < epoch["startMs"].as_i64().unwrap_or(0)
        || end <= start
        || end > elapsed(state, at)
        || next_start.is_some_and(|next| end > next)
        || state["stopCutoffMs"].as_i64().is_some_and(|cut| end > cut)
        || (mic_source != Some(source) && !output_ok)
    {
        return Err(invalid());
    }
    let gaps = state["gaps"].as_array().cloned().unwrap_or_default();
    if let Some(prior) = gaps.iter().find(|g| g["id"] == gap["id"]) {
        for key in ["sourceId", "epoch", "startMs", "endMs", "reason"] {
            if prior[key] != gap[key] {
                return Err(Failure::new(CaptureCode::Conflict));
            }
        }
        return Ok(());
    }
    if gaps.len() >= MAX_GAPS {
        state["gapLimitReached"] = json!(true);
        if state["desired"] == "recording" {
            let stop = elapsed(state, at);
            if let Some(last) = state["epochs"].as_array_mut().and_then(|e| e.last_mut()) {
                last["endMs"] = json!(stop);
            }
            state["desired"] = json!("paused");
            state["generation"] = json!(state["generation"].as_i64().unwrap_or(0) + 1);
        }
        state["observed"] = json!({"generation": state["generation"], "phase": "error", "errorCode": CaptureCode::Limit.as_str()});
        return Ok(());
    }
    state["gaps"].as_array_mut().ok_or_else(invalid)?.push(gap);
    Ok(())
}

/// Ends a recording whose Mac stopped reporting. `ids` supply the gap ids, one per source.
pub fn expire_lease(state: &mut Value, at: DateTime<Utc>, expires_at: Option<DateTime<Utc>>, ids: &[String]) {
    let seen = millis(&state["lastSeenAt"]);
    if state["desired"] != "recording" || seen.is_some_and(|s| at.timestamp_millis() - s <= LEASE_MS) {
        return;
    }
    let origin = millis(&state["originAt"]).unwrap_or(0);
    let end = at
        .timestamp_millis()
        .min(seen.unwrap_or(origin) + LEASE_MS)
        .min(expires_at.map_or(origin + 7_200_000, |t| t.timestamp_millis()));
    let lease_end = DateTime::from_timestamp_millis(end).unwrap_or(at);
    let epoch = state["epochs"].as_array().and_then(|e| e.last()).cloned();
    if let Some(epoch) = &epoch {
        let start = epoch["startMs"].as_i64().unwrap_or(0).max(seen.map_or(epoch["startMs"].as_i64().unwrap_or(0), |s| s - origin));
        let finish = elapsed(state, lease_end);
        if finish > start {
            let mut sources: Vec<String> = vec![];
            if let Some(mic) = epoch["selection"]["microphone"]["sourceId"].as_str() {
                sources.push(mic.to_owned());
            }
            if epoch["selection"]["mode"] != "microphone-only" {
                sources.push(epoch["selection"]["outputSourceId"].as_str().unwrap_or_default().to_owned());
            }
            for (index, source) in sources.into_iter().enumerate() {
                let gap = json!({"id": ids.get(index).cloned().unwrap_or_default(), "sourceId": source,
                    "epoch": epoch["epoch"], "startMs": start, "endMs": finish, "reason": "interrupted"});
                let _ = retain_gap(state, gap, lease_end);
            }
        }
        if epoch["endMs"].is_null() {
            let stop = elapsed(state, lease_end);
            if let Some(last) = state["epochs"].as_array_mut().and_then(|e| e.last_mut()) {
                last["endMs"] = json!(stop);
            }
        }
    }
    state["desired"] = json!("paused");
    state["generation"] = json!(state["generation"].as_i64().unwrap_or(0) + 1);
    state["observed"] = json!({"generation": state["generation"], "phase": "error", "errorCode": CaptureCode::Interrupted.as_str()});
}

/// The browser's view of a grant. The revision changes when anything but the clock changes.
pub fn view(grant: &Value, state: &Value, at: DateTime<Utc>) -> Value {
    let epoch = state["epochs"].as_array().and_then(|e| e.last());
    let deadline_passed = millis(&state["finalizationDeadline"]).is_some_and(|d| at.timestamp_millis() >= d);
    let finalization = if state["desired"] == "stopped" {
        if state["finalized"] == json!(true) || grant["status"] == "complete" || deadline_passed { "complete" } else { "pending" }
    } else {
        "none"
    };
    let mut semantic = state.clone();
    if let Some(map) = semantic.as_object_mut() {
        for key in ["lastSeenAt", "recordedDurationMs", "maintenanceSequence"] {
            map.remove(key);
        }
    }
    let digest = Sha256::digest(json!({"state": semantic, "status": grant["status"]}).to_string().as_bytes());
    let revision: String = digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..32].to_owned();
    let processing = if finalization == "complete" { json!({"status": "ready"}) } else { state["processing"].clone().as_object().map_or(json!({"status": "ready"}), |_| state["processing"].clone()) };
    let mut out = json!({
        "revision": revision,
        "transcriptRevision": state["transcriptRevision"].as_i64().unwrap_or(0),
        "leaseMs": LEASE_MS,
        "recordedDurationMs": state["recordedDurationMs"].as_i64().unwrap_or(0),
        "finalization": finalization,
        "processing": processing,
        "gaps": state["gaps"],
        "gapLimitReached": state["gapLimitReached"],
        "grantId": grant["id"],
        "deviceId": grant["device_id"],
        "deviceName": grant["device_name"],
        "generation": state["generation"],
        "epoch": epoch.map_or(0, |e| e["epoch"].as_i64().unwrap_or(0)),
        "desired": state["desired"],
        "selection": epoch.map_or(Value::Null, |e| e["selection"].clone()),
        "epochStartMs": epoch.map_or(0, |e| e["startMs"].as_i64().unwrap_or(0)),
        "epochEndMs": epoch.map_or(Value::Null, |e| e["endMs"].clone()),
        "stopCutoffMs": state["stopCutoffMs"],
        "finalizationDeadline": state["finalizationDeadline"],
        "expiresAt": grant["expires_at"],
        "serverTime": at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "elapsedMs": elapsed(state, at),
        "inventory": state["inventory"],
        "observed": state["observed"],
        "lastSeenAt": state["lastSeenAt"],
    });
    if !state["revocationReason"].is_null() {
        out["revocationReason"] = state["revocationReason"].clone();
    }
    out
}

/// A lease is current while the Mac was seen within the lease window.
pub fn lease_current(state: &Value, at: DateTime<Utc>) -> bool {
    millis(&state["lastSeenAt"]).is_some_and(|seen| at.timestamp_millis() - seen <= LEASE_MS)
}

const FINALIZATION_MS: i64 = 60_000;

fn close_epoch(state: &mut Value, at_ms: i64) {
    if let Some(epoch) = state["epochs"].as_array_mut().and_then(|e| e.last_mut()) {
        if epoch["endMs"].is_null() {
            epoch["endMs"] = json!(at_ms);
        }
    }
}

/// Stops the recording. A stop that already happened changes nothing.
pub fn stop(state: &mut Value, at: DateTime<Utc>) {
    if state["desired"] == "stopped" {
        return;
    }
    let at_ms = elapsed(state, at);
    close_epoch(state, at_ms);
    state["stopCutoffMs"] = json!(at_ms);
    state["finalizationDeadline"] = json!((at + Duration::milliseconds(FINALIZATION_MS)).to_rfc3339_opts(SecondsFormat::Millis, true));
    state["desired"] = json!("stopped");
    state["generation"] = json!(state["generation"].as_i64().unwrap_or(0) + 1);
}

/// Revokes the link at `at_ms` of the recording clock and tells the Mac it stopped.
pub fn revoke(state: &mut Value, at_ms: i64, reason: Option<&str>) {
    close_epoch(state, at_ms);
    state["desired"] = json!("revoked");
    if let Some(reason) = reason {
        state["revocationReason"] = json!(reason);
    }
    let generation = state["generation"].as_i64().unwrap_or(0) + 1;
    state["generation"] = json!(generation);
    state["observed"] = json!({"generation": generation, "phase": "stopped"});
}
