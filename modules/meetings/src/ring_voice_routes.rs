//! Voice enablement and voice recording routes. Hold-to-talk is switched on per ring device with
//! the ids of recordings that already exist, so old recordings are never sent to Chat.
use crate::recording::code;
use crate::ring_errors::RingCode;
use crate::ring_upload::{now, stamp, ENABLEMENTS, IMPORTS, IMPORT_QUEUE};
use crate::ring_voice::parse_enablement;
use crate::text::is_uuid;
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

fn enablement_dto(row: &Value) -> Value {
    json!({
        "id": row["id"], "sourceDeviceId": row["source_device_id"],
        "enabledAt": row["enabled_at"], "disabledAt": row["disabled_at"],
    })
}

/// The import as the device and the screens see it. It never carries transcript text.
fn import_dto(row: &Value) -> Value {
    json!({
        "id": row["id"], "meetingId": row["meeting_id"], "recordingId": row["recording_id"],
        "state": row["state"], "ready": row["ready"], "code": row["code"], "retryable": row["retryable"],
        "attempts": row["attempts"], "voiceRequestId": row["voice_request_id"],
    })
}

fn id_param(request: &RouteRequest) -> Option<String> {
    request.params.get("id").filter(|id| is_uuid(id)).map(|id| id.to_lowercase())
}

fn not_found(name: RingCode) -> Response {
    code(404, name.as_str())
}

/// `POST /voice-enablement`.
pub fn enable<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some((device, key, inventory)) = parse_enablement(&request.body) else {
        return Ok(code(400, RingCode::ImportInvalid.as_str()));
    };
    let client = Client(host);
    let mut find = Query::select(Filter::eq("request_key", key.as_str()));
    find.limit = Some(1);
    if let Some(existing) = client.query(ENABLEMENTS, &find)?.into_iter().next() {
        let same = existing["source_device_id"].as_str() == Some(device.as_str())
            && crate::ring_upload::inventory_of(&existing) == inventory;
        return Ok(if same {
            Response::new(200, enablement_dto(&existing))
        } else {
            code(409, RingCode::ImportConflict.as_str())
        });
    }
    let at = stamp(now(host)?);
    // One enablement is active per device, so the older one is switched off first.
    client.query(
        ENABLEMENTS,
        &Query::update(
            Filter::And { filters: vec![Filter::eq("source_device_id", device.as_str()), Filter::Null { column: "disabled_at".into(), not: false }] },
            values(vec![("disabled_at", json!(at))]),
        ),
    )?;
    let id = host.call("context", "uuid", "new", json!({}))?["id"].clone();
    let rows = client.query(
        ENABLEMENTS,
        &Query::insert(values(vec![
            ("id", id),
            ("source_device_id", json!(device)),
            ("request_key", json!(key)),
            ("inventory_json", json!(inventory)),
            ("enabled_at", json!(at)),
        ])),
    )?;
    let row = rows.into_iter().next().ok_or_else(|| moss_module_sdk::Error::new("Enablement not stored"))?;
    Ok(Response::new(201, enablement_dto(&row)))
}

/// `POST /voice-enablement/:id/disable`.
pub fn disable<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(id) = id_param(request) else { return Ok(code(400, RingCode::ImportInvalid.as_str())) };
    if !request.body.is_null() {
        return Ok(code(400, RingCode::ImportInvalid.as_str()));
    }
    let client = Client(host);
    let mut find = Query::select(Filter::eq("id", id.as_str()));
    find.limit = Some(1);
    let Some(row) = client.query(ENABLEMENTS, &find)?.into_iter().next() else {
        return Ok(not_found(RingCode::VoiceNotFound));
    };
    if !row["disabled_at"].is_null() {
        return Ok(Response::new(200, enablement_dto(&row)));
    }
    let at = stamp(now(host)?);
    let rows = client.query(ENABLEMENTS, &Query::update(Filter::eq("id", id.as_str()), values(vec![("disabled_at", json!(at))])))?;
    Ok(Response::new(200, enablement_dto(rows.first().unwrap_or(&row))))
}

fn voice_rows<H: Host + ?Sized>(host: &H, filter: Filter, limit: u32) -> Result<Vec<Value>> {
    let mut query = Query::select(Filter::And {
        filters: vec![Filter::Null { column: "voice_enablement_id".into(), not: true }, filter],
    });
    query.order = vec![Order { column: "created_at".into(), descending: true }];
    query.limit = Some(limit);
    Client(host).query(IMPORTS, &query)
}

/// `GET /voice-recordings`.
pub fn list<H: Host + ?Sized>(host: &H, _request: &RouteRequest) -> Result<Response> {
    let rows = voice_rows(host, Filter::All, 100)?;
    Ok(Response::new(200, json!({"recordings": rows.iter().map(import_dto).collect::<Vec<_>>()})))
}

/// `GET /voice-recordings/:id`.
pub fn get<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(id) = id_param(request) else { return Ok(code(400, RingCode::ImportInvalid.as_str())) };
    Ok(match voice_rows(host, Filter::eq("id", id.as_str()), 1)?.first() {
        Some(row) => Response::new(200, import_dto(row)),
        None => not_found(RingCode::VoiceNotFound),
    })
}

/// `POST /voice-recordings/:id/retry`. Only a failed recording that may be retried starts again.
pub fn retry<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(id) = id_param(request) else { return Ok(code(400, RingCode::ImportInvalid.as_str())) };
    let Some(row) = voice_rows(host, Filter::eq("id", id.as_str()), 1)?.into_iter().next() else {
        return Ok(not_found(RingCode::VoiceNotFound));
    };
    if row["state"] != json!("failed") || row["retryable"] != json!(true) {
        return Ok(code(409, RingCode::ImportConflict.as_str()));
    }
    let rows = Client(host).query(
        IMPORTS,
        &Query::update(
            Filter::eq("id", id.as_str()),
            values(vec![
                ("state", json!("queued")), ("code", Value::Null), ("retryable", Value::Null),
                ("next_window_ms", json!(0)), ("voice_transcript", Value::Null),
            ]),
        ),
    )?;
    host.call(
        "jobs",
        "enqueue-options",
        IMPORT_QUEUE,
        json!({
            "params": {"import-id": id, "kind": "transcribe", "window": 0},
            "idempotencyKey": host.call("context", "uuid", "new", json!({}))?["id"],
            "availableAt": stamp(now(host)?),
        }),
    )?;
    Ok(Response::new(202, import_dto(rows.first().unwrap_or(&row))))
}

/// `GET /recording-imports/:id`, for meeting and voice imports alike.
pub fn import_status<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(id) = id_param(request) else { return Ok(code(400, RingCode::ImportInvalid.as_str())) };
    let mut find = Query::select(Filter::eq("id", id.as_str()));
    find.limit = Some(1);
    Ok(match Client(host).query(IMPORTS, &find)?.first() {
        Some(row) => Response::new(200, import_dto(row)),
        None => not_found(RingCode::ImportNotFound),
    })
}
