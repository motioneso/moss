//! What Chat reads to answer a question about one meeting, and the call Meetings makes to
//! Chat so a deleted meeting leaves no chat threads behind. Both are bounded and owner-only,
//! because every read goes through the host as the signed-in person.

use moss_module_sdk::{Client, Host, Result};
use serde_json::{json, Value};

use crate::records::Records;
use crate::transcript;
use crate::transcript_routes::open;

/// The most transcript Chat is given for one question.
pub const MAX_SEGMENTS: i64 = 8;
pub const MAX_CHARACTERS: i64 = 12_000;

fn meeting_id(parameters: &Value) -> Option<String> {
    let id = parameters["meetingId"].as_str()?;
    (!id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| id.to_lowercase())
}

/// True when the meeting exists and belongs to the signed-in person.
pub fn available<H: Host + ?Sized>(host: &H, parameters: &Value) -> Result<Value> {
    let Some(id) = meeting_id(parameters) else { return Ok(json!({"available": false})) };
    Ok(json!({"available": Records::new(host).row(&id)?.is_some()}))
}

/// The transcript Chat may quote, plus the personal notes and their revision. A meeting with no
/// transcript yet answers with an empty snapshot. A meeting that is not visible answers null.
pub fn snapshot<H: Host + ?Sized>(host: &H, parameters: &Value) -> Result<Value> {
    let Some(id) = meeting_id(parameters) else { return Ok(json!({"snapshot": null})) };
    let Some(row) = Records::new(host).row(&id)? else { return Ok(json!({"snapshot": null})) };
    let record = crate::records::Snapshot::from_row(&row)?;
    let (owner, body) = match open(host, &id)? {
        Ok((state, ledger)) => {
            let bound = state
                .receipt()
                .stop_cutoff_ms
                .unwrap_or_else(|| ledger.sources.iter().map(|s| s.end_ms).max().unwrap_or(0));
            let revision = ledger.transcript_revision;
            match transcript::snapshot(&ledger, revision, bound, MAX_SEGMENTS, MAX_CHARACTERS) {
                Ok(s) => (
                    ledger.owner_user_id.clone(),
                    json!({
                        "transcriptRevision": revision, "cursor": s.cursor, "cutoffMs": bound,
                        "segments": s.segments, "throughMs": s.through_ms,
                        "omittedSegments": s.omitted, "containsProvisional": s.contains_provisional}),
                ),
                Err(_) => (ledger.owner_user_id.clone(), empty()),
            }
        }
        Err(_) => (String::new(), empty()),
    };
    let mut out = body;
    out["meetingId"] = json!(id);
    if !owner.is_empty() {
        out["ownerUserId"] = json!(owner);
    }
    out["maxSegments"] = json!(MAX_SEGMENTS);
    out["maxCharacters"] = json!(MAX_CHARACTERS);
    out["personalNotes"] = json!(record.notes);
    out["notesRevision"] = json!(record.revision);
    Ok(json!({"snapshot": out}))
}

fn empty() -> Value {
    json!({"transcriptRevision": 0, "cursor": 0, "cutoffMs": 0, "segments": [], "throughMs": null,
        "omittedSegments": 0, "containsProvisional": false})
}

/// The exact text a citation points at, or null when the meeting, revision or range is not there.
pub fn evidence<H: Host + ?Sized>(host: &H, parameters: &Value) -> Result<Value> {
    let Some(id) = meeting_id(parameters) else { return Ok(json!({"evidence": null})) };
    let Ok((_, ledger)) = open(host, &id)? else { return Ok(json!({"evidence": null})) };
    let number = |key: &str| parameters[key].as_i64().unwrap_or(0);
    let found = transcript::evidence(
        &ledger,
        parameters["segmentId"].as_str().unwrap_or_default(),
        number("segmentRevision"),
        number("startCharacter"),
        number("endCharacter"),
    );
    Ok(json!({"evidence": found.map(|(segment, excerpt)| json!({"segment": segment, "excerpt": excerpt}))}))
}

/// Asks Chat to remove the meeting's threads before the record goes. The host answers every
/// module-call failure with one fixed message, so a missing Chat and a Chat that refuses look the
/// same. The delete goes ahead either way, because Chat is optional and must not block deletion.
pub fn delete_threads<H: Host + ?Sized>(host: &H, id: &str) -> Result<()> {
    let _ = Client(host).api("chat", "deleteMeetingChatThreads", json!({"meetingId": id}));
    Ok(())
}
