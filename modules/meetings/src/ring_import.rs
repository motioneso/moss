//! The `meetings.recording-import` job. A transcribe job turns one 20 second window of the
//! uploaded audio into text through the model router, then queues the next window. A finished
//! meeting import gets its transcript and a summary request. A finished voice import goes to Chat.
//! Job payloads carry only ids, a kind and a window number. Text stays in the transcript store
//! and the import row.
use crate::ring_errors::RingCode;
use crate::ring_upload::{now, stamp, FILES, IMPORTS, IMPORT_QUEUE};
use crate::ring_voice::{hand_off_state, State};
use crate::stop_summary;
use crate::store;
use crate::transcript_batch as batch;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// Window length in milliseconds. Its encoded audio fits one module message.
pub const WINDOW_MS: u64 = 20_000;
const VOICE_TEXT_MAX: usize = 32_768;
const SOURCE: &str = "ring-recording";

fn done(status: &str) -> Result<String> {
    Ok(json!({"status": status}).to_string())
}

fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

fn row<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq("id", id));
    query.limit = Some(1);
    Ok(Client(host).query(IMPORTS, &query)?.into_iter().next())
}

fn update<H: Host + ?Sized>(host: &H, id: &str, fields: Vec<(&str, Value)>) -> Result<()> {
    Client(host).query(IMPORTS, &Query::update(Filter::eq("id", id), values(fields)))?;
    Ok(())
}

fn fail<H: Host + ?Sized>(host: &H, row: &Value, code: RingCode, retryable: bool) -> Result<String> {
    let id = row["id"].as_str().unwrap_or_default();
    let attempts = row["attempts"].as_i64().unwrap_or(0) + 1;
    update(
        host,
        id,
        vec![("state", json!("failed")), ("code", json!(code.as_str())), ("retryable", json!(retryable)), ("attempts", json!(attempts))],
    )?;
    done("failed")
}

fn enqueue<H: Host + ?Sized>(host: &H, id: &str, kind: &str, window: Option<u64>, at: &str) -> Result<()> {
    let mut params = json!({"import-id": id, "kind": kind});
    if let Some(window) = window {
        params["window"] = json!(window);
    }
    host.call(
        "jobs",
        "enqueue-options",
        IMPORT_QUEUE,
        json!({
            "params": params,
            "idempotencyKey": host.call("context", "uuid", "new", json!({}))?["id"],
            "availableAt": at,
        }),
    )?;
    Ok(())
}

/// Runs one job. `parameters` holds only `import-id`, `kind` and `window`.
pub fn run<H: Host + ?Sized>(host: &H, parameters: &Value) -> Result<String> {
    let Some(id) = parameters["import-id"].as_str().filter(|id| crate::text::is_uuid(id)) else {
        return Err(moss_module_sdk::Error::new("Invalid job"));
    };
    let id = id.to_lowercase();
    let Some(row) = row(host, &id)? else { return done("gone") };
    match parameters["kind"].as_str() {
        Some("abandoned") => abandoned(host, &row),
        Some("transcribe") => transcribe(host, &row, parameters["window"].as_u64().unwrap_or(0)),
        _ => Err(moss_module_sdk::Error::new("Invalid job")),
    }
}

/// An upload nobody finished is deleted with its files and its empty meeting.
fn abandoned<H: Host + ?Sized>(host: &H, row: &Value) -> Result<String> {
    if row["ready"] == json!(true) {
        return done("kept");
    }
    let id = row["id"].as_str().unwrap_or_default();
    host.call("kv", "purge", FILES, json!({"importId": id}))?;
    let client = Client(host);
    client.query("app.meeting_recording_chunks", &Query::delete(Filter::eq("import_id", id)))?;
    client.query(IMPORTS, &Query::delete(Filter::eq("id", id)))?;
    if let Some(meeting) = row["meeting_id"].as_str() {
        client.query("app.meeting_records", &Query::delete(Filter::eq("id", meeting)))?;
    }
    done("purged")
}

fn transcribe<H: Host + ?Sized>(host: &H, row: &Value, window: u64) -> Result<String> {
    let id = row["id"].as_str().unwrap_or_default();
    if row["ready"] != json!(true) {
        return done("skipped");
    }
    if matches!(row["state"].as_str(), Some("complete" | "failed")) {
        return done("finished");
    }
    let total = row["metadata_json"]["durationMs"].as_u64().unwrap_or(0);
    let start = window * WINDOW_MS;
    // A repeated job for a window already done moves on without transcribing twice.
    if start != row["next_window_ms"].as_u64().unwrap_or(0) {
        return done("skipped");
    }
    if start >= total {
        return finish(host, row);
    }
    let availability = host.call("transcribe", "availability", "audio", json!({}))?;
    let Some(route) = availability["route"].as_str().filter(|_| availability["available"] == json!(true)) else {
        return fail(host, row, RingCode::TranscriptionUnavailable, true);
    };
    let cut = host.call(
        "kv",
        "window",
        FILES,
        json!({"importId": id, "startMs": start, "lengthMs": WINDOW_MS, "totalMs": total}),
    )?;
    let reply = host.call("transcribe", "create", "audio", json!({"audioBase64": cut["audio"], "expectedRoute": route}))?;
    if reply["ok"] != json!(true) {
        let retryable = reply["retryable"] == json!(true);
        let code = if reply["reason"] == json!("configuration-unavailable") {
            RingCode::TranscriptionUnavailable
        } else {
            RingCode::TranscriptionFailed
        };
        return fail(host, row, code, retryable);
    }
    let end = cut["endMs"].as_u64().unwrap_or(total);
    let segments = reply["segments"].as_array().cloned().unwrap_or_default();
    let last = end >= total;
    if let Some(meeting) = row["meeting_id"].as_str() {
        if append(host, meeting, id, window, start, end, last.then_some(total), &segments)?.is_none() {
            return fail(host, row, RingCode::TranscriptionFailed, false);
        }
    } else {
        let mut text = row["voice_transcript"].as_str().unwrap_or_default().to_owned();
        for segment in &segments {
            let piece = segment["text"].as_str().unwrap_or_default().trim();
            if !piece.is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(piece);
            }
        }
        text.truncate(text.char_indices().map(|(i, _)| i).take_while(|i| *i <= VOICE_TEXT_MAX).last().unwrap_or(0));
        update(host, id, vec![("voice_transcript", json!(text))])?;
    }
    update(host, id, vec![("state", json!("transcribing")), ("next_window_ms", json!(end))])?;
    if last {
        let fresh = row_after(host, id)?;
        return finish(host, &fresh);
    }
    enqueue(host, id, "transcribe", Some(window + 1), &stamp(now(host)?))?;
    done("window")
}

fn row_after<H: Host + ?Sized>(host: &H, id: &str) -> Result<Value> {
    row(host, id)?.ok_or_else(|| moss_module_sdk::Error::new("Import row vanished"))
}

/// Adds one window's segments to the meeting's transcript. `None` means the store refused it.
#[allow(clippy::too_many_arguments)]
fn append<H: Host + ?Sized>(
    host: &H,
    meeting: &str,
    import: &str,
    window: u64,
    start: u64,
    end: u64,
    cutoff: Option<u64>,
    segments: &[Value],
) -> Result<Option<i64>> {
    let Ok(Some(state)) = store::load(host, meeting, true)? else { return Ok(None) };
    let version = state.receipt().version;
    let cursor = state.ledger.as_ref().map_or(0, |ledger| ledger.cursor);
    let mut events = Vec::new();
    for (n, segment) in segments.iter().enumerate().take(100) {
        let text = segment["text"].as_str().unwrap_or_default().trim();
        if text.is_empty() {
            continue;
        }
        let from = start + segment["startMs"].as_u64().unwrap_or(0).min(end - start);
        let to = (start + segment["endMs"].as_u64().unwrap_or(0)).clamp(from, end);
        events.push(json!({"cursor": cursor + events.len() as i64 + 1, "segment": {
            "meetingId": meeting, "segmentId": format!("ring-{window}-{n}"), "sourceId": SOURCE, "epoch": 1,
            "startMs": from, "endMs": to, "revision": 1, "text": text, "finality": "final",
            "provenance": "transcription", "speakerId": null}}));
    }
    if events.is_empty() && cutoff.is_none() {
        return Ok(Some(state.receipt().transcript_revision));
    }
    let mut input = Map::new();
    input.insert("meetingId".into(), json!(meeting));
    input.insert("requestKey".into(), json!(format!("{import}:{window}")));
    input.insert("expectedVersion".into(), json!(version));
    input.insert(
        "sources".into(),
        json!([{"sourceId": SOURCE, "epoch": 1, "kind": "recording", "label": "Ring recording", "startMs": 0, "endMs": end}]),
    );
    input.insert("events".into(), Value::Array(events));
    input.insert("stopCutoffMs".into(), json!(cutoff));
    let Ok((encoded, parsed)) = batch::encode(&input) else { return Ok(None) };
    let Ok(ledger) = batch::apply(state.ledger, &state.owner, None, &parsed) else { return Ok(None) };
    store::save(host, &parsed, &encoded, &ledger)?;
    Ok(Some(ledger.transcript_revision))
}

/// All windows are done. A meeting asks for its summary. A voice request goes to Chat.
fn finish<H: Host + ?Sized>(host: &H, row: &Value) -> Result<String> {
    let id = row["id"].as_str().unwrap_or_default();
    if let Some(meeting) = row["meeting_id"].as_str() {
        let revision = match store::load(host, meeting, false)? {
            Ok(Some(state)) => state.receipt().transcript_revision,
            _ => return fail(host, row, RingCode::TranscriptionFailed, false),
        };
        update(host, id, vec![("state", json!("complete")), ("transcript_version", json!(revision))])?;
        if revision > 0 {
            stop_summary::schedule_manual(host, meeting, revision, "general")?;
        }
        return done("complete");
    }
    let transcript = row["voice_transcript"].as_str().unwrap_or_default();
    let current = now(host)?;
    let captured = row["voice_captured_at"].as_str().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at| at.timestamp_millis());
    let state = hand_off_state(!transcript.trim().is_empty(), row["voice_automatic"] == json!(true), captured, current.timestamp_millis());
    let reply = host.call(
        "kv",
        "hand-off",
        "meetings.chat-voice",
        json!({
            "sourceDeviceId": row["source_device_id"], "recordingId": row["recording_id"],
            "fingerprint": row["fingerprint"], "transcript": if state == State::NoSpeech { "" } else { transcript },
            "capturedAt": row["voice_captured_at"], "automatic": row["voice_automatic"], "state": state.as_str(),
        }),
    )?;
    let request = reply["requestId"].as_str().ok_or_else(|| moss_module_sdk::Error::new("Chat gave no request id"))?;
    update(host, id, vec![("state", json!("complete")), ("voice_request_id", json!(request))])?;
    done("complete")
}
