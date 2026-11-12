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
