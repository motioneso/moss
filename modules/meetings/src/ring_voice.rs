//! Voice request rules: who may send one, whether it dispatches on its own, and the state the
//! Chat hand-off starts in. Times are milliseconds since the epoch.
use crate::ring_source::recording_id_ok;
use serde_json::Value;

/// A voice recording older than this needs the owner's confirmation before it is sent.
pub const AUTOMATIC_MAX_AGE_MS: i64 = 15 * 60_000;
pub const AUTOMATIC_START_SLACK_MS: i64 = 1500;
pub const INVENTORY_MAX: usize = 1024;

/// Reasons a voice recording is refused, with the legacy wording.
pub const INELIGIBLE_DISABLED: &str = "Enable hold-to-talk before sending new voice recordings";
pub const INELIGIBLE_BASELINE: &str = "Recordings in the enablement inventory are not imported";
pub const INELIGIBLE_AS_MEETING: &str = "Hold recordings go to Main chat and never become meetings";

pub struct Enablement<'a> {
    pub enabled: bool,
    pub inventory: &'a [String],
}

/// `Err` carries the wording of the 409 `recording_voice_ineligible` refusal.
pub fn admit(enablement: Option<&Enablement>, recording_id: &str) -> Result<(), &'static str> {
    let Some(e) = enablement.filter(|e| e.enabled) else { return Err(INELIGIBLE_DISABLED) };
    if e.inventory.binary_search_by(|id| id.as_str().cmp(recording_id)).is_ok() {
        return Err(INELIGIBLE_BASELINE);
    }
    Ok(())
}

/// Reads and validates a version 2 enablement request, returning the sorted inventory.
pub fn parse_enablement(value: &Value) -> Option<(String, String, Vec<String>)> {
    let map = value.as_object().filter(|m| m.len() == 4)?;
    if map.get("version")? != 2 {
        return None;
    }
    let device = map.get("sourceDeviceId")?.as_str().filter(|s| crate::text::is_uuid(s))?;
    let key = map.get("requestKey")?.as_str().filter(|s| crate::text::is_uuid(s))?;
    let ids = map.get("recordingIds")?.as_array().filter(|a| a.len() <= INVENTORY_MAX)?;
    let mut list: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        list.push(id.as_str().filter(|s| recording_id_ok(s))?.to_owned());
    }
    list.sort();
    if list.windows(2).any(|w| w[0] == w[1]) {
        return None;
    }
    Some((device.to_lowercase(), key.to_lowercase(), list))
}

/// Automatic dispatch applies only to a recording made after hold-to-talk was enabled, whose
/// ring clock agrees with the capture time and does not run past the moment it was received.
pub fn automatic(captured_at: Option<i64>, enabled_at: i64, received_at: i64, ring_start: i64, ring_end: i64) -> bool {
    let Some(captured) = captured_at else { return false };
    captured > enabled_at
        && captured <= received_at
        && (captured - ring_start).abs() <= AUTOMATIC_START_SLACK_MS
        && ring_end <= received_at
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum State {
    NoSpeech,
    ReadyToSend,
    Queued,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::NoSpeech => "no-speech",
            State::ReadyToSend => "ready-to-send",
            State::Queued => "queued",
        }
    }
}

/// Chat hand-off state. A request waits for confirmation unless it is automatic and fresh.
pub fn hand_off_state(has_speech: bool, automatic: bool, captured_at: Option<i64>, now: i64) -> State {
    if !has_speech {
        return State::NoSpeech;
    }
    let age = captured_at.map_or(-1, |c| now - c);
    if !automatic || age < 0 || age > AUTOMATIC_MAX_AGE_MS {
        State::ReadyToSend
    } else {
        State::Queued
    }
}
