//! Graph routes and tools: recall, core facts, entities and remembering facts. SQL, the
//! acting person and row-level security belong to the host.
use crate::schema::{validate, Schema};
use crate::{kv, score, Error, Result};
use moss_module_sdk::{Host, RouteRequest};
use serde_json::{json, Map, Value};

const PREDICATES: &[&str] = &[
    "prefers", "works_on", "has_goal", "has_constraint", "decided", "related_to", "owes",
    "waiting_on", "mentioned_in", "alias_of",
];
const RECORD_KINDS: &[&str] = &[
    "fact", "preference", "goal", "constraint", "decision", "relationship", "alias", "inference",
];
const PROVENANCE: &[&str] = &["volunteered", "inferred", "confirmed", "imported"];
const SOURCE_KINDS: &[&str] = &["chat", "note", "task", "email", "calendar", "manual"];
const ENTITY_KINDS: &[&str] = &[
    "person", "project", "preference", "goal", "constraint", "decision", "topic", "place",
    "organization", "self",
];

fn s() -> Schema {
    Schema::string()
}
fn one(values: &'static [&'static str]) -> Schema {
    Schema::one_of_strings(values)
}

fn query_schema() -> Schema {
    Schema::object(
        &["q"],
        vec![
            ("q", s()),
            ("limit", Schema::Number),
            ("includeInactive", Schema::Boolean),
            ("includeStale", Schema::Boolean),
            ("includeLowConfidence", Schema::Boolean),
        ],
    )
}

fn entity_schema() -> Schema {
    Schema::object(
        &["kind", "name"],
        vec![
            ("kind", one(ENTITY_KINDS)),
            ("name", s()),
            ("summary", s()),
            ("importance", Schema::Number),
            ("pinned", Schema::Boolean),
        ],
    )
}

fn fact_schema(route: bool) -> Schema {
    let mut source = vec![
        ("sourceKind", one(SOURCE_KINDS)),
        ("sourceRef", s()),
        ("sourceLabel", s()),
        ("excerpt", s()),
    ];
    if route {
        source.push(("occurredAt", Schema::nullable(s())));
    }
    let mut fields = vec![
        ("subjectEntityId", s()),
        ("predicate", one(PREDICATES)),
        ("confidence", Schema::Number),
        ("provenance", one(PROVENANCE)),
        ("importance", Schema::Number),
        ("pinned", Schema::Boolean),
        (
            "source",
            Schema::object(&["sourceKind", "sourceRef", "excerpt"], source),
        ),
    ];
    if route {
        fields.push(("objectEntityId", Schema::nullable(s())));
        fields.push(("objectText", Schema::nullable(s())));
        fields.push(("recordKind", one(RECORD_KINDS)));
    } else {
        fields.push(("objectEntityId", s()));
        fields.push(("objectText", s()));
    }
    Schema::object(&["predicate", "source"], fields)
}

fn recall_schema() -> Schema {
    Schema::object(&["query"], vec![("query", s()), ("limit", Schema::Number)])
}

fn invalid(message: String) -> Error {
    Error::new(400, message)
}

fn checked(schema: &Schema, value: &Value, data_var: &str) -> Result<Value> {
    let mut value = value.clone();
    validate(schema, &mut value, data_var).map_err(|f| invalid(f.message))?;
    Ok(value)
}

/// `Math.max(1, Math.trunc(Number(limit)))` when the limit is a finite number.
fn limit_from(value: &Value) -> Option<usize> {
    let n = value.as_f64().filter(|n| n.is_finite())?;
    Some(n.trunc().max(1.0).min(1e9) as usize)
}

/// A host answer that carries a refusal becomes that plain status.
fn answer(value: Value) -> Result<Value> {
    if let Some(refused) = value.get("refused") {
        return Err(Error::new(
            refused["status"].as_u64().unwrap_or(503) as u16,
            refused["message"].as_str().unwrap_or("Memory search is unavailable"),
        ));
    }
    Ok(value)
}

fn recall_items(host: &impl Host, query: &str, limit: Option<usize>, flags: (bool, bool, bool)) -> Result<Vec<Value>> {
    let found = answer(kv(
        host,
        "get",
        "memory.recall",
        json!({"query": query, "includeInactive": flags.0, "includeStale": flags.1}),
    )?)?;
    let options = score::Options {
        limit,
        include_inactive: flags.0,
        include_low_confidence: flags.2,
    };
    Ok(score::recall(query, &found, &options))
}

/// The route answer has no `subjectName`; the tool answer keeps it.
fn without_subject(mut items: Vec<Value>) -> Vec<Value> {
    for item in &mut items {
        if let Some(map) = item.as_object_mut() {
            map.remove("subjectName");
        }
    }
    items
}

pub fn recall_route(host: &impl Host, request: &RouteRequest) -> Result<Value> {
    let raw: Map<String, Value> = request.query.clone().into_iter().collect();
    let q = checked(&query_schema(), &Value::Object(raw), "querystring")?;
    let query = q["q"].as_str().unwrap_or("").trim().to_owned();
    if query.is_empty() {
        return Err(Error::new(400, "q is required"));
    }
    let flag = |name: &str| q[name] == true;
    let items = recall_items(
        host,
        &query,
        limit_from(&q["limit"]),
        (flag("includeInactive"), flag("includeStale"), flag("includeLowConfidence")),
    )?;
    Ok(json!({"query": query, "items": without_subject(items)}))
}

pub fn core_route(host: &impl Host) -> Result<Value> {
    let found = answer(kv(host, "get", "memory.core", json!({"limit": score::CORE_LIMIT}))?)?;
    Ok(json!({"query": "", "items": without_subject(score::core(&found))}))
}

pub fn entity_route(host: &impl Host, body: &Value) -> Result<Value> {
    let b = checked(&entity_schema(), body, "body")?;
    let saved = kv(
        host,
        "set",
        "memory.entity",
        json!({
            "kind": b["kind"],
            "name": b["name"],
            "summary": b.get("summary").cloned().unwrap_or(json!("")),
            "importance": b.get("importance").cloned().unwrap_or(json!(0.5)),
            "pinned": b.get("pinned").cloned().unwrap_or(json!(false)),
        }),
    )?;
    Ok(json!({"entity": saved["entity"]}))
}

fn record_kind(predicate: &str, provenance: &str) -> &'static str {
    match predicate {
        "prefers" => "preference",
        "has_goal" => "goal",
        "has_constraint" => "constraint",
        "decided" => "decision",
        "alias_of" => "alias",
        "related_to" => "relationship",
        _ if provenance == "inferred" => "inference",
        _ => "fact",
    }
}

fn truthy(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

/// Saves the fact first, then tries to store its search vector. A vector that cannot be
/// stored leaves the fact saved and sets `searchPending`.
fn remember(host: &impl Host, input: &Value) -> Result<(Value, bool)> {
    if truthy(&input["objectEntityId"]) == truthy(&input["objectText"]) {
        return Err(Error::new(400, "memory fact requires exactly one object target"));
    }
    let predicate = input["predicate"].as_str().unwrap_or("");
    let provenance = input["provenance"].as_str().unwrap_or("inferred");
    let source = &input["source"];
    let saved = kv(
        host,
        "set",
        "memory.fact",
        json!({
            "subjectEntityId": input["subjectEntityId"],
            "predicate": predicate,
            "objectEntityId": input["objectEntityId"],
            "objectText": input["objectText"],
            "recordKind": input["recordKind"].as_str()
                .unwrap_or_else(|| record_kind(predicate, provenance)),
            "confidence": input.get("confidence").cloned().unwrap_or(json!(0.6)),
            "provenance": provenance,
            "importance": input.get("importance").cloned().unwrap_or(json!(0.5)),
            "pinned": input.get("pinned").cloned().unwrap_or(json!(false)),
            "source": {
                "sourceKind": source["sourceKind"],
                "sourceRef": source["sourceRef"],
                "sourceLabel": source.get("sourceLabel").cloned().unwrap_or(json!("")),
                "occurredAt": source["occurredAt"],
                "excerpt": source["excerpt"],
            },
        }),
    )?;
    let mut fact = saved["fact"].clone();
    let tier = score::confidence_tier(&fact);
    fact["confidenceTier"] = json!(tier);
    let indexed = (0..2).any(|_| {
        kv(host, "set", "memory.index", json!({"factId": fact["id"]}))
            .is_ok_and(|done| done["indexed"] == true)
    });
    Ok((fact, !indexed))
}

pub fn fact_route(host: &impl Host, body: &Value) -> Result<Value> {
    let b = checked(&fact_schema(true), body, "body")?;
    let (fact, pending) = remember(host, &b)?;
    Ok(if pending {
        json!({"fact": fact, "searchPending": true})
    } else {
        json!({"fact": fact})
    })
}

fn required(value: &Value) -> Result<String> {
    match value.as_str().map(str::trim) {
        Some(text) if !text.is_empty() => Ok(text.to_owned()),
        _ => Err(Error::new(400, "Expected non-empty string")),
    }
}

fn optional(value: &Value) -> Value {
    match value.as_str().map(str::trim) {
        Some(text) if !text.is_empty() => json!(text),
        _ => Value::Null,
    }
}

fn finite(value: &Value) -> Value {
    if value.as_f64().is_some_and(f64::is_finite) { value.clone() } else { Value::Null }
}

pub fn recall_tool(host: &impl Host, parameters: &Value) -> Result<Value> {
    let input = checked(&recall_schema(), parameters, "body")?;
    let query = input["query"].as_str().unwrap_or("").trim().to_owned();
    if query.is_empty() {
        return Ok(json!({"data": {"query": "", "items": []}}));
    }
    let items = recall_items(host, &query, limit_from(&input["limit"]), (false, false, false))?;
    Ok(json!({"data": {"query": query, "items": items}}))
}

pub fn remember_tool(host: &impl Host, parameters: &Value) -> Result<Value> {
    let input = checked(&fact_schema(false), parameters, "body")?;
    let source = &input["source"];
    let tidy = json!({
        "subjectEntityId": optional(&input["subjectEntityId"]),
        "predicate": required(&input["predicate"])?,
        "objectEntityId": optional(&input["objectEntityId"]),
        "objectText": optional(&input["objectText"]),
        "confidence": finite(&input["confidence"]),
        "provenance": optional(&input["provenance"]),
        "importance": finite(&input["importance"]),
        "pinned": input["pinned"].as_bool().map_or(Value::Null, Value::Bool),
        "source": {
            "sourceKind": required(&source["sourceKind"])?,
            "sourceRef": required(&source["sourceRef"])?,
            "sourceLabel": optional(&source["sourceLabel"]),
            "excerpt": required(&source["excerpt"])?,
        },
    });
    // Null means "not given"; drop those keys so the defaults apply.
    let mut tidy = tidy;
    prune(&mut tidy);
    let (fact, pending) = remember(host, &tidy)?;
    let mut data = json!({"factId": fact["id"]});
    if pending {
        data["searchPending"] = json!(true);
    }
    Ok(json!({"data": data}))
}

fn prune(value: &mut Value) {
    if let Value::Object(map) = value {
        map.retain(|_, v| !v.is_null());
        map.values_mut().for_each(prune);
    }
}

/// Recall for other modules. Items keep `subjectName`, as the old in-process call returned.
pub(crate) fn recall_api(host: &impl Host, parameters: &Value) -> Result<Value> {
    let query = parameters["query"].as_str().unwrap_or("").trim().to_owned();
    if query.is_empty() {
        return Err(Error::new(400, "query is required"));
    }
    let flag = |name: &str| parameters[name] == true;
    let items = recall_items(
        host,
        &query,
        limit_from(&parameters["limit"]),
        (flag("includeInactive"), flag("includeStale"), flag("includeLowConfidence")),
    )?;
    Ok(json!({"items": items}))
}

/// Core facts for other modules, at most `limit` (default 30, maximum 100).
pub(crate) fn core_api(host: &impl Host, limit: Option<usize>) -> Result<Value> {
    let limit = limit.unwrap_or(30).min(100);
    let found = answer(kv(host, "get", "memory.core", json!({"limit": limit}))?)?;
    Ok(json!({"items": score::core(&found)}))
}
