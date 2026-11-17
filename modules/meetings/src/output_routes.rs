//! Summary routes: list, read one version, generate and edit.
use crate::output_service::{self as service, Answer, Edit, Generate, Review};
use crate::output_validation::TEMPLATES;
use crate::outputs;
use crate::schema::{id_params, int_value, strict_object, Failure, Kind};
use crate::stop_summary;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

/// A history reply carries at most this many bytes of full summaries.
const HISTORY_BYTE_BUDGET: i64 = 2 * 1024 * 1024;
const HISTORY_COUNT: usize = 100;

const COUNTER: Kind = Kind::Int { min: 0, max: 2_147_483_646 };
const TEMPLATE_IDS: Kind = Kind::Enum(&["general", "one-to-one", "project-review", "interview"]);

fn answer((status, body): Answer) -> Response {
    Response::new(status, body)
}
fn invalid(failure: Failure) -> Response {
    Response::new(400, json!({"error": failure}))
}
fn missing() -> Response {
    answer(service::refuse(404, "meeting_not_found"))
}

/// Whole-number floats such as `1.0` count as integers, as they did in the old schema checks.
fn whole_numbers(body: &mut Value, keys: &[&str]) {
    for key in keys {
        if let Some(n) = body.get(*key).and_then(int_value) {
            body[*key] = json!(n);
        }
    }
}

pub fn availability<H: Host + ?Sized>(_host: &H) -> Result<Response> {
    let templates: Vec<Value> = TEMPLATES.iter().map(|t| json!({"id": t.id, "version": t.version, "name": t.name})).collect();
    // No model probe exists in this port yet, so the screen is told a model may be used.
    Ok(Response::new(200, json!({"generationAvailability": "available", "templates": templates})))
}

/// The versions whose full text goes into a history reply, newest first. `None` means the newest
/// summary alone is over budget.
fn history_versions(items: &[(i64, i64)], head: Option<i64>) -> Option<Vec<i64>> {
    let head_item = items.iter().find(|(v, _)| Some(*v) == head);
    let mut versions: Vec<i64> = head_item.map(|(v, _)| *v).into_iter().collect();
    let mut bytes = head_item.map_or(0, |(_, b)| *b);
    if bytes > HISTORY_BYTE_BUDGET {
        return None;
    }
    for (version, size) in items.iter().take(HISTORY_COUNT) {
        if Some(*version) == head || bytes + size > HISTORY_BYTE_BUDGET {
            continue;
        }
        versions.push(*version);
        bytes += size;
    }
    versions.sort_by(|a, b| b.cmp(a));
    Some(versions)
}

fn candidates<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<Vec<Value>> {
    let reply = outputs::call(host, "candidates", meeting, json!({}))?;
    Ok(reply["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|c| {
                    json!({"id": c["id"], "meetingId": meeting, "artifactVersion": c["artifactVersion"],
                        "proposal": c["proposalJson"].as_str().and_then(|t| serde_json::from_str::<Value>(t).ok()).unwrap_or(Value::Null),
                        "possibleMatchIds": c["possibleMatchIds"], "reviewState": c["reviewState"],
                        "acceptedTaskId": c["acceptedTaskId"]})
                })
                .collect()
        })
        .unwrap_or_default())
}

pub fn list<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_params(request) {
        Ok(id) => id.to_lowercase(),
        Err(f) => return Ok(invalid(f)),
    };
    let Some(now) = outputs::inputs(host, &id, false)? else { return Ok(missing()) };
    let meta = outputs::call(host, "artifacts-meta", &id, json!({}))?;
    let items: Vec<(i64, i64)> = meta["items"]
        .as_array()
        .map(|rows| rows.iter().map(|r| (r["version"].as_i64().unwrap_or(0), r["bytes"].as_i64().unwrap_or(0))).collect())
        .unwrap_or_default();
    let head = outputs::head(host, &id)?;
    let head_version = head.as_ref().and_then(|h| h["version"].as_i64());
    let Some(versions) = history_versions(&items, head_version) else {
        return Ok(answer(service::refuse(400, "meeting_output_limit")));
    };
    let mut artifacts: Vec<Value> = vec![];
    if !versions.is_empty() {
        let rows = outputs::call(host, "artifacts", &id, json!({"versions": versions}))?;
        for text in rows["items"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let mut artifact = outputs::parse(text)?;
            artifact["stale"] = json!(outputs::stale_against(&artifact, &now));
            artifacts.push(artifact);
        }
    }
    let templates: Vec<Value> = TEMPLATES
        .iter()
        .map(|t| json!({"id": t.id, "version": t.version, "name": t.name, "guidance": t.guidance()}))
        .collect();
    Ok(Response::new(
        200,
        json!({"artifacts": artifacts, "omittedArtifactCount": items.len() - artifacts.len(),
            "candidates": candidates(host, &id)?, "headVersion": head_version.unwrap_or(0),
            "automaticSummary": stop_summary::status(host, &id)?,
            "templates": templates, "generationAvailability": "available"}),
    ))
}

pub fn get<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let mut params = Value::Object(request.params.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect());
    if let Err(f) = strict_object(
        "params",
        &mut params,
        &["id", "version"],
        &[("id", Kind::Uuid), ("version", Kind::Int { min: 1, max: 1000 })],
        0,
    ) {
        return Ok(invalid(f));
    }
    let id = params["id"].as_str().unwrap_or_default().to_lowercase();
    let version = params["version"].as_i64().unwrap_or(0);
    let Some(now) = outputs::inputs(host, &id, false)? else { return Ok(missing()) };
    let Some(mut artifact) = outputs::artifact(host, &id, version)? else {
        return Ok(answer(service::refuse(404, "meeting_output_unavailable")));
    };
    artifact["stale"] = json!(outputs::stale_against(&artifact, &now));
    Ok(Response::new(200, json!({"artifact": artifact})))
}

pub fn post<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_params(request) {
        Ok(id) => id.to_lowercase(),
        Err(f) => return Ok(invalid(f)),
    };
    let mut body = request.body.clone();
    let required = [
        "requestKey",
        "expectedOutputVersion",
        "expectedTranscriptRevision",
        "expectedNotesRevision",
        "templateId",
        "templateVersion",
    ];
    if let Err(f) = strict_object(
        "body",
        &mut body,
        &required,
        &[
            ("requestKey", Kind::Uuid),
            ("expectedOutputVersion", COUNTER),
            ("expectedTranscriptRevision", COUNTER),
            ("expectedNotesRevision", COUNTER),
            ("templateId", TEMPLATE_IDS),
            ("templateVersion", Kind::IntConst(1)),
        ],
        0,
    ) {
        return Ok(invalid(f));
    }
    whole_numbers(&mut body, &["expectedOutputVersion", "expectedTranscriptRevision", "expectedNotesRevision", "templateVersion"]);
    let Ok(input) = serde_json::from_value::<Generate>(body) else {
        return Ok(answer(service::refuse(400, "meeting_output_invalid_input")));
    };
    Ok(answer(service::generate(host, &id, &input)?))
}

pub fn put<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_params(request) {
        Ok(id) => id.to_lowercase(),
        Err(f) => return Ok(invalid(f)),
    };
    let mut body = request.body.clone();
    if let Err(f) = strict_object(
        "body",
        &mut body,
        &["requestKey", "expectedOutputVersion", "content"],
        &[("requestKey", Kind::Uuid), ("expectedOutputVersion", COUNTER), ("content", Kind::Object)],
        0,
    ) {
        return Ok(invalid(f));
    }
    whole_numbers(&mut body, &["expectedOutputVersion"]);
    let Ok(input) = serde_json::from_value::<Edit>(body) else {
        return Ok(answer(service::refuse(400, "meeting_output_invalid_input")));
    };
    Ok(answer(service::edit(host, &id, &input)?))
}

pub fn review<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let mut params = Value::Object(request.params.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect());
    if let Err(f) = strict_object(
        "params",
        &mut params,
        &["id", "candidate_id"],
        &[("id", Kind::Uuid), ("candidate_id", Kind::Uuid)],
        0,
    ) {
        return Ok(invalid(f));
    }
    let id = params["id"].as_str().unwrap_or_default().to_lowercase();
    let candidate = params["candidate_id"].as_str().unwrap_or_default().to_lowercase();
    let mut body = request.body.clone();
    if let Err(f) = strict_object(
        "body",
        &mut body,
        &["requestKey", "decision"],
        &[
            ("requestKey", Kind::Uuid),
            ("decision", Kind::Enum(&["accept", "dismiss"])),
            ("title", Kind::Text { min: 1, max: 500 }),
            ("dueAt", Kind::NullableDateTime),
            ("createDespitePossibleMatches", Kind::Bool),
        ],
        0,
    ) {
        return Ok(invalid(f));
    }
    let Ok(input) = serde_json::from_value::<Review>(body) else {
        return Ok(answer(service::refuse(400, "meeting_output_invalid_input")));
    };
    Ok(answer(service::review(host, &id, &candidate, &input)?))
}
