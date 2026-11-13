//! What a person may ask a Mac to record. The selection must match what the Mac reported in its
//! inventory. Values stay as JSON so the stored state keeps the exact shape the Mac app reads.
use crate::capture_errors::{CaptureCode, Failure};
use serde_json::{json, Value};

const MAX_EPOCHS: usize = 64;
pub const LEASE_MS: i64 = 30_000;

fn invalid() -> Failure {
    Failure::new(CaptureCode::InvalidInput)
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn sorted_strings(value: &Value) -> Vec<String> {
    let mut out: Vec<String> = value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    out.sort();
    out
}

/// Refuses a selection the inventory does not support.
pub fn validate(selection: &Value, inventory: &Value) -> Result<(), Failure> {
    if !selection.is_object() {
        return Err(invalid());
    }
    let mode = selection["mode"].as_str().unwrap_or_default();
    if selection["microphone"].is_object() {
        let mic = &selection["microphone"];
        let matches: Vec<&Value> = list(inventory, "microphones")
            .iter()
            .filter(|m| m["deviceId"] == mic["deviceId"] || m["sourceId"] == mic["sourceId"])
            .collect();
        if inventory["microphonePermission"] == "denied"
            || matches.len() != 1
            || matches[0]["deviceId"] != mic["deviceId"]
            || matches[0]["sourceId"] != mic["sourceId"]
        {
            return Err(invalid());
        }
    } else if mode != "computer-audio" || !selection["microphone"].is_null() {
        return Err(invalid());
    }
    if mode == "microphone-only" {
        return Ok(());
    }
    let output = selection["outputSourceId"].as_str().unwrap_or_default();
    if output.trim().is_empty()
        || output.len() > 256
        || output.contains('\0')
        || list(inventory, "microphones").iter().any(|m| m["sourceId"].as_str() == Some(output))
        || inventory["systemAudioPermission"] == "denied"
    {
        return Err(invalid());
    }
    match mode {
        "selected-app" => {
            let matches: Vec<&Value> = list(inventory, "applications")
                .iter()
                .filter(|a| a["appProcessTreeId"] == selection["appProcessTreeId"])
                .collect();
            let wrong_app = !selection["applicationId"].is_null() && matches.len() == 1 && matches[0]["applicationId"] != selection["applicationId"];
            if matches.len() != 1 || wrong_app {
                return Err(invalid());
            }
        }
        "computer-audio" => {
            let excluded = sorted_strings(&selection["scope"]["excludedProcessTreeIds"]);
            if inventory["computerAudio"]["available"] != json!(true)
                || selection["scope"]["kind"] != "process-exclusion"
                || excluded.is_empty()
                || excluded != sorted_strings(&inventory["computerAudio"]["excludedProcessTreeIds"])
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

fn label(inventory: &Value, selection: &Value) -> (Value, Value) {
    let mic = selection["microphone"].as_object().and_then(|mic| {
        list(inventory, "microphones")
            .iter()
            .find(|m| m["deviceId"] == mic["deviceId"] && m["sourceId"] == mic["sourceId"])
            .map(|m| m["label"].clone())
    });
    let output = match selection["mode"].as_str() {
        Some("selected-app") => list(inventory, "applications")
            .iter()
            .find(|a| a["appProcessTreeId"] == selection["appProcessTreeId"])
            .map(|a| a["label"].clone()),
        Some("computer-audio") => Some(json!("Computer audio")),
        _ => None,
    };
    (mic.unwrap_or(Value::Null), output.unwrap_or(Value::Null))
}

/// The `record` command: validates the selection, opens a new epoch and bumps the generation.
/// `state` is the stored grant state. `now_ms` is the offset from the state's origin.
pub fn record(state: &mut Value, selection: &Value, expected_generation: i64, at_ms: i64, since_seen_ms: Option<i64>, model_route: &str) -> Result<(), Failure> {
    if state["generation"].as_i64() != Some(expected_generation) {
        return Err(Failure::new(CaptureCode::Conflict));
    }
    match state["desired"].as_str() {
        Some("revoked") => return Err(Failure::new(CaptureCode::Unavailable)),
        Some("idle") | Some("paused") => {}
        _ => return Err(invalid()),
    }
    if state["gapLimitReached"] == json!(true) {
        return Err(Failure::new(CaptureCode::Limit));
    }
    if !state["inventory"].is_object() || !selection.is_object() {
        return Err(invalid());
    }
    if since_seen_ms.map_or(true, |ms| ms > LEASE_MS) {
        return Err(Failure::new(CaptureCode::Interrupted));
    }
    let epochs = state["epochs"].as_array().map_or(0, Vec::len);
    if epochs >= MAX_EPOCHS {
        return Err(Failure::new(CaptureCode::Limit));
    }
    validate(selection, &state["inventory"])?;
    let (microphone_label, output_label) = label(&state["inventory"], selection);
    let generation = expected_generation + 1;
    let epoch = json!({
        "modelRoute": model_route,
        "epoch": epochs + 1,
        "generation": generation,
        "startMs": at_ms,
        "endMs": null,
        "selection": selection,
        "microphoneLabel": microphone_label,
        "outputLabel": output_label,
    });
    state["epochs"].as_array_mut().ok_or_else(invalid)?.push(epoch);
    state["desired"] = json!("recording");
    state["generation"] = json!(generation);
    Ok(())
}

fn unavailable() -> Failure {
    Failure::new(CaptureCode::SourceUnavailable)
}

/// The remembered source for a start, or the one the inventory allows. It never saves a choice
/// and never widens a remembered exact source.
pub fn resolve_source(preferences: &Value, device_id: &str, inventory: &Value) -> Result<Value, Failure> {
    let remembered = &preferences["rememberedSource"];
    if remembered.is_object() && remembered["deviceId"].as_str() != Some(device_id) {
        return Err(unavailable());
    }
    let mode = preferences["defaultCaptureMode"]
        .as_str()
        .or_else(|| remembered["mode"].as_str())
        .unwrap_or("computer-audio");
    if remembered.is_object() {
        let mut source = remembered.clone();
        source["mode"] = json!(mode);
        return Ok(source);
    }
    let mics = list(inventory, "microphones");
    let defaults: Vec<&Value> = match inventory["defaultMicrophoneId"].as_str() {
        None => mics.iter().collect(),
        Some(id) => mics.iter().filter(|m| m["deviceId"].as_str() == Some(id)).collect(),
    };
    if defaults.len() != 1 || mode == "selected-app" {
        return Err(unavailable());
    }
    Ok(json!({"deviceId": device_id, "microphoneId": defaults[0]["deviceId"], "mode": mode}))
}

/// The selection a saved source stands for, checked against the inventory.
pub fn saved_selection(source: &Value, inventory: &Value) -> Result<Value, Failure> {
    let mics: Vec<&Value> = list(inventory, "microphones").iter().filter(|m| m["deviceId"] == source["microphoneId"]).collect();
    let [mic] = mics[..] else { return Err(unavailable()) };
    let microphone = json!({"deviceId": mic["deviceId"], "sourceId": mic["sourceId"]});
    let selection = match source["mode"].as_str() {
        Some("microphone-only") => json!({"mode": "microphone-only", "microphone": microphone}),
        Some("computer-audio") => json!({"mode": "computer-audio", "microphone": microphone, "outputSourceId": "output",
            "scope": {"kind": "process-exclusion", "excludedProcessTreeIds": inventory["computerAudio"]["excludedProcessTreeIds"]}}),
        _ => {
            let apps: Vec<&Value> = list(inventory, "applications").iter().filter(|a| a["applicationId"] == source["applicationId"]).collect();
            let [app] = apps[..] else { return Err(unavailable()) };
            json!({"mode": source["mode"], "microphone": microphone, "outputSourceId": "output",
                "appProcessTreeId": app["appProcessTreeId"], "applicationId": source["applicationId"]})
        }
    };
    validate(&selection, inventory).map_err(|_| unavailable())?;
    Ok(selection)
}
