//! Resumable ring uploads. A person reserves an upload with its file hashes, sends the files as
//! 1 MiB chunks, then finalizes. The chunk bytes never enter the module. The host stages each
//! request body, and the module only decides whether the chunk may be stored.
use crate::recording::{code, Recording};
use crate::records::{Created, Records};
use crate::ring_errors::{Invalid, RingCode};
use crate::ring_source::{chunk_length, parse_upload, Destination, File, CHUNK};
use crate::ring_voice;
use crate::text::is_uuid;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const IMPORTS: &str = "app.meeting_recording_imports";
pub const CHUNKS: &str = "app.meeting_recording_chunks";
pub const ENABLEMENTS: &str = "app.meeting_recording_voice_enablements";
pub const FILES: &str = "meetings.recording-files";
pub const IMPORT_QUEUE: &str = "meetings.recording-import";
const KINDS: [&str; 3] = ["packets", "sidecar", "wav"];
const EXPIRY_SECONDS: i64 = 86_400;

fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

fn invalid(error: Invalid) -> Response {
    code(error.0, RingCode::ImportInvalid.as_str())
}

fn message(status: u16, text: &str) -> Response {
    Response::new(status, json!({ "error": text }))
}

pub(crate) fn now<H: Host + ?Sized>(host: &H) -> Result<DateTime<Utc>> {
    let context = host.call("context", "read", "call", json!({}))?;
    let text = context["now"].as_str().ok_or_else(|| moss_module_sdk::Error::new("Invalid host time"))?;
    DateTime::parse_from_rfc3339(text)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|_| moss_module_sdk::Error::new("Invalid host time"))
}

pub(crate) fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn one<H: Host + ?Sized>(host: &H, table: &str, filter: Filter) -> Result<Option<Value>> {
    let mut query = Query::select(filter);
    query.limit = Some(1);
    Ok(Client(host).query(table, &query)?.into_iter().next())
}

fn id_param(request: &RouteRequest) -> Option<String> {
    request.params.get("id").filter(|id| is_uuid(id)).map(|id| id.to_lowercase())
}

/// The chunk count a file of this size needs.
fn chunks_for(file: &File) -> u64 {
    file.byte_length.div_ceil(CHUNK)
}

fn manifest_files(manifest: &Value) -> Option<[File; 3]> {
    let read = |kind: &str| {
        Some(File {
            byte_length: manifest[kind]["byteLength"].as_u64()?,
            sha256: manifest[kind]["sha256"].as_str()?.to_owned(),
        })
    };
    Some([read("packets")?, read("sidecar")?, read("wav")?])
}

/// What the device needs to resume, in the legacy shape.
fn progress<H: Host + ?Sized>(host: &H, row: &Value, now: DateTime<Utc>) -> Result<Value> {
    let id = row["id"].as_str().unwrap_or_default();
    let mut counts = json!({"packets": 0, "sidecar": 0, "wav": 0});
    let mut query = Query::select(Filter::eq("import_id", id));
    query.limit = Some(1000);
    for chunk in Client(host).query(CHUNKS, &query)? {
        if let Some(kind) = chunk["kind"].as_str().filter(|k| KINDS.contains(k)) {
            counts[kind] = json!(counts[kind].as_u64().unwrap_or(0) + 1);
        }
    }
    let expires = row["upload_expires_at"].as_str().map(str::to_owned);
    let expired = expires
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| at.with_timezone(&Utc) <= now);
    Ok(json!({
        "id": id,
        "fingerprint": row["fingerprint"],
        "chunkBytes": CHUNK,
        "expiresAt": expires,
        "reserved": row["upload_reserved"],
        "ready": row["ready"],
        "expired": expired,
        "received": counts,
    }))
}

fn lock<H: Host + ?Sized>(host: &H, device: &str, recording: &str) -> Result<()> {
    host.call("kv", "lock", FILES, json!({"key": format!("{device}:{recording}")}))?;
    Ok(())
}

fn enablement<H: Host + ?Sized>(host: &H, id: &str, device: &str) -> Result<Option<Value>> {
    let row = one(host, ENABLEMENTS, Filter::eq("id", id))?;
    Ok(row.filter(|row| row["source_device_id"].as_str() == Some(device)))
}

/// `POST /recording-uploads`: reserves (or finds) the upload for one ring recording.
pub fn reserve<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let upload = match parse_upload(&request.body) {
        Ok(upload) => upload,
        Err(error) => return Ok(invalid(error)),
    };
    lock(host, &upload.source_device_id, &upload.recording_id)?;
    let now = now(host)?;
    let existing = one(
        host,
        IMPORTS,
        Filter::And {
            filters: vec![
                Filter::eq("source_device_id", upload.source_device_id.as_str()),
                Filter::eq("recording_id", upload.recording_id.as_str()),
            ],
        },
    )?;
    if let Some(row) = existing {
        if row["fingerprint"].as_str() != Some(upload.fingerprint.as_str()) {
            return Ok(code(409, RingCode::ImportConflict.as_str()));
        }
        return Ok(Response::new(200, progress(host, &row, now)?));
    }
    let voice = match &upload.destination {
        Destination::Meeting => None,
        Destination::Voice { enablement_id, .. } => {
            let row = enablement(host, enablement_id, &upload.source_device_id)?;
            let inventory = row.as_ref().map(inventory_of).unwrap_or_default();
            let state = row.as_ref().map(|r| ring_voice::Enablement { enabled: r["disabled_at"].is_null(), inventory: &inventory });
            if let Err(why) = ring_voice::admit(state.as_ref(), &upload.recording_id) {
                return Ok(Response::new(409, json!({"code": RingCode::VoiceIneligible.as_str(), "error": why})));
            }
            Some(enablement_id.clone())
        }
    };
    // A voice-mode id sent as a meeting is refused, because hold recordings never become meetings.
    if upload.voice_mode && voice.is_none() {
        return Ok(Response::new(
            409,
            json!({"code": RingCode::VoiceIneligible.as_str(), "error": ring_voice::INELIGIBLE_AS_MEETING}),
        ));
    }
    let id = host.call("context", "uuid", "new", json!({}))?["id"].as_str().unwrap_or_default().to_owned();
    let meeting = match voice {
        Some(_) => None,
        None => match create_meeting(host, &id)? {
            Some(meeting) => Some(meeting),
            None => return Ok(code(409, RingCode::ImportConflict.as_str())),
        },
    };
    let expires = stamp(now + Duration::seconds(EXPIRY_SECONDS));
    let mut fields = vec![
        ("id", json!(id)),
        ("meeting_id", json!(meeting)),
        ("source_device_id", json!(upload.source_device_id)),
        ("recording_id", json!(upload.recording_id)),
        ("fingerprint", json!(upload.fingerprint)),
        ("metadata_json", json!({})),
        ("ready", json!(false)),
        ("state", json!("queued")),
        ("source_manifest_json", json!(upload.canonical)),
        ("upload_reserved", json!(false)),
        ("upload_expires_at", json!(expires)),
    ];
    if let (Some(enablement_id), Destination::Voice { captured_at, .. }) = (&voice, &upload.destination) {
        fields.push(("voice_enablement_id", json!(enablement_id)));
        fields.push(("voice_captured_at", json!(captured_at)));
    }
    let mut insert = Query::insert(values(fields));
    insert.conflict = Conflict::Ignore;
    let client = Client(host);
    if client.query(IMPORTS, &insert)?.is_empty() {
        return Ok(code(409, RingCode::ImportConflict.as_str()));
    }
    host.call("kv", "prepare", FILES, json!({"importId": id, "manifest": upload.canonical}))?;
    let reserved = client.query(
        IMPORTS,
        &Query::update(Filter::eq("id", id.as_str()), values(vec![("upload_reserved", json!(true))])),
    )?;
    host.call(
        "jobs",
        "enqueue-options",
        IMPORT_QUEUE,
        json!({
            "params": {"import-id": id, "kind": "abandoned"},
            "idempotencyKey": host.call("context", "uuid", "new", json!({}))?["id"],
            "availableAt": expires,
        }),
    )?;
    let row = reserved.into_iter().next().ok_or_else(|| moss_module_sdk::Error::new("Import row vanished"))?;
    Ok(Response::new(201, progress(host, &row, now)?))
}

pub(crate) fn inventory_of(row: &Value) -> Vec<String> {
    let list = match &row["inventory_json"] {
        Value::String(text) => serde_json::from_str(text).unwrap_or(Value::Null),
        other => other.clone(),
    };
    let mut ids: Vec<String> = list.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    ids.sort();
    ids
}

/// Creates the meeting a ring import files its transcript under, or `None` on a key clash.
fn create_meeting<H: Host + ?Sized>(host: &H, import_id: &str) -> Result<Option<String>> {
    let records = Records::new(host);
    let meeting = match records.create_record(import_id, "Imported recording")? {
        Created::New(snapshot) => snapshot.id,
        Created::Replay(_) | Created::Conflict => return Ok(None),
    };
    Recording::new(host).create_from(&meeting, "automatic", None, None, "recording")?;
    Ok(Some(meeting))
}

/// `GET /recording-uploads/:id`.
pub fn status<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(id) = id_param(request) else { return Ok(message(400, "Invalid recording upload id")) };
    let Some(row) = one(host, IMPORTS, Filter::eq("id", id.as_str()))? else {
        return Ok(message(404, "Recording upload not found"));
    };
    Ok(Response::new(200, progress(host, &row, now(host)?)?))
}

/// `PUT /recording-uploads/:id/:kind/:index`. The body arrives as a staged size and hash.
pub fn put_chunk<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(id) = id_param(request) else { return Ok(message(400, "Invalid recording upload id")) };
    let kind = request.params.get("kind").map(String::as_str).unwrap_or_default();
    let index: Option<i32> = request.params.get("index").and_then(|i| i.parse().ok()).filter(|i| (0..256).contains(i));
    if !KINDS.contains(&kind) {
        return Ok(message(400, "Invalid recording file"));
    }
    let Some(index) = index.filter(|i| i.to_string() == request.params["index"]) else {
        return Ok(message(400, "Invalid recording chunk"));
    };
    let (bytes, sha) = (request.body["staged"]["bytes"].as_u64(), request.body["staged"]["sha256"].as_str());
    let (Some(bytes), Some(sha)) = (bytes, sha) else { return Ok(message(400, "Invalid recording chunk length")) };
    let Some(row) = one(host, IMPORTS, Filter::eq("id", id.as_str()))? else {
        return Ok(message(404, "Recording upload not found"));
    };
    let current = now(host)?;
    if row["ready"] == json!(true) || row["upload_reserved"] != json!(true) {
        return Ok(message(409, "Recording storage not reserved"));
    }
    if row["upload_expires_at"].as_str().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).is_some_and(|at| at.with_timezone(&Utc) <= current) {
        return Ok(message(410, "Recording upload expired"));
    }
    let manifest: Value = serde_json::from_str(row["source_manifest_json"].as_str().unwrap_or("{}")).unwrap_or(Value::Null);
    let Some(files) = manifest_files(&manifest) else { return Ok(message(409, "Recording storage not reserved")) };
    let file = &files[KINDS.iter().position(|k| *k == kind).unwrap_or(0)];
    let Ok(expected) = chunk_length(file.byte_length, index as u64) else {
        return Ok(message(400, "Invalid recording chunk"));
    };
    if bytes != expected {
        return Ok(message(400, "Invalid recording chunk length"));
    }
    lock(host, row["source_device_id"].as_str().unwrap_or_default(), row["recording_id"].as_str().unwrap_or_default())?;
    let filter = Filter::And {
        filters: vec![Filter::eq("import_id", id.as_str()), Filter::eq("kind", kind), Filter::eq("chunk_index", index)],
    };
    if let Some(stored) = one(host, CHUNKS, filter)? {
        // A resend of the same chunk is answered without writing again.
        return Ok(if stored["sha256"].as_str() == Some(sha) {
            Response::new(200, progress(host, &row, current)?)
        } else {
            code(409, RingCode::ImportConflict.as_str())
        });
    }
    host.call(
        "kv",
        "put",
        FILES,
        json!({"importId": id, "kind": kind, "index": index, "bytes": bytes, "sha256": sha}),
    )?;
    Client(host).query(
        CHUNKS,
        &Query::insert(values(vec![
            ("import_id", json!(id)),
            ("kind", json!(kind)),
            ("chunk_index", json!(index)),
            ("byte_length", json!(bytes)),
            ("sha256", json!(sha)),
        ])),
    )?;
    Ok(Response::new(200, progress(host, &row, current)?))
}

/// Chunks stored so far, per kind, as sorted index lists.
fn stored<H: Host + ?Sized>(host: &H, id: &str) -> Result<[Vec<i64>; 3]> {
    let mut query = Query::select(Filter::eq("import_id", id));
    query.limit = Some(1000);
    let mut lists: [Vec<i64>; 3] = Default::default();
    for chunk in Client(host).query(CHUNKS, &query)? {
        if let (Some(kind), Some(index)) = (chunk["kind"].as_str(), chunk["chunk_index"].as_i64()) {
            if let Some(at) = KINDS.iter().position(|k| *k == kind) {
                lists[at].push(index);
            }
        }
    }
    for list in &mut lists {
        list.sort_unstable();
    }
    Ok(lists)
}

/// `POST /recording-uploads/:id/finalize`.
pub fn finalize<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(id) = id_param(request) else { return Ok(message(400, "Invalid recording upload id")) };
    if !request.body.is_null() {
        return Ok(message(400, "This operation does not accept a body"));
    }
    let Some(row) = one(host, IMPORTS, Filter::eq("id", id.as_str()))? else {
        return Ok(message(404, "Recording upload not found"));
    };
    let current = now(host)?;
    if row["ready"] == json!(true) {
        return Ok(Response::new(200, progress(host, &row, current)?));
    }
    if row["upload_reserved"] != json!(true) {
        return Ok(message(409, "Recording storage not reserved"));
    }
    if row["upload_expires_at"].as_str().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).is_some_and(|at| at.with_timezone(&Utc) <= current) {
        return Ok(message(410, "Recording upload expired"));
    }
    let device = row["source_device_id"].as_str().unwrap_or_default();
    let recording = row["recording_id"].as_str().unwrap_or_default();
    lock(host, device, recording)?;
    let manifest: Value = serde_json::from_str(row["source_manifest_json"].as_str().unwrap_or("{}")).unwrap_or(Value::Null);
    let Some(files) = manifest_files(&manifest) else { return Ok(message(409, "Recording storage not reserved")) };
    let have = stored(host, &id)?;
    for (at, file) in files.iter().enumerate() {
        let wanted: Vec<i64> = (0..chunks_for(file) as i64).collect();
        if have[at] != wanted {
            return Ok(message(409, "Recording upload incomplete"));
        }
    }
    let verdict = host.call("kv", "validate", FILES, json!({"importId": id, "manifest": row["source_manifest_json"]}))?;
    if verdict["ok"] != json!(true) {
        let status = verdict["status"].as_u64().unwrap_or(400) as u16;
        return Ok(invalid(Invalid(status)));
    }
    let metadata = json!({
        "durationMs": verdict["durationMs"],
        "startMs": verdict["startMs"],
        "endMs": verdict["endMs"],
        "recordedDurationMs": verdict["recordedDurationMs"],
        "bookmarksMs": verdict["bookmarksMs"],
    });
    let mut fields = vec![("ready", json!(true)), ("metadata_json", metadata), ("state", json!("queued"))];
    if row["voice_enablement_id"].is_string() {
        let automatic = voice_automatic(host, &row, &verdict, current)?;
        fields.push(("voice_automatic", json!(automatic)));
    }
    let updated = Client(host).query(IMPORTS, &Query::update(Filter::eq("id", id.as_str()), values(fields)))?;
    host.call(
        "jobs",
        "enqueue-options",
        IMPORT_QUEUE,
        json!({
            "params": {"import-id": id, "kind": "transcribe", "window": 0},
            "idempotencyKey": host.call("context", "uuid", "new", json!({}))?["id"],
            "availableAt": stamp(current),
        }),
    )?;
    let row = updated.into_iter().next().unwrap_or(row);
    Ok(Response::new(200, progress(host, &row, current)?))
}

/// Whether a voice recording may dispatch on its own, from the capture time the device sent
/// and the ring's own clock.
fn voice_automatic<H: Host + ?Sized>(host: &H, row: &Value, verdict: &Value, received: DateTime<Utc>) -> Result<bool> {
    let enabled_at = match row["voice_enablement_id"].as_str() {
        Some(id) => one(host, ENABLEMENTS, Filter::eq("id", id))?.and_then(|e| millis(&e["enabled_at"])),
        None => None,
    };
    let (Some(enabled), Some(start), Some(end)) = (enabled_at, verdict["startMs"].as_i64(), verdict["endMs"].as_i64()) else {
        return Ok(false);
    };
    Ok(ring_voice::automatic(millis(&row["voice_captured_at"]), enabled, received.timestamp_millis(), start, end))
}

fn millis(value: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|at| at.timestamp_millis())
}
