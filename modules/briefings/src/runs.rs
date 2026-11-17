//! Briefing runs. A run holds the person's own briefing text, so the table is owner-only. A
//! share viewer can open a definition and sees no runs.
use crate::definitions;
use crate::queue::{self, Started};
use crate::status::{self, Facts, Resolved};
use crate::util::{bad_request, call, iso};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const TABLE: &str = "app.briefing_runs";
pub const NOT_AVAILABLE: &str = "Briefing run is missing or owned by someone else";
pub const NOT_AVAILABLE_CODE: &str = "briefing_run_not_available";
pub const IN_FLIGHT_CODE: &str = "briefing_run_in_flight";

pub(crate) fn is_fallback(metadata: &Value) -> bool {
    metadata["degraded"] == json!(true) && !metadata["aiModel"].is_object()
}

fn collapse(part: &str) -> String {
    let lowered = part.trim().to_lowercase();
    let mut out = String::new();
    let mut gap = false;
    for c in lowered.chars() {
        if c.is_whitespace() {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    out
}

pub(crate) fn short_hash(parts: &[&str]) -> String {
    let joined = parts.iter().map(|p| collapse(p)).collect::<Vec<_>>().join("|");
    let digest = Sha256::digest(joined.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn priority_band(score: &Value) -> Value {
    match score.as_f64() {
        None => Value::Null,
        Some(s) if s >= 80.0 => json!("critical"),
        Some(s) if s >= 60.0 => json!("high"),
        Some(s) if s >= 30.0 => json!("normal"),
        Some(_) => json!("low"),
    }
}

/// The stable feedback id of one stored signal.
pub(crate) fn signal_item_id(kind: &str, signal_type: &str, summary: &str) -> String {
    format!("{kind}:{signal_type}:{}", short_hash(&[kind, signal_type, summary]))
}

/// Feedback targets the stored calendar and email signals give rise to.
fn feedback_items(metadata: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    for (field, kind, label) in [("calendarSignals", "calendar", "Calendar"), ("emailSignals", "email", "Email")] {
        let Some(signals) = metadata[field].as_array() else { continue };
        for signal in signals {
            let text = |key: &str| signal[key].as_str().map(str::trim).filter(|s| !s.is_empty());
            let (Some(kind_of), Some(summary)) = (text("type"), text("summary")) else { continue };
            let mut meta = Map::new();
            meta.insert("signalType".into(), json!(kind_of));
            if !signal["followThrough"].is_null() && signal["followThrough"] != json!(false) {
                meta.insert("calendarFollowThrough".into(), signal["followThrough"].clone());
            }
            items.push(json!({
                "feedbackItemId": signal_item_id(kind, kind_of, summary),
                "targetKind": "briefing_item",
                "surface": "briefing",
                "sourceKind": kind,
                "sourceLabel": label,
                "priorityBand": priority_band(&signal["score"]),
                "metadata": meta,
            }));
        }
    }
    items
}

/// The stored payload, or the empty one for runs written before payloads existed.
fn payload_of(metadata: &Value) -> Value {
    match metadata["structuredPayload"].as_object() {
        Some(stored) => Value::Object(stored.clone()),
        None => json!({"version":1,"actionRows":[],"catchUp":null}),
    }
}

/// Catch-up entries survive only while at least one remains.
fn visible_catch_up(catch_up: &Value) -> Value {
    let entries = catch_up["entries"].as_array().cloned().unwrap_or_default();
    if !catch_up.is_object() || entries.is_empty() {
        return Value::Null;
    }
    let mut kept = catch_up.as_object().cloned().unwrap_or_default();
    kept.insert("itemCount".into(), json!(entries.len()));
    kept.insert("entries".into(), Value::Array(entries));
    Value::Object(kept)
}

pub fn dto(row: &Value) -> Result<(Value, Value)> {
    let bad = || Error::new("Invalid briefing run row");
    let text = |key: &str| row[key].as_str().map(str::to_owned).ok_or_else(bad);
    let metadata = &row["source_metadata"];
    let mut source = metadata.as_object().cloned().ok_or_else(bad)?;
    source.remove("structuredPayload");
    let mut payload = payload_of(metadata);
    payload["catchUp"] = visible_catch_up(&payload["catchUp"]);
    let summary = if is_fallback(metadata) { String::new() } else { text("summary_text")? };
    let shaped = json!({
        "id": text("id")?,
        "definitionId": text("definition_id")?,
        "ownerUserId": text("owner_user_id")?,
        "status": text("status")?,
        "runKind": text("run_kind")?,
        "briefingType": text("briefing_type")?,
        "summaryText": summary,
        "sourceMetadata": source,
        "feedbackItems": feedback_items(metadata),
        "structuredPayload": payload,
        "createdAt": iso(&row["created_at"])?,
    });
    let stored = shaped["structuredPayload"].clone();
    Ok((shaped, stored))
}

fn not_found(error: &str) -> Response {
    Response::new(404, json!({"error":error}))
}

pub(crate) fn run_rows<H: Host + ?Sized>(host: &H, definition_id: &str) -> Result<Vec<Value>> {
    let mut query = Query::select(Filter::eq("definition_id", definition_id));
    query.order = vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    Client(host).query(TABLE, &query)
}

pub fn list<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").cloned().unwrap_or_default();
    let Some(definition) = definitions::find(host, &id)? else {
        return Ok(not_found("Briefing definition not found"));
    };
    let runs = run_rows(host, definition["id"].as_str().unwrap_or_default())?
        .iter()
        .map(|row| dto(row).map(|(shaped, _)| shaped))
        .collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"runs":runs})))
}

fn missing() -> Response {
    Response::new(404, json!({"error":NOT_AVAILABLE,"code":NOT_AVAILABLE_CODE}))
}

/// What the saved day plan says now. No plan read is wired in this package yet, so the answer
/// is always "unavailable" with the revision the run stored.
fn plan_state(stored: &Value) -> Value {
    let context = &stored["planContext"];
    let revision = if context["version"] == json!(1)
        && context["planId"].is_string()
        && context["blocks"].is_array()
        && context["revision"].is_number()
    {
        context["revision"].clone()
    } else {
        Value::Null
    };
    json!({"status":"unavailable","storedRevision":revision,"currentRevision":null,"current":null})
}

pub(crate) fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn pending_state(state: &str) -> Response {
    Response::new(200, json!({"state":state,"run":null,"latest":false,"plan":null}))
}

pub fn get<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").cloned().unwrap_or_default();
    let run_id = request.params.get("run_id").cloned().unwrap_or_default();
    let Some(definition) = definitions::find(host, &id)? else { return Ok(missing()) };
    if !is_uuid(&run_id) {
        return Ok(missing());
    }
    let definition_id = definition["id"].as_str().unwrap_or_default().to_owned();
    let actor = call(host)?.actor;
    // The row is fetched by id, so it stays reachable however many newer runs exist.
    let query = Query::select(Filter::And {
        filters: vec![Filter::eq("id", run_id.as_str()), Filter::eq("definition_id", definition_id.as_str())],
    });
    let found: Vec<Value> = Client(host).query(TABLE, &query)?;
    // The row must be the caller's own run of this definition.
    let row = found.iter().find(|r| r["owner_user_id"].as_str() == Some(actor.as_str()));
    // Without a row, the caller's own queued job for this run says whether it is still coming.
    let job = match (row, request.query.get("jobId").and_then(Value::as_str)) {
        (None, Some(job_id)) if is_uuid(job_id) => queue::read_job(host, job_id)?,
        _ => None,
    };
    let mut newest = Query::select(Filter::eq("definition_id", definition_id.as_str()));
    newest.order = vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    newest.limit = Some(1);
    let first: Vec<Value> = if row.is_some() { Client(host).query(TABLE, &newest)? } else { vec![] };
    let first_id = first.first().and_then(|r| r["id"].as_str());
    let resolved = status::resolve(&Facts {
        row: row.is_some(),
        first_run_id: first_id,
        run_id: &run_id,
        definition_id: &definition_id,
        job: job.as_ref(),
    });
    match (resolved, row) {
        (Resolved::Ready { latest }, Some(row)) => {
            let (shaped, stored) = dto(row)?;
            Ok(Response::new(
                200,
                json!({"state":"ready","run":shaped,"latest":latest,"plan":plan_state(&stored)}),
            ))
        }
        (Resolved::Pending, _) => Ok(pending_state("pending")),
        (Resolved::Failed, _) => Ok(pending_state("failed")),
        _ => Ok(missing()),
    }
}

/// Queues one manual run of the caller's own definition. A repeated key while the first run is
/// still queued or running gets a 409 and no second run.
pub fn start<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let key = match crate::body::parse_run_key(&request.body) {
        Ok(key) => key,
        Err(failure) => return Ok(bad_request(failure)),
    };
    let id = request.params.get("id").cloned().unwrap_or_default();
    let actor = call(host)?.actor;
    let owned = definitions::find(host, &id)?
        .filter(|definition| definition["owner_user_id"].as_str() == Some(actor.as_str()));
    let Some(definition) = owned else { return Ok(not_found("Briefing definition not found")) };
    let kind = definition["briefing_type"].as_str().unwrap_or("morning");
    let definition_id = definition["id"].as_str().unwrap_or_default();
    Ok(match queue::start_manual(host, definition_id, kind, key.as_deref())? {
        Started::Queued { job_id, run_id } => Response::new(202, json!({"jobId":job_id,"runId":run_id})),
        Started::InFlight => Response::new(
            409,
            json!({
                "error": "A briefing run with this idempotency key is already queued or running",
                "code": IN_FLIGHT_CODE,
            }),
        ),
        Started::Failed => Response::new(500, json!({"error":"Briefing run could not be queued"})),
    })
}
