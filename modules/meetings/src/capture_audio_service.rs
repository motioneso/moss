//! `POST /capture/audio`. One call proves the Mac, admits the clip, sends it to the model router
//! for transcription, files the text in the owner's transcript and settles the clip's receipt.
//! Audio bytes never reach a row, a log or a job. A failure is a stored receipt, not an error.
use crate::capture_audio::{admit, base64_encode, decode, near_silent, wave, Clip, FINALIZATION_MS};
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_ingest as ingest;
use crate::capture_native as native;
use crate::capture_receipts as receipts;
use crate::capture_state::retain_gap;
use crate::capture_store::{self as store, now, parse};
use crate::preferences;
use chrono::{DateTime, Utc};
use moss_module_sdk::{Host, Response};
use serde_json::{json, Value};

const PROCESSING: &str = "meeting_capture_processing_failed";
const STAGES: &[&str] = &["configuration", "dispatch", "response", "validation"];
const REASONS: &[&str] = &[
    "configuration-unavailable",
    "route-changed",
    "provider-timeout",
    "provider-rate-limited",
    "provider-authentication",
    "provider-unavailable",
    "provider-network",
    "provider-response-invalid",
    "invalid-audio",
];

/// A failed clip's reviewed reason. Provider text never appears here.
fn failure(reason: &str, stage: &str, retryable: bool, retry_after_ms: Option<i64>) -> Value {
    let mut out = json!({"code": PROCESSING, "reason": reason, "stage": stage, "retryable": retryable});
    if let Some(ms) = retry_after_ms {
        out["retryAfterMs"] = json!(ms);
    }
    out
}

/// Provider segments cut to the clip. Starts must lie inside it. A rounded end may pass the clip
/// end by at most 100 ms and is clamped. Anything else invalidates the whole reply.
pub fn normalize(segments: &[Value], duration_ms: i64) -> Option<Vec<(i64, i64, String)>> {
    let mut characters = 0;
    let mut out = Vec::new();
    for s in segments {
        let (start, end, text) = (s["startMs"].as_i64()?, s["endMs"].as_i64()?, s["text"].as_str()?);
        characters += text.chars().count();
        if start < 0 || start >= duration_ms || end <= start || end - duration_ms > 100 || text.contains('\0') || characters > 64_000 {
            return None;
        }
        out.push((start, end.min(duration_ms), text.to_owned()));
    }
    Some(out)
}

fn pending(key: &str) -> Response {
    Response::new(200, json!({"requestKey": key, "status": "pending"}))
}

/// What the stored receipt says to a repeat of the same clip.
fn replay(prior: &Value, result: &Value, at: DateTime<Utc>) -> Response {
    let mut out = result.clone();
    out["replayed"] = json!(true);
    if let Some(retry) = parse(&prior["retry_at"]) {
        out["retryAfterMs"] = json!((retry - at).num_milliseconds().max(0));
    }
    Response::new(200, out)
}

/// `POST /capture/audio`.
pub fn audio<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response, Stop> {
    let clip = decode(body)?;
    let grant = native::prove(host, &clip.meeting_id, &clip.grant_id)?;
    let grant_id = grant["id"].as_str().unwrap_or_default().to_owned();
    let at = now(host)?;
    let mut state = store::state(&grant);
    if receipts::reconcile_expired(host, &grant_id, &mut state, at)? {
        store::save(host, &grant, &state)?;
    }
    let route = match receipts::receipt(host, &grant_id, &clip.request_key, &clip.fingerprint)? {
        Some(prior) => match receipts::result(&prior) {
            None => return Ok(pending(&clip.request_key)),
            Some(result) => {
                if result["retryable"] != json!(true) || !receipts::retry(host, &grant_id, &prior, at)? {
                    return Ok(replay(&prior, &result, at));
                }
                admit(&state, &clip, at)?["modelRoute"].clone()
            }
        },
        None => {
            let epoch = admit(&state, &clip, at)?;
            receipts::admit_audio(host, &grant_id, &clip, at)?;
            epoch["modelRoute"].clone()
        }
    };
    let reserved = route.as_str().unwrap_or_default().to_owned();
    let result = match transcribe(host, &clip, &reserved) {
        Ok(segments) => save(host, &grant, &clip, &segments, near_silent(&clip.pcm)),
        Err(failed) => Ok(Err(failed)),
    }?;
    let answer = match result {
        Ok(saved) => saved,
        Err(failed) => settle_failure(host, &grant, &clip, failed)?,
    };
    Ok(Response::new(200, answer))
}

/// Sends the clip to the router. Near silence sends nothing and yields no segments.
fn transcribe<H: Host + ?Sized>(host: &H, clip: &Clip, reserved: &str) -> Result<Vec<(i64, i64, String)>, Value> {
    if near_silent(&clip.pcm) {
        return Ok(vec![]);
    }
    let unavailable = |_| failure("unknown", "dispatch", false, None);
    let options = preferences::current(host).map_err(unavailable)?;
    let mut params = json!({"audioBase64": base64_encode(&wave(&clip.pcm, clip.sample_rate_hz)), "expectedRoute": reserved});
    if let Some(language) = options["transcriptLanguage"].as_str() {
        params["language"] = json!(language);
    }
    let terms: Vec<&str> = options["transcriptVocabulary"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if !terms.is_empty() {
        params["prompt"] = json!(terms.join(", "));
    }
    let available = host.call("transcribe", "availability", "audio", json!({})).map_err(unavailable)?;
    if available["route"].as_str() != Some(reserved) || available["available"] != json!(true) {
        return Err(failure("route-changed", "validation", false, None));
    }
    let reply = host.call("transcribe", "create", "audio", params).map_err(unavailable)?;
    if reply["ok"] != json!(true) {
        let retryable = reply["retryable"] == json!(true);
        // Only the host's closed lists pass. Anything else is stored as unknown.
        let name = |key: &str, allowed: &[&str], fallback: &str| reply[key].as_str().filter(|v| allowed.contains(v)).unwrap_or(fallback).to_owned();
        return Err(failure(
            &name("reason", REASONS, "unknown"),
            &name("stage", STAGES, "dispatch"),
            retryable,
            retryable.then_some(1000),
        ));
    }
    if reply["route"].as_str() != Some(reserved) {
        return Err(failure("route-changed", "validation", false, None));
    }
    let list = reply["segments"].as_array().cloned().unwrap_or_default();
    if list.len() > 100 {
        return Err(failure("provider-response-invalid", "validation", false, None));
    }
    normalize(&list, clip.end_ms - clip.start_ms).ok_or_else(|| failure("timestamp-or-content-invalid", "validation", false, None))
}

/// Files the clip's text. The outer error is a host fault. The inner one is a failed clip.
fn save<H: Host + ?Sized>(host: &H, grant: &Value, clip: &Clip, segments: &[(i64, i64, String)], silent: bool) -> Result<Result<Value, Value>, Stop> {
    let at = now(host)?;
    let grant_id = grant["id"].as_str().unwrap_or_default();
    let mut state = store::state(grant);
    receipts::reconcile_expired(host, grant_id, &mut state, at)?;
    let epoch = state["epochs"].as_array().into_iter().flatten().find(|e| e["epoch"].as_i64() == Some(clip.epoch) && e["generation"].as_i64() == Some(clip.generation)).cloned();
    let interrupted = || Failure::new(CaptureCode::Interrupted);
    let Some(epoch) = epoch else { return Err(interrupted().into()) };
    let past_deadline = parse(&state["finalizationDeadline"]).is_some_and(|d| at > d);
    if state["finalized"] == json!(true)
        || past_deadline
        || epoch["endMs"].as_i64().is_some_and(|end| clip.end_ms > end)
        || state["stopCutoffMs"].as_i64().is_some_and(|cut| clip.end_ms > cut)
    {
        return Err(interrupted().into());
    }
    let Some(previous) = receipts::receipt(host, grant_id, &clip.request_key, &clip.fingerprint)? else {
        return Err(native::denied_stop());
    };
    if let Some(done) = receipts::result(&previous) {
        return Ok(Ok(done));
    }
    let (receipt, retained) = ingest::head(host, &clip.meeting_id)?.ok_or_else(|| Stop::from(Failure::new(CaptureCode::Unavailable)))?;
    let sources = ingest::sources(&state, clip.epoch, clip.end_ms, &retained);
    let events: Vec<Value> = segments
        .iter()
        .enumerate()
        .map(|(n, (start, end, text))| {
            json!({"cursor": receipt.cursor + n as i64 + 1, "segment": {
                "meetingId": clip.meeting_id, "segmentId": format!("{}:{n}", clip.request_key), "sourceId": clip.source_id,
                "epoch": clip.epoch, "startMs": clip.start_ms + start, "endMs": clip.start_ms + end, "revision": 1,
                "text": text, "finality": "final", "provenance": "transcription", "speakerId": null}})
        })
        .collect();
    let Some(revision) = ingest::append(host, &clip.meeting_id, &clip.request_key, sources, events, state["stopCutoffMs"].as_i64())? else {
        return Ok(Err(failure("transcript-conflict", "persistence", true, Some(250))));
    };
    let result = json!({"requestKey": clip.request_key, "status": "saved", "transcriptRevision": revision, "replayed": false});
    state["transcriptRevision"] = json!(revision);
    receipts::finish(host, grant_id, &result, at)?;
    // A silent clip must not hide another clip's warning that is still open.
    if !silent || !receipts::has_pending(host, grant_id)? {
        state["processing"] = json!({"status": "ready"});
    }
    store::save(host, grant, &state)?;
    Ok(Ok(result))
}

/// Stores a failed receipt. A retryable failure stays retryable for four attempts in a minute.
fn settle_failure<H: Host + ?Sized>(host: &H, grant: &Value, clip: &Clip, failed: Value) -> Result<Value, Stop> {
    let at = now(host)?;
    let grant_id = grant["id"].as_str().unwrap_or_default();
    let mut state = store::state(grant);
    receipts::reconcile_expired(host, grant_id, &mut state, at)?;
    let previous = receipts::receipt(host, grant_id, &clip.request_key, &clip.fingerprint)?;
    if let Some(done) = previous.as_ref().and_then(receipts::result) {
        return Ok(done);
    }
    let attempts = previous.as_ref().and_then(|p| p["attempts"].as_i64()).unwrap_or(1);
    let age = previous.as_ref().and_then(|p| parse(&p["created_at"])).map_or(i64::MAX, |t| (at - t).num_milliseconds());
    let retryable = failed["retryable"] == json!(true) && attempts < 4 && age < FINALIZATION_MS;
    let mut answer = json!({"requestKey": clip.request_key, "status": "failed"});
    for key in ["code", "reason", "stage", "retryAfterMs"] {
        if !failed[key].is_null() {
            answer[key] = failed[key].clone();
        }
    }
    answer["retryable"] = json!(retryable);
    if !retryable {
        answer.as_object_mut().map(|m| m.remove("retryAfterMs"));
    }
    if !near_silent(&clip.pcm) {
        let mut processing = json!({"status": "delayed", "reason": failed["reason"], "stage": failed["stage"], "retryable": retryable});
        if retryable {
            processing["retryAfterMs"] = json!(failed["retryAfterMs"].as_i64().unwrap_or(1000));
        }
        state["processing"] = processing;
    }
    if !retryable {
        let gap = json!({"id": clip.request_key, "sourceId": clip.source_id, "epoch": clip.epoch, "startMs": clip.start_ms, "endMs": clip.end_ms, "reason": "processing-failed"});
        let _ = retain_gap(&mut state, gap, at);
    }
    store::save(host, grant, &state)?;
    receipts::finish(host, grant_id, &answer, at)?;
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: i64, end: i64, text: &str) -> Value {
        json!({"startMs": start, "endMs": end, "text": text})
    }

    #[test]
    fn clamps_a_rounded_end_and_keeps_order() {
        let out = normalize(&[seg(0, 500, "a"), seg(9000, 10_080, "b")], 10_000).unwrap();
        assert_eq!(out[1], (9000, 10_000, "b".to_owned()));
    }

    #[test]
    fn refuses_bad_timing_and_content() {
        for list in [vec![seg(10_000, 10_050, "x")], vec![seg(5, 5, "x")], vec![seg(0, 10_101, "x")], vec![seg(-1, 4, "x")], vec![seg(0, 4, "a\0")]] {
            assert!(normalize(&list, 10_000).is_none());
        }
    }
}
