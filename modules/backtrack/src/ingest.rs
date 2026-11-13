//! The Mac upload. A Mac sends redacted screen text about once a minute. Nothing here logs,
//! returns or queues segment text, and every refusal carries a fixed message.
use crate::clock::{parse, write};
use crate::codes::Code;
use crate::redact::redact;
use crate::store::{call, lock, now};
use chrono::Duration;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_SKEW: i64 = 60 * 60 * 1000;
const MAX_AGE: i64 = 26 * 60 * 60 * 1000;
const MAX_SEGMENTS: usize = 200;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Segment {
    started_at: String,
    ended_at: String,
    app_name: String,
    bundle_id: String,
    window_title: String,
    address: Option<String>,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Upload {
    sent_at: String,
    segments: Vec<Segment>,
}

fn chars(text: &str, min: usize, max: usize) -> bool {
    let n = text.chars().count();
    n >= min && n <= max
}

/// The request shape and the per-field character limits.
fn shaped(upload: &Upload) -> bool {
    chars(&upload.sent_at, 1, 40)
        && (1..=MAX_SEGMENTS).contains(&upload.segments.len())
        && upload.segments.iter().all(|s| {
            chars(&s.started_at, 1, 40)
                && chars(&s.ended_at, 1, 40)
                && chars(&s.app_name, 1, 400)
                && chars(&s.bundle_id, 1, 255)
                && chars(&s.window_title, 0, 1000)
                && s.address.as_deref().is_none_or(|a| chars(a, 0, 2048))
                && chars(&s.body, 0, 8192)
        })
}

fn bad(message: &str) -> Response {
    Response::new(400, json!({"error": message}))
}

/// The link check, then the switch, the pause, the clock and the segments, in the legacy order.
pub fn post<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Ok(upload) = serde_json::from_value::<Upload>(request.body.clone()) else {
        return Ok(bad("Invalid request"));
    };
    if !shaped(&upload) {
        return Ok(bad("Invalid request"));
    }
    let link = call(host, "link", json!({}))?;
    let device = match link["link"].as_str() {
        Some("device") => link["deviceId"].as_str().unwrap_or_default().to_owned(),
        Some("pending") => return Ok(refuse(Code::PendingApproval)),
        Some("deactivated") => return Ok(refuse(Code::Deactivated)),
        _ => return Ok(refuse(Code::NotLinked)),
    };
    if call(host, "storage", json!({}))?["on"] != json!(true) {
        return Ok(refuse(Code::Unavailable));
    }
    lock(host)?;
    if call(host, "paused", json!({}))?["paused"] == json!(true) {
        return Ok(refuse(Code::Paused));
    }
    let Some(sent) = parse(&upload.sent_at) else {
        return Ok(bad("sentAt must be a date and time"));
    };
    let received = now(host)?;
    let skew = received - sent;
    if skew.num_milliseconds().abs() > MAX_SKEW {
        return Ok(refuse(Code::Clock));
    }

    // Each segment moves to server time by the measured skew, then must fit the accepted window.
    struct Candidate<'a> {
        segment: &'a Segment,
        client_started: String,
        started: chrono::DateTime<chrono::Utc>,
        ended: chrono::DateTime<chrono::Utc>,
    }
    let mut candidates = Vec::new();
    let mut rejected_clock = 0;
    for segment in &upload.segments {
        let (Some(cs), Some(ce)) = (parse(&segment.started_at), parse(&segment.ended_at)) else {
            rejected_clock += 1;
            continue;
        };
        let (started, ended) = (cs + skew, ce + skew);
        if received - started > Duration::milliseconds(MAX_AGE) || ended > received || ended < started {
            rejected_clock += 1;
            continue;
        }
        candidates.push(Candidate { segment, client_started: write(cs), started, ended });
    }
    let windows: Vec<Value> = candidates.iter().map(|c| json!([write(c.started), write(c.ended)])).collect();
    let overlapping = call(host, "overlaps", json!({"windows": windows}))?;
    let hits: Vec<usize> = overlapping["indexes"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as usize)).collect())
        .unwrap_or_default();
    let discarded = hits.len();

    let mut rows = Vec::new();
    for (index, c) in candidates.iter().enumerate() {
        if hits.contains(&index) {
            continue;
        }
        let s = c.segment;
        let title = redact(&s.window_title);
        let address = s.address.as_deref().map(redact);
        let body = redact(&s.body);
        // One oversized row would fail the whole insert, so it is skipped alone.
        if s.app_name.len() > 400
            || s.bundle_id.len() > 255
            || title.len() > 1000
            || address.as_ref().is_some_and(|a| a.len() > 2048)
            || body.len() > 8192
        {
            continue;
        }
        let hash: String = Sha256::digest(body.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        rows.push(json!({
            "startedAt": write(c.started), "endedAt": write(c.ended), "appName": s.app_name,
            "bundleId": s.bundle_id, "windowTitle": title, "address": address, "body": body,
            "bodyHash": hash, "clientStartedAt": c.client_started,
        }));
    }
    let attempted = rows.len();
    let inserted = if rows.is_empty() {
        0
    } else {
        call(host, "insert", json!({"deviceId": device, "segments": rows}))?["inserted"].as_u64().unwrap_or(0) as usize
    };
    if inserted > 0 {
        crate::upkeep::keep_scheduled(host);
    }
    Ok(Response::new(
        200,
        json!({
            "accepted": inserted, "duplicates": attempted - inserted, "discarded": discarded,
            "rejectedClock": rejected_clock, "state": {"storage": "on", "paused": false},
        }),
    ))
}

fn refuse(code: Code) -> Response {
    Response::new(code.status(), code.body())
}
