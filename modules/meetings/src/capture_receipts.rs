//! Receipts for the Mac's control and audio requests. A receipt makes a repeated request answer
//! the same way, and an audio receipt also carries the clip's place in the recording. Rows hold
//! the clip's numbers and fingerprint, never its audio or text.
use crate::capture_audio::Clip;
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_state::retain_gap;
use crate::capture_store::{self as store, parse, stamp, values};
use chrono::{DateTime, Duration, Utc};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Host,
};
use serde_json::{json, Value};

pub const RECEIPTS: &str = "app.meeting_capture_receipts";
const MAX_RECEIPTS: usize = 4000;
const OWNER_PENDING_MAX: usize = 2;
const RATE_MAX: usize = 120;
const PENDING_WINDOW_MS: i64 = 60_000;
const MAX_ATTEMPTS: i64 = 4;

fn compare(column: &str, op: Compare, value: Value) -> Filter {
    Filter::Compare { column: column.into(), op, value }
}

fn rows<H: Host + ?Sized>(host: &H, filter: Filter, limit: u32) -> Result<Vec<Value>, Stop> {
    let mut query = Query::select(filter);
    query.limit = Some(limit);
    Ok(Client(host).query(RECEIPTS, &query)?)
}

/// The receipt's recorded numbers as JSON.
pub fn metadata(receipt: &Value) -> Value {
    receipt["metadata_json"].as_str().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null)
}

/// The stored answer, when the request already finished.
pub fn result(receipt: &Value) -> Option<Value> {
    receipt["result_json"].as_str().and_then(|t| serde_json::from_str(t).ok())
}

/// The receipt for this request, or `None`. A different fingerprint is a conflict.
pub fn receipt<H: Host + ?Sized>(host: &H, grant: &str, request_key: &str, fingerprint: &str) -> Result<Option<Value>, Stop> {
    let filter = Filter::And { filters: vec![Filter::eq("grant_id", grant), Filter::eq("request_key", request_key)] };
    let found = rows(host, filter, 1)?.into_iter().next();
    if found.as_ref().is_some_and(|r| r["fingerprint"] != json!(fingerprint)) {
        return Err(Failure::new(CaptureCode::Conflict).into());
    }
    Ok(found)
}

pub fn reserve<H: Host + ?Sized>(host: &H, grant: &str, key: &str, kind: &str, fingerprint: &str, meta: &Value, answer: Option<&Value>) -> Result<(), Stop> {
    if rows(host, Filter::eq("grant_id", grant), MAX_RECEIPTS as u32)?.len() >= MAX_RECEIPTS {
        return Err(Failure::new(CaptureCode::Limit).into());
    }
    let result = answer.map(|a| a.to_string());
    Client(host).query(
        RECEIPTS,
        &Query::insert(values(vec![
            ("grant_id", json!(grant)),
            ("request_key", json!(key)),
            ("kind", json!(kind)),
            ("fingerprint", json!(fingerprint)),
            ("metadata_json", json!(meta.to_string())),
            ("result_json", json!(result)),
        ])),
    )?;
    Ok(())
}

fn pending_since<H: Host + ?Sized>(host: &H, since: DateTime<Utc>) -> Result<Vec<Value>, Stop> {
    let filter = Filter::And {
        filters: vec![Filter::eq("kind", "audio"), compare("created_at", Compare::Gt, json!(stamp(since)))],
    };
    Ok(rows(host, filter, 1000)?.into_iter().filter(|r| r["result_json"].is_null()).collect())
}

/// Reserves a clip's place. Two clips may wait per owner, one per source, and 120 may arrive a
/// minute. Clips of a source must follow each other without overlap.
pub fn admit_audio<H: Host + ?Sized>(host: &H, grant: &str, clip: &Clip, at: DateTime<Utc>) -> Result<(), Stop> {
    host.call("kv", "lock", store::CAPTURE, json!({"kind": "limit", "key": "audio"}))?;
    let busy = || Stop::from(Failure::new(CaptureCode::Busy));
    let limited = || Stop::from(Failure::new(CaptureCode::RateLimited));
    if pending_since(host, at - Duration::milliseconds(PENDING_WINDOW_MS))?.len() >= OWNER_PENDING_MAX {
        return Err(busy());
    }
    let minute = Filter::And { filters: vec![Filter::eq("kind", "audio"), compare("created_at", Compare::Gt, json!(stamp(at - Duration::minutes(1))))] };
    if rows(host, minute.clone(), RATE_MAX as u32)?.len() >= RATE_MAX {
        return Err(limited());
    }
    let ours = rows(host, Filter::And { filters: vec![Filter::eq("grant_id", grant), Filter::eq("kind", "audio")] }, MAX_RECEIPTS as u32)?;
    let same_source = |r: &&Value| metadata(r)["sourceId"] == json!(clip.source_id);
    if ours.iter().filter(same_source).any(|r| r["result_json"].is_null()) {
        return Err(busy());
    }
    let recent = ours.iter().filter(|r| parse(&r["created_at"]).is_some_and(|t| t > at - Duration::minutes(1))).count();
    if recent >= RATE_MAX {
        return Err(limited());
    }
    let last = ours
        .iter()
        .filter(same_source)
        .map(metadata)
        .filter(|m| m["epoch"].as_i64() == Some(clip.epoch))
        .max_by_key(|m| m["sequence"].as_i64().unwrap_or(-1));
    let expected = last.as_ref().map_or(0, |m| m["sequence"].as_i64().unwrap_or(-1) + 1);
    if clip.sequence != expected || last.is_some_and(|m| clip.start_ms < m["endMs"].as_i64().unwrap_or(0)) {
        return Err(Failure::new(CaptureCode::Conflict).into());
    }
    let meta = json!({"sourceId": clip.source_id, "epoch": clip.epoch, "generation": clip.generation, "sequence": clip.sequence, "startMs": clip.start_ms, "endMs": clip.end_ms});
    reserve(host, grant, &clip.request_key, "audio", &clip.fingerprint, &meta, None)
}

/// Lets a retryable failed clip run again. `false` means it may not, because it used its four
/// attempts, is older than a minute or must wait. Busy when the owner or the source is full.
pub fn retry<H: Host + ?Sized>(host: &H, grant: &str, receipt: &Value, at: DateTime<Utc>) -> Result<bool, Stop> {
    host.call("kv", "lock", store::CAPTURE, json!({"kind": "limit", "key": "audio"}))?;
    let source = metadata(receipt)["sourceId"].clone();
    let pending = pending_since(host, at - Duration::milliseconds(PENDING_WINDOW_MS))?;
    let source_pending = pending.iter().any(|r| r["grant_id"] == json!(grant) && metadata(r)["sourceId"] == source);
    if pending.len() >= OWNER_PENDING_MAX || source_pending {
        return Err(Failure::new(CaptureCode::Busy).into());
    }
    let attempts = receipt["attempts"].as_i64().unwrap_or(1);
    let old = parse(&receipt["created_at"]).is_none_or(|t| at - t >= Duration::milliseconds(PENDING_WINDOW_MS));
    let waiting = parse(&receipt["retry_at"]).is_some_and(|t| t > at);
    if attempts >= MAX_ATTEMPTS || old || waiting || result(receipt).is_none_or(|r| r["retryable"] != json!(true)) {
        return Ok(false);
    }
    update(host, grant, receipt["request_key"].as_str().unwrap_or_default(), vec![("result_json", Value::Null), ("retry_at", Value::Null), ("attempts", json!(attempts + 1))])?;
    Ok(true)
}

fn update<H: Host + ?Sized>(host: &H, grant: &str, key: &str, fields: Vec<(&str, Value)>) -> Result<(), Stop> {
    let filter = Filter::And { filters: vec![Filter::eq("grant_id", grant), Filter::eq("request_key", key)] };
    Client(host).query(RECEIPTS, &Query::update(filter, values(fields)))?;
    Ok(())
}

/// Stores the clip's answer. A retryable failure also records when the Mac may try again.
pub fn finish<H: Host + ?Sized>(host: &H, grant: &str, answer: &Value, at: DateTime<Utc>) -> Result<(), Stop> {
    let retry_at = (answer["retryable"] == json!(true)).then(|| stamp(at + Duration::milliseconds(answer["retryAfterMs"].as_i64().unwrap_or(1000))));
    let key = answer["requestKey"].as_str().unwrap_or_default();
    update(host, grant, key, vec![("result_json", json!(answer.to_string())), ("retry_at", json!(retry_at))])
}

fn open(receipt: &Value) -> bool {
    result(receipt).is_none_or(|r| r["retryable"] == json!(true))
}

/// Clips that stayed open for over a minute become lost audio. Returns true when any did.
pub fn reconcile_expired<H: Host + ?Sized>(host: &H, grant: &str, state: &mut Value, at: DateTime<Utc>) -> Result<bool, Stop> {
    let filter = Filter::And { filters: vec![Filter::eq("grant_id", grant), Filter::eq("kind", "audio"), compare("created_at", Compare::Le, json!(stamp(at - Duration::milliseconds(PENDING_WINDOW_MS))))] };
    let mut query = Query::select(filter);
    query.order = vec![Order { column: "created_at".into(), descending: false }];
    query.limit = Some(32);
    let expired: Vec<Value> = Client(host).query(RECEIPTS, &query)?.into_iter().filter(open).collect();
    for receipt in &expired {
        let meta = metadata(receipt);
        let key = receipt["request_key"].as_str().unwrap_or_default();
        let gap = json!({"id": key, "sourceId": meta["sourceId"], "epoch": meta["epoch"], "startMs": meta["startMs"], "endMs": meta["endMs"], "reason": "interrupted"});
        let _ = retain_gap(state, gap, at);
        let failed = json!({"requestKey": key, "status": "failed", "code": CaptureCode::Interrupted.as_str(), "reason": "audio-expired", "stage": "dispatch", "retryable": false});
        finish(host, grant, &failed, at)?;
    }
    Ok(!expired.is_empty())
}

/// True when any clip of the grant has no final answer yet.
pub fn has_pending<H: Host + ?Sized>(host: &H, grant: &str) -> Result<bool, Stop> {
    let filter = Filter::And { filters: vec![Filter::eq("grant_id", grant), Filter::eq("kind", "audio")] };
    Ok(rows(host, filter, MAX_RECEIPTS as u32)?.iter().any(open))
}
