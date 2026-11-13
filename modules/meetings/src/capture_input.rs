//! Request body checks for the Mac link routes. Every route rejects a body with an unknown key.
//! A refused body is a 400 with a code only, never an echo of what was sent.
use crate::capture_errors::{CaptureCode, Failure};
use crate::text::is_uuid;
use serde_json::Value;

fn bad() -> Failure {
    Failure::new(CaptureCode::InvalidInput)
}

/// The body as an object whose keys are all in `allowed` and include every key in `required`.
pub fn object<'a>(body: &'a Value, required: &[&str], allowed: &[&str]) -> Result<&'a serde_json::Map<String, Value>, Failure> {
    let map = body.as_object().ok_or_else(bad)?;
    if map.keys().any(|k| !allowed.contains(&k.as_str())) || required.iter().any(|k| !map.contains_key(*k)) {
        return Err(bad());
    }
    Ok(map)
}

pub fn uuid(value: &Value) -> Result<String, Failure> {
    value.as_str().filter(|t| is_uuid(t)).map(str::to_lowercase).ok_or_else(bad)
}

pub fn hex64(value: &Value) -> Result<String, Failure> {
    value.as_str().filter(|t| t.len() == 64 && t.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).map(str::to_owned).ok_or_else(bad)
}

/// A 43 character URL-safe base64 secret.
pub fn verifier(value: &Value) -> Result<String, Failure> {
    value.as_str().filter(|t| t.len() == 43 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).map(str::to_owned).ok_or_else(bad)
}

fn text(value: &Value) -> bool {
    value.as_str().is_some_and(|t| !t.is_empty() && t.chars().count() <= 256 && !t.contains('\0'))
}

fn list_of(value: &Value, max: usize, each: impl Fn(&Value) -> bool) -> bool {
    value.as_array().is_some_and(|a| a.len() <= max && a.iter().all(each))
}

fn shape(value: &Value, required: &[&str], allowed: &[&str]) -> bool {
    object(value, required, allowed).is_ok()
}

fn permission(value: &Value) -> bool {
    matches!(value.as_str(), Some("granted" | "denied" | "unknown"))
}

/// The Mac's inventory of microphones, applications and permissions.
pub fn inventory(value: &Value) -> Result<(), Failure> {
    let all = ["defaultMicrophoneId", "microphones", "applications", "computerAudio", "microphonePermission", "systemAudioPermission"];
    let required = ["microphones", "applications", "computerAudio", "microphonePermission", "systemAudioPermission"];
    let map = object(value, &required, &all)?;
    let mic = |m: &Value| shape(m, &["deviceId", "sourceId", "label"], &["deviceId", "sourceId", "label"]) && ["deviceId", "sourceId", "label"].iter().all(|k| text(&m[*k]));
    let app = |a: &Value| {
        shape(a, &["appProcessTreeId", "label"], &["appProcessTreeId", "applicationId", "label"])
            && text(&a["appProcessTreeId"])
            && text(&a["label"])
            && (a.get("applicationId").is_none() || text(&a["applicationId"]))
    };
    let audio = &map["computerAudio"];
    let audio_ok = shape(audio, &["available", "excludedProcessTreeIds"], &["available", "excludedProcessTreeIds"])
        && audio["available"].is_boolean()
        && list_of(&audio["excludedProcessTreeIds"], 64, text);
    let default_ok = map.get("defaultMicrophoneId").is_none_or(|d| d.is_null() || text(d));
    if list_of(&map["microphones"], 64, mic) && list_of(&map["applications"], 128, app) && audio_ok && default_ok
        && permission(&map["microphonePermission"]) && permission(&map["systemAudioPermission"])
    {
        Ok(())
    } else {
        Err(bad())
    }
}

fn counter(value: &Value) -> bool {
    value.as_i64().is_some_and(|n| n >= 0)
}

fn observed(value: &Value) -> bool {
    object(value, &["generation", "phase"], &["generation", "phase", "errorCode"]).is_ok()
        && counter(&value["generation"])
        && matches!(value["phase"].as_str(), Some("idle" | "recording" | "recovering" | "paused" | "stopped" | "error"))
        && value.get("errorCode").is_none_or(|c| c.as_str().is_some_and(|t| (1..=80).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')))
}

fn gap(value: &Value) -> bool {
    let all = ["id", "sourceId", "epoch", "startMs", "endMs", "reason"];
    object(value, &all, &all).is_ok()
        && uuid(&value["id"]).is_ok()
        && text(&value["sourceId"])
        && value["epoch"].as_i64().is_some_and(|n| (1..=64).contains(&n))
        && counter(&value["startMs"])
        && counter(&value["endMs"])
        && matches!(
            value["reason"].as_str(),
            Some("paused" | "expired" | "buffer-full" | "source-unavailable" | "processing-failed" | "interrupted" | "discarded")
        )
}

/// `POST /capture/status`.
pub fn status(body: &Value) -> Result<crate::capture_status::Report, Failure> {
    let all = ["meetingId", "grantId", "inventory", "observed", "gaps", "finalized", "recordedDurationMs"];
    let map = object(body, &["meetingId", "grantId", "inventory", "observed"], &all)?;
    inventory(&map["inventory"])?;
    let gaps = match map.get("gaps") {
        None => vec![],
        Some(list) if list_of(list, 32, gap) => list.as_array().cloned().unwrap_or_default(),
        Some(_) => return Err(bad()),
    };
    if !observed(&map["observed"]) || map.get("finalized").is_some_and(|f| !f.is_boolean()) || map.get("recordedDurationMs").is_some_and(|d| !counter(d)) {
        return Err(bad());
    }
    Ok(crate::capture_status::Report {
        meeting_id: uuid(&map["meetingId"])?,
        grant_id: uuid(&map["grantId"])?,
        inventory: map["inventory"].clone(),
        observed: map["observed"].clone(),
        gaps,
        finalized: map.get("finalized") == Some(&Value::Bool(true)),
        recorded_duration_ms: map.get("recordedDurationMs").and_then(Value::as_i64),
    })
}

/// A control body. The browser sends `grantId`, `requestKey`, `expectedGeneration`, `command` and
/// optionally `selection`. The Mac adds `meetingId` and, for source changes, `expectedEpoch`.
pub fn control(body: &Value, native: bool) -> Result<crate::capture_service::Control, Failure> {
    let all = ["meetingId", "grantId", "requestKey", "expectedGeneration", "command", "selection", "expectedEpoch"];
    let required = ["grantId", "requestKey", "expectedGeneration", "command"];
    let map = object(body, &required, &all)?;
    let command = map["command"].as_str().ok_or_else(bad)?.to_owned();
    let changing = matches!(command.as_str(), "change-sources" | "recover-sources");
    let allowed: &[&str] = if native {
        &["record", "pause", "stop", "change-sources", "recover-sources"]
    } else {
        &["record", "pause", "stop", "revoke"]
    };
    let epoch = map.get("expectedEpoch");
    let selection = map.get("selection");
    let shaped = allowed.contains(&command.as_str())
        && map.contains_key("meetingId") == native
        && counter(&map["expectedGeneration"])
        && selection.is_none_or(|s| s["mode"].is_string() && s.is_object())
        && if changing {
            selection.is_some() && epoch.and_then(Value::as_i64).is_some_and(|n| (1..=64).contains(&n))
        } else {
            epoch.is_none() && (!native || selection.is_none())
        };
    if !shaped {
        return Err(bad());
    }
    Ok(crate::capture_service::Control {
        meeting_id: map.get("meetingId").map(uuid).transpose()?,
        grant_id: uuid(&map["grantId"])?,
        request_key: uuid(&map["requestKey"])?,
        expected_generation: map["expectedGeneration"].as_i64().unwrap_or(0),
        command,
        selection: selection.cloned(),
        expected_epoch: epoch.and_then(Value::as_i64),
    })
}

/// `POST /capture/audio`. The number checks live with the decoder.
pub fn audio(body: &Value) -> Result<(), Failure> {
    let all = ["meetingId", "grantId", "requestKey", "generation", "epoch", "sourceId", "sequence", "startMs", "endMs", "sampleRateHz", "pcmBase64"];
    let map = object(body, &all, &all)?;
    for key in ["meetingId", "grantId", "requestKey"] {
        uuid(&map[key])?;
    }
    if !text(&map["sourceId"]) || !map["pcmBase64"].as_str().is_some_and(|p| p.len() >= 4) {
        return Err(bad());
    }
    Ok(())
}
