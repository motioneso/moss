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
