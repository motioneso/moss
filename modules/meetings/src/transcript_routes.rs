//! Transcript storage routes: post a batch, read a snapshot, resolve evidence.
use crate::js::MAX_SAFE;
use crate::schema::{id_params, strict_object, Failure, Kind};
use crate::store::{self, Stored};
use crate::transcript::{self, Event, Ledger, Segment, Source};
use crate::transcript_batch::{self as batch, Fail};
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

fn code(status: u16, code: &str) -> Response {
    Response::new(status, json!({"code": code}))
}
fn failed(fail: Fail) -> Response {
    match fail {
        Fail::Input => code(400, "meeting_transcript_invalid_input"),
        Fail::Limit => code(413, "meeting_transcript_limit"),
        Fail::Conflict => code(409, "meeting_transcript_request_conflict"),
    }
}
fn invalid(failure: Failure) -> Response {
    Response::new(400, json!({"error": failure}))
}
fn unavailable() -> Response {
    code(404, "meeting_transcript_unavailable")
}

const COUNTER: Kind = Kind::Int { min: 0, max: MAX_SAFE };
const FROM_ONE: Kind = Kind::Int { min: 1, max: MAX_SAFE };
const NAME: Kind = Kind::Text { min: 1, max: 256 };
const IDENT: Kind = Kind::Ident { min: 1, max: 256 };
const KINDS: Kind = Kind::Enum(&["microphone", "output", "recording"]);
const FINALITY: Kind = Kind::Enum(&["provisional", "final"]);
const PROVENANCE: Kind = Kind::Enum(&["transcription", "correction"]);

const SOURCE_KEYS: [&str; 6] = ["sourceId", "epoch", "kind", "label", "startMs", "endMs"];
const SEGMENT_KEYS: [&str; 11] = [
    "meetingId", "segmentId", "sourceId", "epoch", "startMs", "endMs", "revision", "text", "finality",
    "provenance", "speakerId",
];

/// The body rules from the route schema, in the order Ajv checks them. Speaker, stop cutoff and
/// string types are already settled by the canonical encoding, which runs first.
fn validate_body(body: &mut Value) -> std::result::Result<(), Failure> {
    strict_object(
        "body",
        body,
        &["requestKey", "expectedVersion", "sources", "events", "stopCutoffMs"],
        &[
            ("requestKey", Kind::Uuid),
            ("expectedVersion", Kind::Int { min: 0, max: 4095 }),
            ("sources", Kind::Any),
            ("events", Kind::Any),
            ("stopCutoffMs", Kind::Any),
        ],
        0,
    )?;
    let items = |body: &mut Value, key: &str| body[key].as_array_mut().map(std::mem::take).unwrap_or_default();
    let (mut sources, mut events) = (items(body, "sources"), items(body, "events"));
    for (i, source) in sources.iter_mut().enumerate() {
        strict_object(
            &format!("body/sources/{i}"),
            source,
            &SOURCE_KEYS,
            &[
                ("sourceId", NAME),
                ("epoch", FROM_ONE),
                ("kind", KINDS),
                ("label", NAME),
                ("startMs", COUNTER),
                ("endMs", COUNTER),
            ],
            0,
        )?;
    }
    for (i, event) in events.iter_mut().enumerate() {
        let at = format!("body/events/{i}");
        strict_object(&at, event, &["cursor", "segment"], &[("cursor", FROM_ONE), ("segment", Kind::Any)], 0)?;
        strict_object(
            &format!("{at}/segment"),
            &mut event["segment"],
            &SEGMENT_KEYS,
            &[
                ("meetingId", Kind::Uuid),
                ("segmentId", NAME),
                ("sourceId", NAME),
                ("epoch", FROM_ONE),
                ("startMs", COUNTER),
                ("endMs", COUNTER),
                ("revision", FROM_ONE),
                ("text", Kind::Text { min: 0, max: 100_000 }),
                ("finality", FINALITY),
                ("provenance", PROVENANCE),
                ("speakerId", Kind::Any),
            ],
            0,
        )?;
    }
    Ok(())
}

pub fn post<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let mut input: Map<String, Value> = match &request.body {
        Value::Object(m) => m.clone(),
        _ => Map::new(),
    };
    input.insert("meetingId".into(), Value::String(request.params.get("id").cloned().unwrap_or_default()));
    let (encoded, parsed) = match batch::encode(&input) {
        Ok(ok) => ok,
        Err(fail) => return Ok(failed(fail)),
    };
    if let Err(f) = id_params(request) {
        return Ok(invalid(f));
    }
    let mut body = request.body.clone();
    if let Err(f) = validate_body(&mut body) {
        return Ok(invalid(f));
    }
    let mut state = match store::load(host, &parsed.meeting_id, true)? {
        Ok(Some(state)) => state,
        Ok(None) => return Ok(code(404, "meeting_not_found")),
        Err(fail) => return Ok(failed(fail)),
    };
    if let Some(previous) = state.batches.iter().find(|b| b.request_key == parsed.request_key) {
        return Ok(if previous.input_json != encoded {
            failed(Fail::Conflict)
        } else {
            Response::new(200, json!({"status":"saved","replayed":true,"receipt":previous.receipt()}))
        });
    }
    if state.receipt().version != parsed.expected_version {
        return Ok(Response::new(
            409,
            json!({"code":"meeting_transcript_version_conflict","status":"conflict","receipt":state.receipt()}),
        ));
    }
    if state.bytes + encoded.len() as i64 > batch::MAX_STORAGE_BYTES {
        return Ok(failed(Fail::Limit));
    }
    let previous_stop = state.receipt().stop_cutoff_ms;
    let ledger = match batch::apply(state.ledger.take(), &state.owner, previous_stop, &parsed) {
        Ok(ledger) => ledger,
        Err(fail) => return Ok(failed(fail)),
    };
    store::save(host, &parsed, &encoded, &ledger)?;
    let receipt = json!({"version": parsed.expected_version + 1, "transcriptRevision": ledger.transcript_revision,
        "cursor": ledger.cursor, "stopCutoffMs": parsed.stop_cutoff_ms});
    Ok(Response::new(201, json!({"status":"saved","replayed":false,"receipt":receipt})))
}

/// The ledger and bounds a read needs, or the answer to give instead.
fn open<H: Host + ?Sized>(host: &H, id: &str) -> Result<std::result::Result<(Stored, Ledger), Response>> {
    let id = id.to_lowercase();
    Ok(match store::load(host, &id, false)? {
        Ok(Some(state)) if state.ledger.is_some() => {
            let mut state = state;
            let ledger = state.ledger.take().expect("checked");
            Ok((state, ledger))
        }
        Ok(_) => Err(unavailable()),
        Err(fail) => Err(failed(fail)),
    })
}

/// The query parameters a route names. Others are dropped, as the old server's validator did.
fn query_value(request: &RouteRequest, known: &[&str]) -> Value {
    Value::Object(
        request.query.iter().filter(|(k, _)| known.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect(),
    )
}

pub fn get<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_params(request) {
        Ok(id) => id,
        Err(f) => return Ok(invalid(f)),
    };
    let mut query = query_value(request, &["transcriptRevision", "cutoffMs", "maxSegments", "maxCharacters"]);
    if let Err(f) = strict_object(
        "querystring",
        &mut query,
        &["maxSegments", "maxCharacters"],
        &[
            ("transcriptRevision", COUNTER),
            ("cutoffMs", COUNTER),
            ("maxSegments", Kind::Int { min: 1, max: 500 }),
            ("maxCharacters", Kind::Int { min: 1, max: 100_000 }),
        ],
        0,
    ) {
        return Ok(invalid(f));
    }
    let (state, ledger) = match open(host, &id)? {
        Ok(ok) => ok,
        Err(response) => return Ok(response),
    };
    let bound = state
        .receipt()
        .stop_cutoff_ms
        .unwrap_or_else(|| ledger.sources.iter().map(|s| s.end_ms).max().unwrap_or(0));
    let number = |key: &str| query.get(key).and_then(Value::as_i64);
    let revision = number("transcriptRevision").unwrap_or(ledger.transcript_revision);
    let cutoff = number("cutoffMs").unwrap_or(bound).min(bound);
    let (max_segments, max_characters) = (number("maxSegments").unwrap_or(0), number("maxCharacters").unwrap_or(0));
    let snapshot = match transcript::snapshot(&ledger, revision, cutoff, max_segments, max_characters) {
        Ok(s) => s,
        Err(_) => return Ok(failed(Fail::Input)),
    };
    Ok(Response::new(
        200,
        json!({"snapshot": {
            "maxSegments": max_segments, "maxCharacters": max_characters,
            "meetingId": id.to_lowercase(), "ownerUserId": ledger.owner_user_id,
            "transcriptRevision": revision, "cutoffMs": cutoff, "cursor": snapshot.cursor,
            "segments": snapshot.segments, "throughMs": snapshot.through_ms,
            "omittedSegments": snapshot.omitted, "containsProvisional": snapshot.contains_provisional},
          "sources": ledger.sources}),
    ))
}

pub fn evidence<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_params(request) {
        Ok(id) => id,
        Err(f) => return Ok(invalid(f)),
    };
    let mut query = query_value(request, &["segmentId", "segmentRevision", "startCharacter", "endCharacter"]);
    if let Err(f) = strict_object(
        "querystring",
        &mut query,
        &["segmentId", "segmentRevision", "startCharacter", "endCharacter"],
        &[("segmentId", IDENT), ("segmentRevision", FROM_ONE), ("startCharacter", COUNTER), ("endCharacter", COUNTER)],
        0,
    ) {
        return Ok(invalid(f));
    }
    let (_, ledger) = match open(host, &id)? {
        Ok(ok) => ok,
        Err(response) => return Ok(response),
    };
    let number = |key: &str| query[key].as_i64().unwrap_or(0);
    let found = transcript::evidence(
        &ledger,
        query["segmentId"].as_str().unwrap_or_default(),
        number("segmentRevision"),
        number("startCharacter"),
        number("endCharacter"),
    );
    Ok(match found {
        Some((segment, excerpt)) => Response::new(200, json!({"evidence":{"segment":segment,"excerpt":excerpt}})),
        None => unavailable(),
    })
}

/// The distinct source labels shown on History, first four in order.
pub fn history_sources(sources: &[Source]) -> (String, i64) {
    #[derive(serde::Serialize)]
    struct Label<'a> {
        kind: &'a str,
        label: &'a str,
    }
    let mut seen = HashSet::new();
    let unique: Vec<Label> = sources
        .iter()
        .filter(|s| seen.insert((s.kind.as_str(), s.label.as_str())))
        .map(|s| Label { kind: &s.kind, label: &s.label })
        .collect();
    let shown = &unique[..unique.len().min(4)];
    (serde_json::to_string(shown).unwrap_or_default(), unique.len().saturating_sub(4) as i64)
}

/// Latest revision of each segment in this batch, in order of first appearance.
pub fn latest_segments(events: &[Event]) -> Vec<&Segment> {
    let mut at: HashMap<&str, usize> = HashMap::new();
    let mut out: Vec<&Segment> = vec![];
    for e in events {
        match at.get(e.segment.segment_id.as_str()) {
            Some(i) if out[*i].revision >= e.segment.revision => {}
            Some(i) => out[*i] = &e.segment,
            None => {
                at.insert(&e.segment.segment_id, out.len());
                out.push(&e.segment);
            }
        }
    }
    out
}
