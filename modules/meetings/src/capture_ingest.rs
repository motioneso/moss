//! Writes clip text into the meeting transcript and closes the transcript at a stop. All reads
//! and writes go through the transcript store under the meeting lock.
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::store;
use crate::transcript_batch as batch;
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

/// Sources for every selected microphone and output up to the clip's epoch. An earlier closed
/// epoch ends where it closed. The clip's own epoch ends at the clip's end.
pub fn sources(state: &Value, epoch: i64, end_ms: i64, retained: &[crate::transcript::Source]) -> Vec<Value> {
    let mut out = sources_json(retained);
    for e in state["epochs"].as_array().into_iter().flatten() {
        let number = e["epoch"].as_i64().unwrap_or(0);
        if number > epoch {
            break;
        }
        let start = e["startMs"].as_i64().unwrap_or(0);
        let Some(end) = (if number < epoch { e["endMs"].as_i64() } else { Some(end_ms) }).filter(|end| *end > start) else { continue };
        let selection = &e["selection"];
        let mut chosen = vec![];
        if let Some(id) = selection["microphone"]["sourceId"].as_str() {
            chosen.push((id.to_owned(), "microphone", e["microphoneLabel"].clone()));
        }
        if selection["mode"] != "microphone-only" {
            if let Some(id) = selection["outputSourceId"].as_str() {
                chosen.push((id.to_owned(), "output", e["outputLabel"].clone()));
            }
        }
        for (id, kind, label) in chosen {
            match out.iter_mut().find(|s| s["epoch"].as_i64() == Some(number) && s["sourceId"] == json!(id)) {
                Some(existing) => existing["endMs"] = json!(existing["endMs"].as_i64().unwrap_or(0).max(end)),
                None => out.push(json!({"sourceId": id, "epoch": number, "kind": kind, "label": label, "startMs": start, "endMs": end})),
            }
        }
    }
    out
}

fn failed() -> Stop {
    Failure::new(CaptureCode::Unavailable).into()
}

/// Adds events to the meeting's transcript. Returns the new transcript revision, or `None`
/// when the store refused the batch (a stale version).
pub fn append<H: Host + ?Sized>(
    host: &H,
    meeting: &str,
    request_key: &str,
    sources: Vec<Value>,
    events: Vec<Value>,
    stop_cutoff: Option<i64>,
) -> Result<Option<i64>, Stop> {
    let Ok(Some(stored)) = store::load(host, meeting, true)? else { return Err(failed()) };
    let receipt = stored.receipt();
    let mut input = Map::new();
    input.insert("meetingId".into(), json!(meeting));
    input.insert("requestKey".into(), json!(request_key));
    input.insert("expectedVersion".into(), json!(receipt.version));
    input.insert("sources".into(), Value::Array(sources));
    input.insert("events".into(), Value::Array(events));
    input.insert("stopCutoffMs".into(), json!(stop_cutoff.or(receipt.stop_cutoff_ms)));
    let Ok((encoded, parsed)) = batch::encode(&input) else { return Ok(None) };
    let Ok(ledger) = batch::apply(stored.ledger, &stored.owner, receipt.stop_cutoff_ms, &parsed) else { return Ok(None) };
    store::save(host, &parsed, &encoded, &ledger)?;
    Ok(Some(ledger.transcript_revision))
}

/// The meeting's retained sources and the transcript cursor. `None` when there is no transcript.
pub fn head<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<Option<(store::Receipt, Vec<crate::transcript::Source>)>, Stop> {
    let Ok(stored) = store::load(host, meeting, true)? else { return Err(failed()) };
    Ok(stored.map(|s| (s.receipt(), s.ledger.map(|l| l.sources).unwrap_or_default())))
}

/// Fixes the transcript's stop cutoff once, so late clips cannot extend a stopped recording.
pub fn close<H: Host + ?Sized>(host: &H, meeting: &str, request_key: &str, cutoff: Option<i64>) -> Result<(), Stop> {
    let Some((receipt, retained)) = head(host, meeting)? else { return Ok(()) };
    if receipt.version > 0 && receipt.stop_cutoff_ms.is_none() && !retained.is_empty() {
        let list = sources_json(&retained);
        append(host, meeting, request_key, list, vec![], cutoff)?;
    }
    Ok(())
}

fn sources_json(retained: &[crate::transcript::Source]) -> Vec<Value> {
    retained.iter().map(|s| serde_json::to_value(s).unwrap_or(Value::Null)).collect()
}
