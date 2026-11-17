//! Canonical transcript batches and the limits around them.
use crate::js::{cmp_utf16, safe_int, utf16_len};
use crate::text::js_trim;
use crate::transcript::{Event, Ledger, Segment, Source, MAX_CHARACTERS};
use serde::Serialize;
use serde_json::{Map, Value};

pub const MAX_BATCHES: usize = 4096;
pub const MAX_REVISIONS: i64 = 20_000;
pub const MAX_STORAGE_BYTES: i64 = 32 * 1024 * 1024;
pub const MAX_ENCODED_BYTES: usize = 524_288;

#[derive(Debug, PartialEq)]
pub enum Fail {
    Input,
    Limit,
    Conflict,
}

/// One accepted batch exactly as stored. Field order is the canonical key order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub meeting_id: String,
    pub request_key: String,
    pub expected_version: i64,
    pub sources: Vec<Source>,
    pub events: Vec<Event>,
    pub stop_cutoff_ms: Option<i64>,
}

fn exact<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, Fail> {
    match value.as_object() {
        Some(m) if m.len() == keys.len() && m.keys().all(|k| keys.contains(&k.as_str())) => Ok(m),
        _ => Err(Fail::Input),
    }
}
fn text<'a>(value: &'a Value) -> Result<&'a str, Fail> {
    match value.as_str() {
        Some(s) if !s.contains('\0') && !js_trim(s).is_empty() && utf16_len(s) <= 256 => Ok(s),
        _ => Err(Fail::Input),
    }
}
fn int(value: &Value) -> Result<i64, Fail> {
    safe_int(value).ok_or(Fail::Input)
}
fn string(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// The canonical text kept for replay checks. `input` is the request body with the route's
/// meeting id added. Kind, finality and provenance are left to the route schema, which runs next.
pub fn encode(input: &Map<String, Value>) -> Result<(String, Batch), Fail> {
    let keys = [
        "meetingId",
        "requestKey",
        "expectedVersion",
        "sources",
        "events",
        "stopCutoffMs",
    ];
    if input.len() != keys.len() || input.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err(Fail::Input);
    }
    let version = int(&input["expectedVersion"]).ok().filter(|v| *v >= 0);
    let sources = input["sources"].as_array().filter(|a| !a.is_empty());
    let events = input["events"].as_array();
    let stop = match &input["stopCutoffMs"] {
        Value::Null => Some(None),
        v => int(v).ok().filter(|n| *n >= 0).map(Some),
    };
    let (Some(version), Some(sources), Some(events), Some(stop)) = (version, sources, events, stop)
    else {
        return Err(Fail::Input);
    };
    if version >= MAX_BATCHES as i64 || sources.len() > 128 || events.len() > 100 {
        return Err(Fail::Limit);
    }
    let mut out_sources = vec![];
    for source in sources {
        let m = exact(source, &["sourceId", "epoch", "kind", "label", "startMs", "endMs"])?;
        let (epoch, start, end) = (int(&m["epoch"])?, int(&m["startMs"])?, int(&m["endMs"])?);
        text(&m["sourceId"])?;
        text(&m["label"])?;
        out_sources.push(Source {
            source_id: string(&m["sourceId"]),
            epoch,
            kind: string(&m["kind"]),
            label: string(&m["label"]),
            start_ms: start,
            end_ms: end,
        });
    }
    out_sources.sort_by(|a, b| a.epoch.cmp(&b.epoch).then_with(|| cmp_utf16(&a.source_id, &b.source_id)));
    let mut out_events = vec![];
    for event in events {
        let m = exact(event, &["cursor", "segment"])?;
        let s = &m["segment"];
        let seg = s.as_object().ok_or(Fail::Input)?;
        let get = |k: &str| seg.get(k).unwrap_or(&Value::Null);
        let cursor = int(&m["cursor"])?;
        let (epoch, start, end, revision) =
            (int(get("epoch"))?, int(get("startMs"))?, int(get("endMs"))?, int(get("revision"))?);
        exact(
            s,
            &[
                "meetingId", "segmentId", "sourceId", "epoch", "startMs", "endMs", "revision", "text",
                "finality", "provenance", "speakerId",
            ],
        )?;
        text(get("meetingId"))?;
        text(get("segmentId"))?;
        text(get("sourceId"))?;
        if !get("speakerId").is_null() {
            text(get("speakerId"))?;
        }
        let body = get("text").as_str().filter(|t| !t.contains('\0')).ok_or(Fail::Input)?;
        if utf16_len(body) as i64 > MAX_CHARACTERS {
            return Err(Fail::Limit);
        }
        out_events.push(Event {
            cursor,
            segment: Segment {
                meeting_id: string(get("meetingId")).to_lowercase(),
                segment_id: string(get("segmentId")),
                source_id: string(get("sourceId")),
                epoch,
                start_ms: start,
                end_ms: end,
                revision,
                text: body.to_owned(),
                finality: string(get("finality")),
                provenance: string(get("provenance")),
                speaker_id: get("speakerId").as_str().map(str::to_owned),
            },
        });
    }
    let (Some(meeting), Some(key)) = (input["meetingId"].as_str(), input["requestKey"].as_str())
    else {
        return Err(Fail::Input);
    };
    let batch = Batch {
        meeting_id: meeting.to_lowercase(),
        request_key: key.to_lowercase(),
        expected_version: version,
        sources: out_sources,
        events: out_events,
        stop_cutoff_ms: stop,
    };
    let encoded = serde_json::to_string(&batch).map_err(|_| Fail::Input)?;
    if encoded.len() > MAX_ENCODED_BYTES {
        return Err(Fail::Limit);
    }
    Ok((encoded, batch))
}

/// Applies one batch to the stored ledger, or starts a ledger when there is none.
pub fn apply(
    previous: Option<Ledger>,
    owner: &str,
    previous_stop: Option<i64>,
    input: &Batch,
) -> Result<Ledger, Fail> {
    if previous_stop.is_some() && input.stop_cutoff_ms != previous_stop {
        return Err(Fail::Input);
    }
    if input.stop_cutoff_ms.is_some_and(|stop| input.sources.iter().any(|s| s.end_ms > stop)) {
        return Err(Fail::Input);
    }
    let mut ledger = match previous {
        Some(mut ledger) => {
            ledger.extend_sources(&input.sources).map_err(|_| Fail::Input)?;
            ledger
        }
        None => Ledger::new(&input.meeting_id, owner, &input.sources).map_err(|_| Fail::Input)?,
    };
    for event in &input.events {
        if utf16_len(&event.segment.text) as i64 > MAX_CHARACTERS {
            return Err(Fail::Limit);
        }
        ledger.apply(event).map_err(|_| Fail::Input)?;
    }
    if ledger.transcript_revision > MAX_REVISIONS {
        return Err(Fail::Limit);
    }
    Ok(ledger)
}
