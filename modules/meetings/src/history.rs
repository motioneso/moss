//! History routes: validated search input, one host read, and the response shape.
use crate::js::utf16_len;
use crate::records::iso;
use crate::schema::int_value;
use crate::text::{is_iso_millis, is_uuid, js_trim};
use chrono::DateTime;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Map, Value};

pub const HISTORY: &str = "meetings.history";
const FILTERS: [&str; 5] = ["all", "transcript", "needs-review", "exported", "notes-only"];
const IMPORT_MAX_MS: f64 = 7_200_000.0;

fn code(status: u16, code: &str) -> Response {
    Response::new(status, json!({"code": code}))
}
fn invalid() -> Response {
    code(400, "meeting_history_invalid_input")
}
fn unavailable() -> Response {
    code(503, "meeting_history_unavailable")
}

fn type_id(value: &str) -> bool {
    let b = value.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A search body the old route accepted. `None` is any shape it refused.
struct Search {
    query: String,
    filter: String,
    limit: i64,
    before: Option<(String, String)>,
    type_id: Option<String>,
}

fn parse(body: &Value) -> Option<Search> {
    let object: &Map<String, Value> = body.as_object()?;
    if object.keys().any(|k| !["query", "filter", "limit", "before", "typeId"].contains(&k.as_str())) {
        return None;
    }
    let query = match object.get("query") {
        None => "",
        Some(v) => v.as_str()?,
    };
    if utf16_len(query) > 256 || query.len() > 512 || query.contains('\0') {
        return None;
    }
    let filter = match object.get("filter") {
        None => "all",
        Some(v) => v.as_str().filter(|f| FILTERS.contains(f))?,
    };
    let limit = match object.get("limit") {
        None => 30,
        Some(v) => int_value(v).filter(|n| (1..=50).contains(n))?,
    };
    let type_id_value = match object.get("typeId") {
        None => None,
        Some(v) => Some(v.as_str().filter(|t| type_id(t))?.to_owned()),
    };
    let before = match object.get("before") {
        None => None,
        Some(v) => {
            let cursor = v.as_object()?;
            if cursor.keys().any(|k| k != "id" && k != "dateAt") {
                return None;
            }
            let id = cursor.get("id")?.as_str().filter(|i| is_uuid(i))?;
            let at = cursor.get("dateAt")?.as_str()?;
            if DateTime::parse_from_rfc3339(at).is_err() || !is_iso_millis(at) {
                return None;
            }
            Some((id.to_owned(), at.to_owned()))
        }
    };
    Some(Search {
        query: js_trim(query).to_owned(),
        filter: filter.to_owned(),
        limit,
        before,
        type_id: type_id_value,
    })
}

fn text(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}
fn when(row: &Value, key: &str) -> Result<Option<String>> {
    if row[key].is_null() { Ok(None) } else { iso(&row[key]).map(Some) }
}
fn count(row: &Value, key: &str) -> Value {
    row[key].clone()
}

/// A stored import duration counts only as a whole number from 0 to two hours.
fn import_duration(row: &Value) -> Value {
    let parsed: Option<Value> = row["import_metadata_json"].as_str().and_then(|s| serde_json::from_str(s).ok());
    parsed
        .and_then(|v| v["durationMs"].as_f64())
        .filter(|d| d.fract() == 0.0 && (0.0..=IMPORT_MAX_MS).contains(d))
        .map_or(Value::Null, |d| json!(d as i64))
}

/// One meeting row from the host read, shaped as the old `meetingHistoryItem`.
fn item(row: &Value) -> Result<Value> {
    let bad = || moss_module_sdk::Error::new("Invalid History row");
    let created = when(row, "created_at")?.ok_or_else(bad)?;
    let recorded = when(row, "recorded_at")?;
    let date = match &recorded {
        Some(at) => json!({"at": at, "source": "recorded"}),
        None => json!({"at": created, "source": "added"}),
    };
    let sources: Value = serde_json::from_str(row["sources_json"].as_str().ok_or_else(bad)?)?;
    let span = match (row["start_ms"].is_null(), row["end_ms"].is_null()) {
        (false, false) => json!({"startMs": row["start_ms"], "endMs": row["end_ms"]}),
        _ => Value::Null,
    };
    let (type_id, side) = (text(row, "type_id"), text(row, "recording_side"));
    let mut meeting = json!({
        "id": row["id"], "title": row["title"], "date": date, "createdAt": created,
        "updatedAt": when(row, "updated_at")?.ok_or_else(bad)?,
    });
    if type_id.is_some() || side.is_some() {
        meeting["recording"] = json!({"typeId": type_id, "side": side});
    }
    let segments = row["segment_count"].as_i64().unwrap_or(0);
    let version = &row["output_version"];
    let generation = match (row["generation_status"].as_str(), when(row, "generation_expires_at")?) {
        (Some(status), Some(at)) => json!({"status": status, "expiresAt": at}),
        _ => Value::Null,
    };
    let latest = match (
        version_of(row),
        row["vault_write_status"].as_str(),
        row["vault_index_status"].as_str(),
        text(row, "vault_updated_at"),
    ) {
        (Some(v), Some(w), Some(i), Some(u)) => {
            json!({"artifactVersion": v, "writeStatus": w, "indexStatus": i, "updatedAt": u})
        }
        _ => Value::Null,
    };
    let fields = json!({
        "hasNotes": row["has_notes"], "notesRevision": row["notes_revision"],
        "capture": {
            "status": "unavailable",
            "durationMs": if row["capture_duration_ms"].is_null() { import_duration(row) } else { row["capture_duration_ms"].clone() },
        },
        "transcript": {
            "status": if segments > 0 { "retained" } else { "none" },
            "revision": count(row, "transcript_revision"), "segmentCount": count(row, "segment_count"),
            "finalSegmentCount": count(row, "final_count"), "provisionalSegmentCount": count(row, "provisional_count"),
            "span": span, "sources": sources, "omittedSourceCount": count(row, "omitted_sources"),
        },
        "summary": {
            "overview": text(row, "output_overview"),
            "status": if version.is_null() { "none" } else if row["output_stale"] == json!(true) { "stale" } else { "available" },
            "version": version, "origin": row["output_origin"],
            "createdAt": when(row, "output_created_at")?, "generation": generation,
        },
        "actions": {
            "pending": count(row, "pending_count"), "accepted": count(row, "accepted_count"),
            "dismissed": count(row, "dismissed_count"),
        },
        "vault": {"latest": latest, "savedVersionCount": count(row, "saved_count")},
    });
    if let (Some(m), Some(f)) = (meeting.as_object_mut(), fields.as_object()) {
        m.extend(f.clone());
    }
    Ok(meeting)
}
fn version_of(row: &Value) -> Option<Value> {
    (!row["vault_version"].is_null()).then(|| row["vault_version"].clone())
}

/// Runs one host read. `None` means the host refused or failed, which the old route called unavailable.
fn fetch<H: Host + ?Sized>(host: &H, id: Option<&str>, s: &Search) -> Option<Value> {
    let before = s.before.as_ref().map(|(id, at)| json!({"id": id, "dateAt": at}));
    host.call(
        "kv",
        "get",
        HISTORY,
        json!({"id": id, "query": s.query, "filter": s.filter, "limit": s.limit, "before": before, "typeId": s.type_id}),
    )
    .ok()
}

pub fn search<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(s) = parse(&request.body) else { return Ok(invalid()) };
    let Some(reply) = fetch(host, None, &s) else { return Ok(unavailable()) };
    if reply["tooManyTerms"] == json!(true) {
        return Ok(invalid());
    }
    let Some(rows) = reply["rows"].as_array() else { return Ok(unavailable()) };
    let limit = s.limit as usize;
    let mut meetings = Vec::with_capacity(limit.min(rows.len()));
    for row in rows.iter().take(limit) {
        match item(row) {
            Ok(m) => meetings.push(m),
            Err(_) => return Ok(unavailable()),
        }
    }
    let next = match (rows.len() > limit, meetings.last()) {
        (true, Some(last)) => json!({"id": last["id"], "dateAt": last["date"]["at"]}),
        _ => Value::Null,
    };
    Ok(Response::new(200, json!({"meetings": meetings, "nextCursor": next})))
}

pub fn get<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match request.params.get("id") {
        Some(id) if request.params.len() == 1 && is_uuid(id) => id.clone(),
        _ => return Ok(invalid()),
    };
    let s = Search { query: String::new(), filter: "all".into(), limit: 1, before: None, type_id: None };
    let Some(reply) = fetch(host, Some(&id), &s) else { return Ok(unavailable()) };
    match reply["rows"].as_array().and_then(|rows| rows.first()) {
        None => Ok(code(404, "meeting_not_found")),
        Some(row) => match item(row) {
            Ok(meeting) => Ok(Response::new(200, json!({"meeting": meeting}))),
            Err(_) => Ok(unavailable()),
        },
    }
}
