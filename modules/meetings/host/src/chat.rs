//! The chat message that asks an owner to check a low-confidence side. Main's chat is not
//! ported yet, so the default refuses and the job retries until a chat is connected.
use anyhow::{bail, ensure, Result};
use serde_json::Value;
use uuid::Uuid;

pub const NOTICE: &str = "meetings.chat-notice";
const MAX_TEXT_BYTES: usize = 4096;

/// A chat the notice can be posted to. `source_key` names one reading, so a repeat post of the
/// same reading must not add a second message.
pub trait MainChat: Send + Sync {
    fn post(&self, owner: Uuid, text: &str, source_key: &str) -> Result<()>;
}

/// Used until Main's chat is ported. Nothing is posted and the caller is told so.
pub struct NoMainChat;
impl MainChat for NoMainChat {
    fn post(&self, _: Uuid, _: &str, _: &str) -> Result<()> {
        bail!("Chat awaits Main")
    }
}

/// Checks the request shape and returns the text and key.
pub fn notice(parameters: &Value) -> Result<(&str, &str)> {
    let fields = parameters.as_object().filter(|m| m.keys().all(|k| matches!(k.as_str(), "text" | "sourceKey" | "meetingId")));
    let fields = fields.ok_or_else(|| anyhow::anyhow!("Invalid chat notice"))?;
    let text = fields.get("text").and_then(Value::as_str).unwrap_or_default();
    let key = fields.get("sourceKey").and_then(Value::as_str).unwrap_or_default();
    ensure!(!text.is_empty() && text.len() <= MAX_TEXT_BYTES && !text.contains('\0'), "Invalid chat notice");
    ensure!(!key.is_empty() && key.len() <= 128, "Invalid chat notice");
    Ok((text, key))
}

pub const VOICE: &str = "meetings.chat-voice";

/// A finished voice recording, ready for Chat. The shape is a guess made before Chat is
/// ported, and Chat may ask for a different one. `state` is `queued`, `ready-to-send` or `no-speech`.
pub struct VoiceRequest<'a> {
    pub source_device_id: &'a str,
    pub recording_id: &'a str,
    pub fingerprint: &'a str,
    pub transcript: &'a str,
    pub captured_at: Option<&'a str>,
    pub automatic: bool,
    pub state: &'a str,
}

/// The Chat side of the voice hand-off. A repeat of the same device and recording must return
/// the same request id.
pub trait VoiceChat: Send + Sync {
    fn hand_off(&self, owner: Uuid, request: &VoiceRequest) -> Result<String>;
}

/// Used until Chat is ported. The job keeps the transcript and retries.
pub struct NoVoiceChat;
impl VoiceChat for NoVoiceChat {
    fn hand_off(&self, _: Uuid, _: &VoiceRequest) -> Result<String> {
        bail!("Chat awaits Main")
    }
}

/// Checks the request shape and returns the owned parts the trait needs.
pub fn voice(parameters: &Value) -> Result<VoiceRequest<'_>> {
    let map = parameters.as_object().filter(|m| {
        m.len() == 7
            && ["sourceDeviceId", "recordingId", "fingerprint", "transcript", "capturedAt", "automatic", "state"]
                .iter()
                .all(|k| m.contains_key(*k))
    });
    let map = map.ok_or_else(|| anyhow::anyhow!("Invalid voice request"))?;
    let text = |key: &str| map[key].as_str().ok_or_else(|| anyhow::anyhow!("Invalid voice request"));
    let transcript = text("transcript")?;
    ensure!(transcript.len() <= 32_768 && !transcript.contains('\0'), "Invalid voice request");
    let state = text("state")?;
    ensure!(["queued", "ready-to-send", "no-speech"].contains(&state), "Invalid voice request");
    Ok(VoiceRequest {
        source_device_id: text("sourceDeviceId")?,
        recording_id: text("recordingId")?,
        fingerprint: text("fingerprint")?,
        transcript,
        captured_at: map["capturedAt"].as_str(),
        automatic: map["automatic"].as_bool().ok_or_else(|| anyhow::anyhow!("Invalid voice request"))?,
        state,
    })
}
