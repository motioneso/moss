//! Pasted transcripts. One request creates the meeting, its recording identity and its single
//! transcript segment, and a repeated request key returns the first answer.
use crate::js::utf16_len;
use crate::records::{Created, Records};
use crate::recording::{code, Recording};
use crate::schema::{strict_object, Kind};
use crate::store;
use crate::text::{is_type_id, is_uuid, js_trim};
use crate::transcript_batch as batch;
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const ENTRIES: &str = "app.meeting_manual_entries";
const KEYS: [&str; 5] = ["requestKey", "title", "typeId", "recordedAt", "transcript"];

fn refuse(status: u16, name: &str) -> Response {
    code(status, name)
}

/// The cleaned input, in the key order the old app hashed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    request_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    type_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recorded_at: Option<String>,
    transcript: String,
}

/// The strict check that ran before the schema. `None` means the input is refused.
fn clean(body: &Value) -> Option<Input> {
    let map = body.as_object().filter(|m| m.keys().all(|k| KEYS.contains(&k.as_str())))?;
    let key = map.get("requestKey")?.as_str().filter(|k| is_uuid(k))?;
    let transcript = map.get("transcript")?.as_str()?;
    if js_trim(transcript).is_empty() || transcript.contains('\0') || utf16_len(transcript) > 100_000 {
        return None;
    }
    let title = match map.get("title") {
        None => None,
        Some(v) => {
            let t = v.as_str()?;
            if js_trim(t).is_empty() || t.contains('\0') || js_trim(t).len() > 240 {
                return None;
            }
            Some(js_trim(t).to_owned())
        }
    };
    let type_id = match map.get("typeId") {
        None => None,
        Some(v) => Some(v.as_str().filter(|t| is_type_id(t))?.to_owned()),
    };
    let recorded_at = match map.get("recordedAt") {
        None => None,
        Some(v) => {
            let text = v.as_str()?;
            match DateTime::parse_from_rfc3339(&crate::text::with_colon_offset(text)) {
                // A leap second is valid for the schema but not for `Date.parse`.
                Ok(at) if at.timestamp_subsec_nanos() >= 1_000_000_000 => return None,
                Ok(at) => Some(at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true)),
                // JavaScript's parser accepts looser dates, which the schema check then refuses.
                Err(_) if loosely_a_date(text) => Some(String::new()),
                Err(_) => return None,
            }
        }
    };
    Some(Input {
        request_key: key.to_lowercase(),
        title,
        type_id,
        recorded_at,
        transcript: transcript.to_owned(),
    })
}

/// An approximation of what `Date.parse` accepts beyond RFC 3339 (date-only and zoneless forms).
fn loosely_a_date(text: &str) -> bool {
    let b = text.as_bytes();
    let digits = |from: usize, n: usize| b.len() >= from + n && b[from..from + n].iter().all(u8::is_ascii_digit);
    let month = |at: usize| digits(at, 2) && (1..=12).contains(&((b[at] - b'0') * 10 + (b[at + 1] - b'0')));
    digits(0, 4) && (b.len() == 4 || (matches!(b[4], b'-' | b'/') && month(5)))
        && (b.len() <= 7 || (matches!(b[7], b'-' | b'/') && digits(8, 2) && (b.len() == 10 || matches!(b[10], b'T' | b't' | b' '))))
}

pub fn post<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(input) = clean(&request.body) else {
        return Ok(refuse(400, "recording_invalid_input"));
    };
    let mut body = request.body.clone();
    let required = ["requestKey", "transcript"];
    if let Err(failure) = strict_object(
        "body",
        &mut body,
        &required,
        &[
            ("requestKey", Kind::Uuid),
            ("title", Kind::Text { min: 1, max: 240 }),
            ("typeId", Kind::TypeId),
            ("recordedAt", Kind::DateTime),
            ("transcript", Kind::Text { min: 1, max: 100_000 }),
        ],
        0,
    ) {
        return Ok(Response::new(400, json!({ "error": failure })));
    }
    let hash = format!("{:x}", Sha256::digest(serde_json::to_string(&input)?.as_bytes()));
    let records = Records::new(host);
    let title = input.title.as_deref().unwrap_or("Untitled meeting");
    let (meeting, fresh) = match records.create_record(&input.request_key, title)? {
        Created::New(snapshot) => (snapshot.id, true),
        Created::Replay(snapshot) => (snapshot.id, false),
        Created::Conflict => return Ok(refuse(409, "recording_request_conflict")),
    };
    // The meeting row lock serialises two requests that share a key.
    let state = match store::load(host, &meeting, true)? {
        Ok(Some(state)) => state,
        _ => return Ok(refuse(409, "recording_entry_failed")),
    };
    let client = Client(host);
    let mut find = Query::select(Filter::eq("meeting_id", meeting.as_str()));
    find.limit = Some(1);
    if let Some(entry) = client.query(ENTRIES, &find)?.into_iter().next() {
        return Ok(if entry["input_hash"].as_str() == Some(hash.as_str()) {
            Response::new(200, json!({"meetingId": meeting, "replayed": true}))
        } else {
            refuse(409, "recording_request_conflict")
        });
    }
    if !fresh {
        return Ok(refuse(409, "recording_request_conflict"));
    }
    let recording = Recording::new(host);
    if let Some(type_id) = &input.type_id {
        let known = recording.configuration(false)?.types.iter().any(|t| &t.id == type_id && !t.retired);
        if !known {
            return Ok(refuse(400, "recording_type_unavailable"));
        }
    }
    recording.create(
        &meeting,
        if input.title.is_none() { "automatic" } else { "user" },
        input.type_id.as_deref(),
        input.recorded_at.as_deref(),
    )?;
    let revision = match ingest(host, &meeting, &input.request_key, &input.transcript, state)? {
        Some(revision) => revision,
        None => return Ok(refuse(409, "recording_entry_failed")),
    };
    let entry: BTreeMap<String, Value> = [
        ("meeting_id", json!(meeting)),
        ("request_key", json!(input.request_key)),
        ("input_hash", json!(hash)),
        ("transcript_revision", json!(revision)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    client.query(ENTRIES, &Query::insert(entry))?;
    Ok(Response::new(201, json!({"meetingId": meeting, "replayed": false})))
}

/// Saves the single pasted segment as transcript version one, or `None` when the ledger refuses it.
fn ingest<H: Host + ?Sized>(host: &H, meeting: &str, request_key: &str, transcript: &str, mut state: store::Stored) -> Result<Option<i64>> {
    let mut input = Map::new();
    input.insert("meetingId".into(), json!(meeting));
    input.insert("requestKey".into(), json!(request_key));
    input.insert("expectedVersion".into(), json!(0));
    input.insert("stopCutoffMs".into(), json!(1));
    input.insert(
        "sources".into(),
        json!([{"sourceId":"manual-transcript","epoch":1,"kind":"recording","label":"Pasted transcript","startMs":0,"endMs":1}]),
    );
    input.insert(
        "events".into(),
        json!([{"cursor":1,"segment":{"meetingId":meeting,"segmentId":"manual-transcript","sourceId":"manual-transcript",
            "epoch":1,"startMs":0,"endMs":1,"revision":1,"text":transcript,"finality":"final",
            "provenance":"correction","speakerId":null}}]),
    );
    let Ok((encoded, parsed)) = batch::encode(&input) else {
        return Ok(None);
    };
    let Ok(ledger) = batch::apply(state.ledger.take(), &state.owner, None, &parsed) else {
        return Ok(None);
    };
    store::save(host, &parsed, &encoded, &ledger)?;
    Ok(Some(ledger.transcript_revision))
}
