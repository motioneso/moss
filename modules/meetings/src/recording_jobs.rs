//! Background work after a recording is read. The notice job asks the owner to check a
//! low-confidence side in chat. The memory job proposes one fact per idea through Memory's public
//! API. Payloads carry only the meeting id, and meeting text never reaches a log or a result.
use crate::outputs;
use crate::recording::Recording;
use crate::recording_reading::{notice_text, side_review_version, IdeaGroup};
use crate::records::Records;
use moss_module_sdk::{Client, Host, Result};
use serde_json::{json, Value};

const MAX_FACT_BYTES: usize = 2048;
const MAX_VERSION: i64 = 2_147_483_645;

fn done(status: &str) -> String {
    json!({"status": status}).to_string()
}

/// Posts the side notice. Chat refusing makes the job fail, so the queue retries it.
pub fn notice<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<String> {
    let Some(row) = Recording::new(host).metadata(meeting)? else { return Ok(done("gone")) };
    let Some(record) = Records::new(host).row(meeting)? else { return Ok(done("gone")) };
    let (Some(version), Some(side), Some(confidence)) =
        (row["output_version"].as_i64(), row["side"].as_str(), row["confidence"].as_f64())
    else {
        return Ok(done("skipped"));
    };
    let reason = row["reason"].as_str();
    let Some(source_key) = side_review_version(version, side, confidence, reason.unwrap_or_default()) else {
        return Ok(done("skipped"));
    };
    let title = record["title"].as_str().unwrap_or_default();
    host.call(
        "kv",
        "post",
        "meetings.chat-notice",
        json!({"text": notice_text(title, side, reason, meeting), "sourceKey": source_key, "meetingId": meeting}),
    )?;
    Ok(done("posted"))
}

/// Cuts text to the byte limit on a character boundary.
fn cut(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Why a fact was not stored. A retry can help only when Memory was unreachable or failed.
struct Refused {
    why: String,
    retry: bool,
}

/// The reply's value, or Memory's own refusal wording (never meeting text).
fn answer(reply: Result<Value>) -> std::result::Result<Value, Refused> {
    let reply = reply.map_err(|e| Refused { why: e.to_string(), retry: true })?;
    if let Some(e) = reply.get("error") {
        let retry = e["statusCode"].as_i64().is_none_or(|c| c >= 500);
        return Err(Refused { why: e.to_string().chars().take(160).collect(), retry });
    }
    Ok(reply.get("ok").cloned().unwrap_or(reply))
}

/// Proposes and applies one fact. Memory decides whether the recording still counts.
fn remember<H: Host + ?Sized>(host: &H, meeting: &str, version: i64, item: &str, text: &str) -> std::result::Result<(), Refused> {
    let client = Client(host);
    let input = json!({"kind": "apply", "requestId": format!("{meeting}:{version}:{item}"),
        "source": {"sourceModuleId": "meetings", "sourceId": meeting, "sourceVersion": version, "itemKey": item},
        "text": text, "expectedRevision": null, "expectedFactRevision": null});
    let prepared = answer(client.api("memory", "recordingMemory", json!({"action": "prepare", "input": input})))?;
    let id = prepared["proposal"]["id"].as_str().ok_or(Refused { why: "No proposal id".into(), retry: false })?;
    answer(client.api("memory", "recordingMemory", json!({"action": "apply", "proposalId": id}))).map(|_| ())
}

/// Turns the newest reading's ideas into memory facts.
pub fn memory<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<String> {
    let Some(row) = Recording::new(host).metadata(meeting)? else { return Ok(done("gone")) };
    let version = row["output_version"].as_i64().filter(|v| (1..=MAX_VERSION).contains(v));
    let Some(version) = version else { return Ok(done("skipped")) };
    let Some(head) = outputs::head(host, meeting)? else { return Ok(done("skipped")) };
    let groups: Vec<IdeaGroup> =
        serde_json::from_value(head["content"]["recording"]["ideaGroups"].clone()).unwrap_or_default();
    let (mut applied, mut skipped, mut why) = (0, 0, String::new());
    let mut retry = false;
    for (g, group) in groups.iter().enumerate() {
        for (i, idea) in group.ideas.iter().enumerate() {
            let text = format!("{}: {}", group.title, idea);
            let item = format!("g{}-i{}", g + 1, i + 1);
            match remember(host, meeting, version, &item, cut(&text, MAX_FACT_BYTES)) {
                Ok(()) => applied += 1,
                Err(e) => {
                    skipped += 1;
                    retry |= e.retry;
                    why = e.why;
                }
            }
        }
    }
    // Memory was unreachable or failed. Each idea has a fixed key, so the retry repeats nothing.
    if retry {
        return Err(moss_module_sdk::Error::new("Memory could not store every idea yet"));
    }
    Ok(json!({"status": "done", "applied": applied, "skipped": skipped, "why": why}).to_string())
}
