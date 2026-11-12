//! The public API other modules call. It checks each request, then asks the host to run it.
//! The signed-in person comes from the host call, so no request carries an owner or a vector.
use crate::{graph, kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const SOURCE_KINDS: &[&str] = &["vault", "connector", "chat", "notes", "screen"];
const CATEGORIES: &[&str] = &["preference", "fact", "profile", "goal"];
const PROVENANCE: &[&str] = &["volunteered", "inferred", "confirmed"];
const MAX_TEXT: usize = 64 * 1024;

fn bad(message: &str) -> Error {
    Error::new(400, message)
}

fn string<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    p[name].as_str().ok_or_else(|| bad(&format!("{name} is required")))
}

fn non_empty<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    let value = string(p, name)?;
    if value.trim().is_empty() || value.len() > MAX_TEXT {
        return Err(bad(&format!("{name} is invalid")));
    }
    Ok(value)
}

fn one_of<'a>(p: &'a Value, name: &str, allowed: &[&str], default: Option<&'a str>) -> Result<&'a str> {
    match p[name].as_str().or(default) {
        Some(v) if allowed.contains(&v) => Ok(v),
        _ => Err(bad(&format!("{name} is invalid"))),
    }
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn id<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    let value = string(p, name)?;
    if is_uuid(value) { Ok(value) } else { Err(bad(&format!("{name} is invalid"))) }
}

fn limit(p: &Value, default: i64, max: i64) -> i64 {
    p["limit"].as_f64().filter(|n| n.is_finite()).map_or(default, |n| (n.trunc() as i64).clamp(1, max))
}

fn unit(p: &Value, name: &str) -> Result<Option<f64>> {
    match p.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(n) if (0.0..=1.0).contains(&n) => Ok(Some(n)),
            _ => Err(bad(&format!("{name} must be a number between 0 and 1"))),
        },
    }
}

fn host_call(host: &impl Host, name: &str, mut params: Value) -> Result<Value> {
    params["name"] = json!(name);
    let value = kv(host, "set", "memory.public", params)?;
    if let Some(refused) = value.get("refused") {
        return Err(Error::new(
            refused["status"].as_u64().unwrap_or(503) as u16,
            refused["message"].as_str().unwrap_or("Memory search is unavailable"),
        ));
    }
    Ok(value)
}

/// Runs one public call and returns `{"ok": value}` or `{"error": {statusCode, error}}`.
pub fn call(host: &impl Host, name: &str, p: &Value) -> Value {
    match dispatch(host, name, p) {
        Ok(value) => json!({"ok": value}),
        Err(e) => json!({"error": {"statusCode": e.status, "error": e.message}}),
    }
}

fn dispatch(host: &impl Host, name: &str, p: &Value) -> Result<Value> {
    match name {
        "searchChunks" => {
            let query = non_empty(p, "query")?;
            let kind = one_of(p, "sourceKind", SOURCE_KINDS, Some("vault"))?;
            host_call(host, name, json!({"query": query, "limit": limit(p, 10, 50), "sourceKind": kind}))
        }
        "listRecentChunks" => {
            let kind = one_of(p, "sourceKind", SOURCE_KINDS, Some("vault"))?;
            host_call(host, name, json!({"limit": limit(p, 10, 50), "sourceKind": kind}))
        }
        "upsertChunks" => {
            let kind = one_of(p, "sourceKind", SOURCE_KINDS, Some("vault"))?;
            let path = non_empty(p, "sourcePath")?;
            let chunks = p["chunks"].as_array().ok_or_else(|| bad("chunks is required"))?;
            if chunks.len() > 500 {
                return Err(bad(&format!("upsertChunks accepts at most 500 chunks per call, got {}", chunks.len())));
            }
            let mut clean = Vec::new();
            for c in chunks {
                let (s, e) = (c["lineStart"].as_i64().unwrap_or(-1), c["lineEnd"].as_i64().unwrap_or(-1));
                if s < 0 || e < s {
                    return Err(bad("chunk lines are invalid"));
                }
                clean.push(json!({"lineStart": s, "lineEnd": e, "text": non_empty(c, "text")?,
                                  "contentHash": c["contentHash"]}));
            }
            host_call(host, name, json!({"sourceKind": kind, "sourcePath": path, "chunks": clean,
                                         "replaceExisting": p["replaceExisting"].as_bool().unwrap_or(true)}))
        }
        "deleteChunksForSources" => {
            let kind = one_of(p, "sourceKind", SOURCE_KINDS, None)?;
            let paths = p["sourcePaths"].as_array().ok_or_else(|| bad("sourcePaths is required"))?;
            if paths.len() > 500 {
                return Err(bad(&format!(
                    "deleteChunksForSources accepts at most 500 source paths per call, got {}",
                    paths.len()
                )));
            }
            if paths.iter().any(|v| !v.is_string()) {
                return Err(bad("sourcePaths is invalid"));
            }
            host_call(host, name, json!({"sourceKind": kind, "sourcePaths": paths}))
        }
        "embedTurn" => {
            let thread = id(p, "threadId")?;
            let (user, assistant) = (string(p, "userText")?, string(p, "assistantText")?);
            if user.len() + assistant.len() > MAX_TEXT {
                return Err(bad("turn is too long"));
            }
            host_call(host, name, json!({"threadId": thread, "userText": user, "assistantText": assistant}))
        }
        "recallMemory" => graph::recall_api(host, p),
        "listCoreFacts" => graph::core_api(host, p["limit"].as_f64().map(|n| n.trunc().max(1.0) as usize)),
        "listActiveFacts" => host_call(host, name, json!({})),
        "getActiveFact" | "deleteFact" | "confirmFact" | "supersedeFact" | "rejectFact" => {
            host_call(host, name, json!({"id": id(p, "id")?}))
        }
        "insertFact" => {
            let category = one_of(p, "category", CATEGORIES, None)?;
            let content = non_empty(p, "content")?;
            let provenance = one_of(p, "provenance", PROVENANCE, Some("inferred"))?;
            let thread = match p["sourceThreadId"].as_str() {
                Some(t) if is_uuid(t) => json!(t),
                Some(_) => return Err(bad("sourceThreadId is invalid")),
                None => Value::Null,
            };
            host_call(host, name, json!({"category": category, "content": content, "provenance": provenance,
                "sourceThreadId": thread, "importance": unit(p, "importance")?.unwrap_or(0.5)}))
        }
        "updateFactImportance" => {
            let importance = p["importance"].as_f64().filter(|n| (0.0..=1.0).contains(n));
            let importance = importance.ok_or_else(|| bad("importance must be a number between 0 and 1"))?;
            host_call(host, name, json!({"id": id(p, "id")?, "importance": importance}))
        }
        "insertSuppression" | "isSuppressed" => {
            let category = one_of(p, "category", CATEGORIES, None)?;
            let content = non_empty(p, "content")?;
            let reason = one_of(p, "reason", &["rejected", "corrected"], Some("rejected"))?;
            host_call(host, name, json!({"category": category, "content": content, "reason": reason}))
        }
        "listCorrections" => {
            let offset = p["offset"].as_f64().filter(|n| n.is_finite()).map_or(0, |n| (n.trunc() as i64).max(0));
            host_call(host, name, json!({"limit": limit(p, 25, 100), "offset": offset}))
        }
        "createEpisode" => {
            let kind = one_of(p, "sourceKind", &["chat", "note", "task", "email", "calendar", "manual"], None)?;
            host_call(host, name, json!({"sourceKind": kind, "sourceRef": non_empty(p, "sourceRef")?,
                "sourceLabel": p["sourceLabel"].as_str().unwrap_or(""), "occurredAt": p["occurredAt"],
                "excerpt": non_empty(p, "excerpt")?}))
        }
        "insertCandidate" => {
            let kind = one_of(p, "kind", &["entity", "fact", "alias", "supersession", "conflict"], None)?;
            let action = one_of(p, "action", &["create", "update", "link", "supersede", "reject"], None)?;
            let provenance = one_of(p, "provenance", &["volunteered", "inferred"], None)?;
            let episode = match p["episodeId"].as_str() {
                Some(e) if is_uuid(e) => json!(e),
                Some(_) => return Err(bad("episodeId is invalid")),
                None => Value::Null,
            };
            host_call(host, name, json!({"episodeId": episode, "kind": kind, "action": action,
                "payloadJson": p["payloadJson"], "candidateSignature": non_empty(p, "candidateSignature")?,
                "confidence": p["confidence"].as_f64().unwrap_or(0.0),
                "importance": p["importance"].as_f64().unwrap_or(0.0), "provenance": provenance}))
        }
        "findEntityByAlias" => host_call(host, name, json!({"alias": non_empty(p, "alias")?})),
        "createEntity" => {
            let kind = one_of(p, "kind", &["person", "project", "preference", "goal", "constraint",
                "decision", "topic", "place", "organization"], None)?;
            host_call(host, name, json!({"kind": kind, "name": non_empty(p, "name")?,
                "summary": p["summary"].as_str().unwrap_or(""),
                "importance": unit(p, "importance")?.unwrap_or(0.5),
                "pinned": p["pinned"].as_bool().unwrap_or(false)}))
        }
        "updateEntity" => host_call(host, name, json!({"id": id(p, "id")?, "name": non_empty(p, "name")?,
            "summary": string(p, "summary")?})),
        "addAlias" => host_call(host, name, json!({"entityId": id(p, "entityId")?, "alias": non_empty(p, "alias")?,
            "ambiguous": p["ambiguous"].as_bool().unwrap_or(false)})),
        "forgetEntity" => host_call(host, name, json!({"id": id(p, "id")?})),
        _ => Err(Error::new(404, "Memory public call not found")),
    }
}
