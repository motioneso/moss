//! Memory screen routes: the saved-memory list, suggestions with accept, reject and suppress,
//! and fact and entity edits. SQL, the acting person and row-level security belong to the
//! host. Memory text passes through here only to be shaped for the screen.
use crate::schema::{validate, Schema};
use crate::{kv, score, Error, Result};
use moss_module_sdk::{Host, RouteRequest};
use serde_json::{json, Map, Value};

const RECORD_KINDS: &[&str] = &[
    "fact", "preference", "goal", "constraint", "decision", "relationship", "alias", "inference",
];
const SOURCE_KINDS: &[&str] = &["chat", "note", "task", "email", "calendar", "manual"];
const FACT_STATUSES: &[&str] = &["active", "stale", "conflicting", "superseded", "expired", "rejected"];
const OLD_ARGUMENTS: &str = "Accepting a suggestion adds a memory; it does not replace existing memories";
const NOT_FOUND_CANDIDATE: &str = "Candidate not found or not pending";
const TITLE_UNITS: usize = 120;
const SUMMARY_UNITS: usize = 200;

fn s() -> Schema {
    Schema::string()
}

fn checked(schema: &Schema, value: &Value, place: &str) -> Result<Value> {
    let mut value = value.clone();
    validate(schema, &mut value, place).map_err(|f| Error::new(400, f.message))?;
    Ok(value)
}

fn answer(value: Value) -> Result<Value> {
    if let Some(refused) = value.get("refused") {
        return Err(Error::new(
            refused["status"].as_u64().unwrap_or(503) as u16,
            refused["message"].as_str().unwrap_or("Memory is unavailable"),
        ));
    }
    Ok(value)
}

fn query_of(request: &RouteRequest) -> Value {
    Value::Object(request.query.clone().into_iter().collect::<Map<String, Value>>())
}

fn is_uuid(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn id_param(request: &RouteRequest, missing: &str) -> Result<String> {
    match request.params.get("id") {
        Some(id) if is_uuid(id) => Ok(id.to_ascii_lowercase()),
        _ => Err(Error::new(404, missing)),
    }
}

/// The text up to `max` UTF-16 units, cut on a character boundary, and whether it was cut.
fn clip(text: &str, max: usize) -> (String, bool) {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        if units + c.len_utf16() > max {
            return (out, true);
        }
        units += c.len_utf16();
        out.push(c);
    }
    (out, false)
}

fn manual_excerpt(payload: &Value) -> Option<String> {
    let text = payload["excerpt"].as_str()?.trim();
    (payload["manualRequest"] == true && !text.is_empty()).then(|| text.to_owned())
}

pub fn candidate_title(payload: &Value) -> String {
    if let Some(text) = manual_excerpt(payload) {
        return text;
    }
    let fact = &payload["fact"];
    let parts: Vec<&str> = [&fact["subject"], &fact["predicate"], &fact["objectText"]]
        .iter()
        .filter_map(|v| v.as_str())
        .chain(fact["objectText"].is_null().then(|| fact["objectName"].as_str()).flatten())
        .filter(|p| !p.is_empty())
        .collect();
    if !parts.is_empty() {
        return parts.join(" ");
    }
    if let Some(name) = payload["entity"]["name"].as_str() {
        return name.to_owned();
    }
    payload["summary"].as_str().unwrap_or("Memory candidate").to_owned()
}

pub fn candidate_summary(payload: &Value) -> String {
    if let Some(text) = manual_excerpt(payload) {
        return text;
    }
    if let Some(text) = payload["summary"].as_str() {
        return text.to_owned();
    }
    if let Some(text) = payload["fact"]["objectText"].as_str() {
        return text.to_owned();
    }
    candidate_title(payload)
}

/// One suggestion row with bounded text.
fn candidate_item(row: &Value) -> Value {
    let payload = &row["payload"];
    let (title, title_cut) = clip(&candidate_title(payload), TITLE_UNITS);
    let (summary, summary_cut) = clip(&candidate_summary(payload), SUMMARY_UNITS);
    let kind = payload["recordKind"]
        .as_str()
        .or_else(|| payload["fact"]["recordKind"].as_str())
        .filter(|k| RECORD_KINDS.contains(k));
    let mut item = json!({
        "id": row["id"], "title": title, "summary": summary,
        "titleTruncated": title_cut, "summaryTruncated": summary_cut,
        "provenance": row["provenance"], "createdAt": row["createdAt"], "status": row["status"]
    });
    if let Some(kind) = kind {
        item["recordKind"] = json!(kind);
    }
    item
}

pub fn candidates_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(
        &[],
        vec![
            ("cursor", s()),
            ("offset", Schema::Number),
            ("view", Schema::one_of_strings(&["pending", "history"])),
        ],
    );
    let q = checked(&schema, &query_of(request), "querystring")?;
    if !q["offset"].is_null() {
        return Err(Error::new(400, "Use cursor paging; omit cursor to start, then pass nextCursor"));
    }
    let found = answer(kv(
        host,
        "get",
        "memory.candidates",
        json!({"view": q["view"], "cursor": q["cursor"], "limit": 5}),
    )?)?;
    let items: Vec<Value> = found["items"].as_array().map(|a| a.iter().map(candidate_item).collect()).unwrap_or_default();
    let total = found["total"].as_i64().unwrap_or(0);
    Ok(json!({
        "total": total, "hasMore": found["hasMore"],
        "remainingCount": (total - items.len() as i64).max(0),
        "nextCursor": found["nextCursor"], "items": items
    }))
}

pub fn dashboard_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(
        &[],
        vec![
            ("view", Schema::one_of_strings(&["saved", "history"])),
            ("status", Schema::one_of_strings(FACT_STATUSES)),
            ("recordKind", Schema::one_of_strings(RECORD_KINDS)),
            ("sourceKind", Schema::one_of_strings(SOURCE_KINDS)),
            ("q", s()),
            ("cursor", s()),
            ("limit", Schema::Number),
        ],
    );
    let q = checked(&schema, &query_of(request), "querystring")?;
    let mut found = answer(kv(host, "get", "memory.facts", q)?)?;
    if let Some(items) = found["items"].as_array_mut() {
        for fact in items {
            fact["confidenceTier"] = json!(score::confidence_tier(fact));
        }
    }
    Ok(found)
}

pub fn decide_route(host: &impl Host, request: &RouteRequest, action: &str) -> Result<Value> {
    let schema = Schema::object(&[], vec![("reason", s())]);
    let body = checked(&schema, &request.body, "body")?;
    let id = id_param(request, NOT_FOUND_CANDIDATE)?;
    answer(kv(host, "set", "memory.candidate", json!({"action": action, "id": id, "reason": body["reason"]}))?)?;
    Ok(Value::Null)
}

pub fn accept_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let edited = Schema::object(
        &[],
        vec![
            ("summary", s()),
            ("recordKind", Schema::one_of_strings(RECORD_KINDS)),
            ("pinned", Schema::Boolean),
            ("validFrom", Schema::nullable(s())),
            ("validTo", Schema::nullable(s())),
            ("staleAt", Schema::nullable(s())),
        ],
    );
    let schema = Schema::object(
        &[],
        vec![
            ("edited", edited),
            ("resolveConflictWithFactId", Schema::nullable(s())),
            ("supersedeFactIds", Schema::nullable(Schema::Array(Box::new(s())))),
        ],
    );
    let body = checked(&schema, &request.body, "body")?;
    if !body["resolveConflictWithFactId"].is_null() || !body["supersedeFactIds"].is_null() {
        return Err(Error::new(400, OLD_ARGUMENTS));
    }
    let id = id_param(request, NOT_FOUND_CANDIDATE)?;
    let saved = answer(kv(host, "set", "memory.candidate", json!({"action": "accept", "id": id, "edited": body["edited"]}))?)?;
    let fact_id = saved["fact"]["id"].clone();
    let dates = &body["edited"];
    if ["validFrom", "validTo", "staleAt"].iter().any(|k| !dates[*k].is_null()) {
        answer(kv(
            host,
            "set",
            "memory.fact-patch",
            json!({"factId": fact_id, "validFrom": dates["validFrom"], "validTo": dates["validTo"], "staleAt": dates["staleAt"]}),
        )?)?;
    }
    let _ = (0..2).any(|_| {
        kv(host, "set", "memory.index", json!({"factId": fact_id})).is_ok_and(|done| done["indexed"] == true)
    });
    Ok(json!({"accepted": true}))
}

pub fn patch_fact_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(
        &[],
        vec![
            ("validFrom", Schema::nullable(s())),
            ("validTo", Schema::nullable(s())),
            ("staleAt", Schema::nullable(s())),
            ("pinned", Schema::Boolean),
        ],
    );
    let body = checked(&schema, &request.body, "body")?;
    let id = id_param(request, "Fact not found")?;
    let mut params = body.as_object().cloned().unwrap_or_default();
    params.insert("factId".into(), json!(id));
    answer(kv(host, "set", "memory.fact-patch", Value::Object(params))?)?;
    Ok(json!({"patched": true}))
}

pub fn patch_entity_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(
        &[],
        vec![
            ("name", s()),
            ("summary", s()),
            ("status", Schema::one_of_strings(&["active", "archived"])),
        ],
    );
    let body = checked(&schema, &request.body, "body")?;
    let id = id_param(request, "Entity not found")?;
    let mut params = body.as_object().cloned().unwrap_or_default();
    params.insert("entityId".into(), json!(id));
    answer(kv(host, "set", "memory.entity-patch", Value::Object(params))?)?;
    Ok(json!({"patched": true}))
}

pub fn delete_entity_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let id = id_param(request, "Entity not found")?;
    answer(kv(host, "set", "memory.entity-delete", json!({"entityId": id}))?)?;
    Ok(Value::Null)
}

fn predicate_for(kind: &str) -> &'static str {
    match kind {
        "preference" => "prefers",
        "goal" => "has_goal",
        "constraint" => "has_constraint",
        "decision" => "decided",
        _ => "related_to",
    }
}

/// Saves a memory the person typed in. A named subject is matched to an existing person or
/// thing, or created, and an ambiguous name is refused.
pub fn add_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let schema = Schema::object(
        &["text"],
        vec![
            ("text", s()),
            ("recordKind", Schema::one_of_strings(RECORD_KINDS)),
            ("about", s()),
            ("pinned", Schema::Boolean),
        ],
    );
    let body = checked(&schema, &request.body, "body")?;
    let text = body["text"].as_str().unwrap_or("").trim().to_owned();
    if text.is_empty() {
        return Err(Error::new(400, "Expected non-empty string"));
    }
    let kind = body["recordKind"].as_str().unwrap_or("fact");
    let about = body["about"].as_str().unwrap_or("").trim().to_owned();
    let mut params = json!({
        "predicate": predicate_for(kind), "objectText": text, "recordKind": kind,
        "confidence": 1.0, "provenance": "confirmed", "importance": 0.5,
        "pinned": body["pinned"] == true,
        "source": {"sourceKind": "manual", "sourceRef": "memory-screen",
                   "sourceLabel": "Added by you", "excerpt": text}
    });
    if !about.is_empty() {
        let found = answer(kv(host, "set", "memory.subject", json!({"name": about}))?)?;
        if let Some(id) = found["entityId"].as_str() {
            params["subjectEntityId"] = json!(id);
        }
    }
    let mut saved = answer(kv(host, "set", "memory.fact", params)?)?;
    let tier = score::confidence_tier(&saved["fact"]);
    saved["fact"]["confidenceTier"] = json!(tier);
    let id = saved["fact"]["id"].clone();
    let _ = (0..2).any(|_| kv(host, "set", "memory.index", json!({"factId": id})).is_ok_and(|d| d["indexed"] == true));
    Ok(saved)
}
