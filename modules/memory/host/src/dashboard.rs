//! SQL for the Memory screen: the saved-memory list, the suggestion store and its accept,
//! reject and suppress decisions, and the fact and entity edits. Every statement runs in the
//! caller's transaction under row-level security. A refusal is returned as
//! `{"refused": {"status", "message"}}` before any write, so the transaction never commits
//! half a decision. Memory text is returned to the caller only and never logged.
use crate::store::{create_fact, fact_json, upsert_document};
use anyhow::{bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Value};

const ISO: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'";
const SELF_NAMES: &[&str] = &["self", "user", "me", "myself", "i", "the user"];

fn refused(status: u16, message: &str) -> Value {
    json!({"refused": {"status": status, "message": message}})
}

fn uuid_like(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Which facts belong to a list view. `saved` is the working set, `history` is what was
/// replaced or ended.
fn view_clause(view: &str) -> &'static str {
    match view {
        "history" => "f.status IN ('superseded', 'expired', 'rejected')",
        _ => "f.status IN ('active', 'stale', 'conflicting')",
    }
}

/// The page cursor carries the sort key of the last row: pinned, importance, update time
/// (to the microsecond) and id. It holds no memory text.
fn parse_cursor(cursor: &str) -> Option<(bool, String, String, String)> {
    let parts: Vec<&str> = cursor.split('|').collect();
    let [pinned, importance, updated, id] = parts.as_slice() else {
        return None;
    };
    let number_ok = importance.parse::<f64>().is_ok_and(f64::is_finite);
    let time_ok = updated.len() == 27 && updated.ends_with('Z');
    ((*pinned == "1" || *pinned == "0") && number_ok && time_ok && uuid_like(id)).then(|| {
        (
            *pinned == "1",
            (*importance).to_owned(),
            (*updated).to_owned(),
            (*id).to_owned(),
        )
    })
}

/// A page of memories for the Memory screen plus the counts shown above the list.
async fn facts(cx: &DataContext, p: &Value) -> Result<Value> {
    let view = p["view"].as_str().unwrap_or("saved");
    let limit = p["limit"].as_i64().unwrap_or(20).clamp(1, 50);
    let q = p["q"].as_str().unwrap_or("").trim().to_owned();
    let status = p["status"].as_str().unwrap_or("").to_owned();
    let kind = p["recordKind"].as_str().unwrap_or("").to_owned();
    let source = p["sourceKind"].as_str().unwrap_or("").to_owned();
    let cursor = match p["cursor"].as_str() {
        None => None,
        Some(text) => match parse_cursor(text) {
            Some(parsed) => Some(parsed),
            None => return Ok(refused(400, "Invalid cursor")),
        },
    };
    let (c_pinned, c_importance, c_updated, c_id) = cursor.clone().unwrap_or((
        false,
        "0".to_owned(),
        "1970-01-01T00:00:00.000000Z".to_owned(),
        "00000000-0000-0000-0000-000000000000".to_owned(),
    ));
    let has_cursor = cursor.is_some();
    let like = format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let sql = format!(
        "SELECT {fact} AS fact,
                (SELECT NULLIF(name, 'Self') FROM app.memory_entities s
                  WHERE s.owner_user_id = f.owner_user_id AND s.id = f.subject_entity_id
                    AND s.kind <> 'self') AS subject_name,
                to_char(f.updated_at AT TIME ZONE 'UTC', {ISO}) AS sort_updated
         FROM app.memory_facts f
         WHERE f.owner_user_id = app.current_actor_user_id()
           AND {view}
           AND ($1 = '' OR f.status = $1)
           AND ($2 = '' OR f.record_kind = $2)
           AND ($3 = '' OR EXISTS (
                 SELECT 1 FROM app.memory_fact_sources s
                 JOIN app.memory_episodes e ON e.owner_user_id = s.owner_user_id AND e.id = s.episode_id
                 WHERE s.owner_user_id = f.owner_user_id AND s.fact_id = f.id AND e.source_kind = $3))
           AND ($4 = '' OR f.object_text ILIKE $5 OR f.predicate ILIKE $5 OR EXISTS (
                 SELECT 1 FROM app.memory_entities n
                 WHERE n.owner_user_id = f.owner_user_id AND n.id = f.subject_entity_id
                   AND n.kind <> 'self' AND n.name ILIKE $5))
           AND (NOT $6 OR f.pinned::int < $7::bool::int
                OR (f.pinned::int = $7::bool::int AND (f.importance < $8::text::numeric
                  OR (f.importance = $8::text::numeric AND (
                        date_trunc('microseconds', f.updated_at) < $9::text::timestamptz
                        OR (date_trunc('microseconds', f.updated_at) = $9::text::timestamptz
                            AND f.id > $10::text::uuid))))))
         ORDER BY f.pinned DESC, f.importance DESC, f.updated_at DESC, f.id ASC
         LIMIT $11",
        fact = fact_json("f"),
        view = view_clause(view),
    );
    let rows = cx
        .db()
        .query(
            &sql,
            &[
                &status, &kind, &source, &q, &like, &has_cursor, &c_pinned, &c_importance,
                &c_updated, &c_id, &(limit + 1),
            ],
        )
        .await?;
    let more = rows.len() as i64 > limit;
    let mut items = Vec::new();
    let mut next = Value::Null;
    for (index, row) in rows.iter().take(limit as usize).enumerate() {
        let mut fact: Value = row.get("fact");
        fact["subjectName"] = json!(row.get::<_, Option<String>>("subject_name"));
        if more && index as i64 == limit - 1 {
            let sort: String = row.get("sort_updated");
            next = json!(format!(
                "{}|{}|{}|{}",
                if fact["pinned"] == true { 1 } else { 0 },
                fact["importance"].as_f64().unwrap_or(0.0),
                sort,
                fact["id"].as_str().unwrap_or("")
            ));
        }
        items.push(fact);
    }
    Ok(json!({"items": items, "nextCursor": next, "hasMore": more, "counts": counts(cx).await?}))
}

async fn counts(cx: &DataContext) -> Result<Value> {
    let row = cx
        .db()
        .query_one(
            "SELECT
               count(*) FILTER (WHERE status IN ('active','stale','conflicting')),
               count(*) FILTER (WHERE status = 'active'),
               count(*) FILTER (WHERE status = 'stale'),
               count(*) FILTER (WHERE pinned AND status IN ('active','stale','conflicting')),
               count(*) FILTER (WHERE status IN ('superseded','expired','rejected')),
               (SELECT count(*) FROM app.memory_candidates c
                 WHERE c.owner_user_id = app.current_actor_user_id() AND c.status = 'pending')
             FROM app.memory_facts
             WHERE owner_user_id = app.current_actor_user_id()",
            &[],
        )
        .await?;
    Ok(json!({
        "saved": row.get::<_, i64>(0), "active": row.get::<_, i64>(1),
        "stale": row.get::<_, i64>(2), "pinned": row.get::<_, i64>(3),
        "history": row.get::<_, i64>(4), "pending": row.get::<_, i64>(5)
    }))
}

/// Suggestions, newest first, five at a time. `view` is `pending` or `history`. The cursor
/// is the last row's creation time to the microsecond and its id.
async fn candidates(cx: &DataContext, p: &Value) -> Result<Value> {
    let history = p["view"].as_str() == Some("history");
    let limit = p["limit"].as_i64().unwrap_or(5).clamp(1, 50);
    let (c_time, c_id, has_cursor) = match p["cursor"].as_str() {
        None => ("1970-01-01T00:00:00.000000Z".to_owned(), "00000000-0000-0000-0000-000000000000".to_owned(), false),
        Some(cursor) => match cursor.split_once('_') {
            Some((time, id)) if time.len() == 27 && time.ends_with('Z') && uuid_like(id) => {
                (time.to_owned(), id.to_owned(), true)
            }
            _ => return Ok(refused(400, "Invalid cursor")),
        },
    };
    let sql = format!(
        "SELECT c.id::text, c.kind, c.status, c.provenance, c.payload_json, c.promotion_reason,
                to_char(c.created_at AT TIME ZONE 'UTC', {ISO}) AS created
         FROM app.memory_candidates c
         WHERE c.owner_user_id = app.current_actor_user_id()
           AND (CASE WHEN $1 THEN c.status IN ('rejected', 'suppressed') ELSE c.status = 'pending' END)
           AND (NOT $2 OR (date_trunc('microseconds', c.created_at), c.id)
                < ($3::text::timestamptz, $4::text::uuid))
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT $5"
    );
    let rows = cx.db().query(&sql, &[&history, &has_cursor, &c_time, &c_id, &(limit + 1)]).await?;
    let total: i64 = cx
        .db()
        .query_one(
            "SELECT count(*) FROM app.memory_candidates
             WHERE owner_user_id = app.current_actor_user_id()
               AND (CASE WHEN $1 THEN status IN ('rejected', 'suppressed') ELSE status = 'pending' END)",
            &[&history],
        )
        .await?
        .get(0);
    let more = rows.len() as i64 > limit;
    let mut items = Vec::new();
    let mut next = Value::Null;
    for (index, row) in rows.iter().take(limit as usize).enumerate() {
        let id: String = row.get(0);
        let created: String = row.get("created");
        if more && index as i64 == limit - 1 {
            next = json!(format!("{created}_{id}"));
        }
        items.push(json!({
            "id": id, "kind": row.get::<_, String>(1), "status": row.get::<_, String>(2),
            "provenance": row.get::<_, String>(3), "payload": row.get::<_, Value>(4),
            "reason": row.get::<_, Option<String>>(5), "createdAt": created
        }));
    }
    Ok(json!({"items": items, "total": total, "hasMore": more, "nextCursor": next}))
}

/// Adds a pending suggestion. A suggestion the person already decided on keeps its status,
/// so a dismissed one does not return.
async fn add_candidate(cx: &DataContext, p: &Value) -> Result<Value> {
    let (kind, signature) = (p["kind"].as_str().unwrap_or("fact"), p["signature"].as_str().unwrap_or(""));
    if signature.is_empty() {
        bail!("Missing signature");
    }
    let (confidence, importance) = (p["confidence"].as_f64().unwrap_or(0.5), p["importance"].as_f64().unwrap_or(0.5));
    let provenance = p["provenance"].as_str().unwrap_or("inferred");
    let row = cx
        .db()
        .query_one(
            "INSERT INTO app.memory_candidates
               (owner_user_id, kind, action, payload_json, candidate_signature, confidence,
                importance, provenance)
             VALUES (app.current_actor_user_id(), $1, 'create', $2::jsonb, $3,
                     LEAST(1, GREATEST(0, $4::float8))::numeric,
                     LEAST(1, GREATEST(0, $5::float8))::numeric, $6)
             ON CONFLICT (owner_user_id, candidate_signature)
             DO UPDATE SET candidate_signature = app.memory_candidates.candidate_signature
             RETURNING id::text, status",
            &[&kind, &p["payload"], &signature, &confidence, &importance, &provenance],
        )
        .await?;
    Ok(json!({"id": row.get::<_, String>(0), "status": row.get::<_, String>(1)}))
}

/// The entity a suggestion's subject names. Zero matches creates a topic, one match is
/// used, and several matches are refused so nothing is attached to a guess.
async fn resolve_subject(cx: &DataContext, subject: &str) -> Result<std::result::Result<Option<String>, String>> {
    let name = subject.trim();
    if name.is_empty() || SELF_NAMES.contains(&name.to_lowercase().as_str()) {
        return Ok(Ok(None));
    }
    let normalized = name.to_lowercase();
    let rows = cx
        .db()
        .query(
            "SELECT e.id::text FROM app.memory_entities e
             WHERE e.owner_user_id = app.current_actor_user_id() AND e.status = 'active'
               AND e.kind <> 'self'
               AND (lower(e.name) = $1 OR EXISTS (
                     SELECT 1 FROM app.memory_aliases a
                     WHERE a.owner_user_id = e.owner_user_id AND a.entity_id = e.id
                       AND a.normalized_alias = $1))
             ORDER BY e.created_at, e.id",
            &[&normalized],
        )
        .await?;
    match rows.len() {
        0 => {
            let id: String = cx
                .db()
                .query_one(
                    "INSERT INTO app.memory_entities (owner_user_id, kind, name, summary)
                     VALUES (app.current_actor_user_id(), 'topic', $1, '') RETURNING id::text",
                    &[&name],
                )
                .await?
                .get(0);
            upsert_document(cx, "entity", &id, name).await?;
            Ok(Ok(Some(id)))
        }
        1 => Ok(Ok(Some(rows[0].get(0)))),
        _ => Ok(Err(format!(
            "More than one memory entity is named \"{name}\". Merge or rename them, then approve again."
        ))),
    }
}

fn candidate_summary(payload: &Value) -> String {
    let manual = payload["manualRequest"] == true;
    match (manual, payload["excerpt"].as_str(), payload["summary"].as_str()) {
        (true, Some(text), _) if !text.trim().is_empty() => text.trim().to_owned(),
        (_, _, Some(text)) => text.to_owned(),
        _ => payload["fact"]["objectText"].as_str().unwrap_or("").to_owned(),
    }
}

/// Accepts a pending suggestion by saving it as a confirmed memory. Refusals happen before
/// the suggestion is touched, so a refused accept changes nothing.
async fn accept(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = p["id"].as_str().unwrap_or("");
    if !uuid_like(id) {
        return Ok(refused(404, "Candidate not found or not pending"));
    }
    let Some(row) = cx
        .db()
        .query_opt(
            "SELECT payload_json FROM app.memory_candidates
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'pending' FOR UPDATE",
            &[&id],
        )
        .await?
    else {
        return Ok(refused(404, "Candidate not found or not pending"));
    };
    let payload: Value = row.get(0);
    let edited = &p["edited"];
    let fact = &payload["fact"];
    let (subject, predicate, object, kind) = if payload["kind"] == "fact" && fact.is_object() {
        let object = edited["summary"]
            .as_str()
            .or(fact["objectText"].as_str())
            .unwrap_or("")
            .to_owned();
        if object.trim().is_empty() {
            return Ok(refused(400, "Candidate objectText must not be empty"));
        }
        let subject = match resolve_subject(cx, fact["subject"].as_str().unwrap_or("")).await? {
            Ok(subject) => subject,
            Err(message) => return Ok(refused(409, &message)),
        };
        let kind = edited["recordKind"].as_str().or(fact["recordKind"].as_str()).unwrap_or("preference");
        (subject, fact["predicate"].as_str().unwrap_or("related_to").to_owned(), object, kind.to_owned())
    } else {
        let text = edited["summary"].as_str().map(str::to_owned).unwrap_or_else(|| candidate_summary(&payload));
        (None, "related_to".to_owned(), text, "preference".to_owned())
    };
    cx.db()
        .execute(
            "UPDATE app.memory_candidates
             SET status = 'promoted', promotion_reason = 'accepted via dashboard',
                 resolved_at = now(), updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&id],
        )
        .await?;
    let mut params = json!({
        "predicate": predicate, "objectText": object, "recordKind": kind,
        "confidence": 1.0, "provenance": "confirmed", "importance": 0.5,
        "pinned": edited["pinned"].as_bool().unwrap_or(false),
        "source": {"sourceKind": "manual", "sourceRef": "dashboard-review",
                   "sourceLabel": "Memory dashboard", "excerpt": ""}
    });
    if let Some(subject) = subject {
        params["subjectEntityId"] = json!(subject);
    }
    create_fact(cx, &params).await
}

/// Marks a pending suggestion rejected or suppressed. Both keep the row, so the same
/// suggestion is not offered again.
async fn decide(cx: &DataContext, p: &Value, status: &str, default_reason: &str) -> Result<Value> {
    let id = p["id"].as_str().unwrap_or("");
    let reason = p["reason"].as_str().filter(|r| !r.is_empty()).unwrap_or(default_reason);
    if !uuid_like(id) {
        return Ok(refused(404, "Candidate not found or not pending"));
    }
    let changed = cx
        .db()
        .execute(
            "UPDATE app.memory_candidates
             SET status = $2, promotion_reason = $3, resolved_at = now(), updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'pending'",
            &[&id, &status, &reason],
        )
        .await?;
    if changed == 0 {
        return Ok(refused(404, "Candidate not found or not pending"));
    }
    Ok(json!({"done": true}))
}

/// Edits the validity window or the pin of one fact.
async fn patch_fact(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = p["factId"].as_str().unwrap_or("");
    if !uuid_like(id) {
        return Ok(refused(404, "Fact not found"));
    }
    let field = |name: &str| (p.get(name).is_some(), p[name].as_str().map(str::to_owned));
    let (set_from, from) = field("validFrom");
    let (set_to, to) = field("validTo");
    let (set_stale, stale) = field("staleAt");
    let pinned = p["pinned"].as_bool();
    let row = cx
        .db()
        .query_opt(
            "UPDATE app.memory_facts SET
               valid_from = CASE WHEN $2 THEN $3::text::timestamptz ELSE valid_from END,
               valid_to = CASE WHEN $4 THEN $5::text::timestamptz ELSE valid_to END,
               stale_at = CASE WHEN $6 THEN $7::text::timestamptz ELSE stale_at END,
               pinned = COALESCE($8, pinned), updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
             RETURNING (valid_to IS NOT NULL AND valid_to <= now())",
            &[&id, &set_from, &from, &set_to, &to, &set_stale, &stale, &pinned],
        )
        .await?;
    let Some(row) = row else {
        return Ok(refused(404, "Fact not found"));
    };
    let ended: bool = row.get(0);
    let status = if set_to && ended { "inactive" } else { "active" };
    cx.db()
        .execute(
            "UPDATE app.memory_search_documents SET status = $2, updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id()
               AND target_kind = 'fact' AND target_id = $1::text::uuid",
            &[&id, &status],
        )
        .await?;
    Ok(json!({"patched": true}))
}

async fn entity_state(cx: &DataContext, id: &str) -> Result<Option<(String, String, bool)>> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT kind, name, EXISTS (SELECT 1 FROM app.memory_facts f
               WHERE f.owner_user_id = e.owner_user_id
                 AND (f.subject_entity_id = e.id OR f.object_entity_id = e.id)
                 AND f.status IN ('active', 'stale', 'conflicting'))
             FROM app.memory_entities e
             WHERE e.owner_user_id = app.current_actor_user_id() AND e.id = $1::text::uuid
             FOR UPDATE",
            &[&id],
        )
        .await?
        .map(|row| (row.get(0), row.get(1), row.get(2))))
}

async fn patch_entity(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = p["entityId"].as_str().unwrap_or("");
    if !uuid_like(id) {
        return Ok(refused(404, "Entity not found"));
    }
    let Some((kind, name, has_facts)) = entity_state(cx, id).await? else {
        return Ok(refused(404, "Entity not found"));
    };
    if kind == "self" {
        return Ok(refused(403, "The self memory entity cannot be changed"));
    }
    let status = p["status"].as_str();
    if status == Some("archived") && has_facts {
        return Ok(refused(409, "Entity has associated facts; delete facts first"));
    }
    let new_name = p["name"].as_str().unwrap_or(&name).to_owned();
    let summary = p["summary"].as_str().map(str::to_owned);
    let row = cx
        .db()
        .query_one(
            "UPDATE app.memory_entities
             SET name = $2, summary = COALESCE($3, summary), status = COALESCE($4, status),
                 updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
             RETURNING name, summary",
            &[&id, &new_name, &summary, &status],
        )
        .await?;
    let (n, s): (String, String) = (row.get(0), row.get(1));
    upsert_document(cx, "entity", id, format!("{n} {s}").trim()).await?;
    Ok(json!({"patched": true}))
}

async fn delete_entity(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = p["entityId"].as_str().unwrap_or("");
    if !uuid_like(id) {
        return Ok(refused(404, "Entity not found"));
    }
    let Some((kind, _, has_facts)) = entity_state(cx, id).await? else {
        return Ok(refused(404, "Entity not found"));
    };
    if kind == "self" {
        return Ok(refused(403, "The self memory entity cannot be changed"));
    }
    if has_facts {
        return Ok(refused(409, "Entity has associated facts; delete facts first"));
    }
    cx.db()
        .execute(
            "DELETE FROM app.memory_search_documents
             WHERE owner_user_id = app.current_actor_user_id()
               AND target_kind = 'entity' AND target_id = $1::text::uuid",
            &[&id],
        )
        .await?;
    cx.db()
        .execute(
            "DELETE FROM app.memory_entities
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&id],
        )
        .await?;
    Ok(json!({"deleted": true}))
}

pub async fn run(cx: &DataContext, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("get", "memory.facts") => facts(cx, p).await,
        ("get", "memory.candidates") => candidates(cx, p).await,
        ("set", "memory.candidate") => match p["action"].as_str() {
            Some("accept") => accept(cx, p).await,
            Some("reject") => decide(cx, p, "rejected", "rejected by user").await,
            Some("suppress") => decide(cx, p, "suppressed", "suppressed by user").await,
            Some("add") => add_candidate(cx, p).await,
            _ => bail!("Unknown candidate action"),
        },
        ("set", "memory.subject") => {
            match resolve_subject(cx, p["name"].as_str().unwrap_or("")).await? {
                Ok(id) => Ok(json!({"entityId": id})),
                Err(message) => Ok(refused(409, &message)),
            }
        }
        ("set", "memory.fact-patch") => patch_fact(cx, p).await,
        ("set", "memory.entity-patch") => patch_entity(cx, p).await,
        ("set", "memory.entity-delete") => delete_entity(cx, p).await,
        _ => bail!("Unknown memory request"),
    }
}
