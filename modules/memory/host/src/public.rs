//! SQL for the memory public API that other modules call. The owner is always the signed-in
//! person from the call scope, never a value the caller sends, and row-level security backs
//! that up. Memory text appears only in the statements below and in embedding requests.
use crate::store;
use anyhow::{anyhow, bail, Result};
use safety_core::db::DataContext;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const SOURCE_KINDS: &[&str] = &["vault", "connector", "chat", "notes", "screen"];

fn text<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    p[name].as_str().ok_or_else(|| anyhow!("Missing {name}"))
}

pub(crate) fn source_kind(p: &Value) -> Result<&str> {
    let kind = p["sourceKind"].as_str().unwrap_or("vault");
    if !SOURCE_KINDS.contains(&kind) {
        bail!("Invalid source kind");
    }
    Ok(kind)
}

pub(crate) fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Same signature the old chat code made: sha256 of `category::normalized content`.
pub(crate) fn fact_signature(category: &str, content: &str) -> String {
    let normalized = content.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    sha256_hex(&format!("{category}::{normalized}"))
}

fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(*c as u32, 0..=8 | 0x0B | 0x0C | 0x0E..=0x1F | 0x7F))
        .collect()
}

fn chunk_json(alias: &str) -> String {
    let c = alias;
    format!(
        "jsonb_build_object('id', {c}.id::text, 'sourcePath', {c}.source_path,
           'lineStart', {c}.line_start, 'lineEnd', {c}.line_end, 'text', {c}.text,
           'updatedAt', {ua})",
        ua = store::iso(&format!("{c}.updated_at"))
    )
}

/// Chunks nearest to the embedded query, closest first.
pub async fn search_chunks(cx: &DataContext, p: &Value, vector: &str) -> Result<Value> {
    let limit = p["limit"].as_i64().unwrap_or(10).clamp(1, 50);
    let sql = format!(
        "SELECT {chunk} || jsonb_build_object('similarity', 1 - (c.embedding <=> $1::text::vector)) AS chunk
         FROM app.memory_chunks c
         WHERE c.embedding IS NOT NULL AND c.owner_user_id = app.current_actor_user_id()
           AND c.source_kind = $2
         ORDER BY c.embedding <=> $1::text::vector LIMIT $3",
        chunk = chunk_json("c")
    );
    let kind = source_kind(p)?;
    let rows = cx.db().query(&sql, &[&vector, &kind, &limit]).await?;
    let chunks: Vec<Value> = rows.iter().map(|r| r.get("chunk")).collect();
    Ok(json!({ "chunks": chunks }))
}

/// Chunks of the most recently indexed files.
pub async fn list_recent_chunks(cx: &DataContext, p: &Value) -> Result<Value> {
    let limit = p["limit"].as_i64().unwrap_or(10).clamp(1, 50);
    let sql = format!(
        "SELECT {chunk} AS chunk FROM app.memory_chunks c
         JOIN app.memory_file_index fi
           ON fi.owner_user_id = c.owner_user_id AND fi.source_kind = c.source_kind
          AND fi.source_path = c.source_path
         WHERE c.owner_user_id = app.current_actor_user_id() AND c.source_kind = $1
         ORDER BY fi.ingested_at DESC, c.line_start ASC LIMIT $2",
        chunk = chunk_json("c")
    );
    let kind = source_kind(p)?;
    let rows = cx.db().query(&sql, &[&kind, &limit]).await?;
    let chunks: Vec<Value> = rows.iter().map(|r| r.get("chunk")).collect();
    Ok(json!({ "chunks": chunks }))
}

/// One chunk with its vector already made by the host.
pub struct EmbeddedChunk {
    pub line_start: i32,
    pub line_end: i32,
    pub text: String,
    pub hash: String,
    pub vector: String,
}

pub async fn write_chunks(
    cx: &DataContext,
    kind: &str,
    path: &str,
    replace: bool,
    chunks: &[EmbeddedChunk],
    model: &(String, String),
) -> Result<()> {
    if replace {
        cx.db()
            .execute(
                "DELETE FROM app.memory_chunks
                 WHERE owner_user_id = app.current_actor_user_id()
                   AND source_path = $1 AND source_kind = $2",
                &[&path, &kind],
            )
            .await?;
    }
    for c in chunks {
        cx.db()
            .execute(
                "INSERT INTO app.memory_chunks
                   (owner_user_id, source_kind, source_path, line_start, line_end, content_hash,
                    text, embedding, embed_model_name, embed_model_version)
                 VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7::text::vector, $8, $9)",
                &[&kind, &path, &c.line_start, &c.line_end, &c.hash, &clean(&c.text), &c.vector, &model.0, &model.1],
            )
            .await?;
    }
    Ok(())
}

pub async fn upsert_file_index(
    cx: &DataContext,
    kind: &str,
    path: &str,
    file_hash: &str,
    count: i32,
    model: &(String, String),
) -> Result<()> {
    cx.db()
        .execute(
            "INSERT INTO app.memory_file_index
               (owner_user_id, source_kind, source_path, file_hash, chunk_count,
                embed_model_name, embed_model_version, ingested_at)
             VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (owner_user_id, source_kind, source_path) DO UPDATE SET
               file_hash = EXCLUDED.file_hash, chunk_count = EXCLUDED.chunk_count,
               embed_model_name = EXCLUDED.embed_model_name,
               embed_model_version = EXCLUDED.embed_model_version, ingested_at = now()",
            &[&kind, &path, &file_hash, &count, &model.0, &model.1],
        )
        .await?;
    Ok(())
}

/// The stored hash for one indexed file, if any.
pub async fn file_hash(cx: &DataContext, kind: &str, path: &str) -> Result<Option<String>> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT file_hash FROM app.memory_file_index
             WHERE owner_user_id = app.current_actor_user_id() AND source_kind = $1 AND source_path = $2",
            &[&kind, &path],
        )
        .await?
        .map(|r| r.get(0)))
}

pub async fn delete_chunks(cx: &DataContext, p: &Value) -> Result<Value> {
    let paths: Vec<String> = p["sourcePaths"]
        .as_array()
        .ok_or_else(|| anyhow!("Missing sourcePaths"))?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let kind = source_kind(p)?;
    if paths.is_empty() {
        return Ok(json!({"deleted": 0}));
    }
    let n = cx
        .db()
        .execute(
            "DELETE FROM app.memory_chunks
             WHERE owner_user_id = app.current_actor_user_id() AND source_kind = $1
               AND source_path = ANY($2::text[])",
            &[&kind, &paths],
        )
        .await?;
    Ok(json!({"deleted": n}))
}

const FACT: &str = "jsonb_build_object('id', f.id::text, 'ownerUserId', f.owner_user_id::text,
  'category', f.category, 'content', f.content, 'sourceThreadId', f.source_thread_id::text,
  'importance', f.importance::float8, 'provenance', f.provenance::text, 'status', f.status,
  'supersededAt', {sa}, 'createdAt', {ca}, 'updatedAt', {ua})";

fn fact_cols() -> String {
    FACT.replace("{sa}", &store::iso("f.superseded_at"))
        .replace("{ca}", &store::iso("f.created_at"))
        .replace("{ua}", &store::iso("f.updated_at"))
}

fn uuid(p: &Value, name: &str) -> Result<String> {
    Ok(text(p, name)?.to_owned())
}

/// Runs a legacy fact, suppression, candidate or entity call. Every statement is limited to
/// the signed-in person's rows.
pub async fn run(cx: &DataContext, name: &str, p: &Value) -> Result<Value> {
    let db = cx.db();
    match name {
        "listActiveFacts" => {
            let rows = db
                .query(
                    &format!(
                        "SELECT {} AS f FROM app.chat_memory_facts f
                         WHERE f.owner_user_id = app.current_actor_user_id() AND f.status = 'active'
                         ORDER BY f.importance DESC, f.created_at DESC",
                        fact_cols()
                    ),
                    &[],
                )
                .await?;
            Ok(json!({"facts": rows.iter().map(|r| r.get::<_, Value>("f")).collect::<Vec<_>>()}))
        }
        "getActiveFact" => {
            let id = uuid(p, "id")?;
            let row = db
                .query_opt(
                    &format!(
                        "SELECT {} AS f FROM app.chat_memory_facts f
                         WHERE f.owner_user_id = app.current_actor_user_id()
                           AND f.id = $1::text::uuid AND f.status = 'active'",
                        fact_cols()
                    ),
                    &[&id],
                )
                .await?;
            Ok(json!({"fact": row.map(|r| r.get::<_, Value>("f"))}))
        }
        "insertFact" => {
            let (category, content) = (text(p, "category")?, text(p, "content")?);
            let thread = p["sourceThreadId"].as_str();
            let importance = p["importance"].as_f64().unwrap_or(0.5);
            let provenance = p["provenance"].as_str().unwrap_or("inferred");
            let row = db
                .query_one(
                    &format!(
                        "INSERT INTO app.chat_memory_facts AS f
                           (owner_user_id, category, content, source_thread_id, importance, provenance)
                         VALUES (app.current_actor_user_id(), $1, $2, $3::text::uuid, $4::float8::numeric,
                                 $5::text::app.provenance_kind)
                         RETURNING {} AS f",
                        fact_cols()
                    ),
                    &[&category, &content, &thread, &importance, &provenance],
                )
                .await?;
            Ok(json!({"fact": row.get::<_, Value>("f")}))
        }
        "supersedeFact" => {
            let id = uuid(p, "id")?;
            db.execute(
                "UPDATE app.chat_memory_facts SET status = 'superseded', superseded_at = now(),
                   updated_at = now()
                 WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
                &[&id],
            )
            .await?;
            Ok(json!({}))
        }
        "deleteFact" => {
            let id = uuid(p, "id")?;
            let n = db
                .execute(
                    "DELETE FROM app.chat_memory_facts
                     WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
                    &[&id],
                )
                .await?;
            Ok(json!({"done": n > 0}))
        }
        "confirmFact" => {
            let id = uuid(p, "id")?;
            let n = db
                .execute(
                    "UPDATE app.chat_memory_facts SET provenance = 'confirmed', updated_at = now()
                     WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
                       AND status = 'active' AND provenance = 'inferred'",
                    &[&id],
                )
                .await?;
            Ok(json!({"done": n > 0}))
        }
        "updateFactImportance" => {
            let id = uuid(p, "id")?;
            let importance = p["importance"].as_f64().ok_or_else(|| anyhow!("Missing importance"))?;
            let n = db
                .execute(
                    "UPDATE app.chat_memory_facts SET importance = $2::float8::numeric, updated_at = now()
                     WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
                    &[&id, &importance],
                )
                .await?;
            Ok(json!({"done": n > 0}))
        }
        "rejectFact" => {
            let id = uuid(p, "id")?;
            let row = db
                .query_opt(
                    "SELECT category, content FROM app.chat_memory_facts
                     WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
                       AND status = 'active' AND provenance = 'inferred'",
                    &[&id],
                )
                .await?;
            let Some(row) = row else { return Ok(json!({"done": false})) };
            let (category, content): (String, String) = (row.get(0), row.get(1));
            let signature = fact_signature(&category, &content);
            db.execute(
                "INSERT INTO app.chat_memory_suppressions
                   (owner_user_id, signature, category, content, reason, source, before_content)
                 VALUES (app.current_actor_user_id(), $1, $2, $3, 'rejected', 'pattern-reject', $3)
                 ON CONFLICT (owner_user_id, signature) DO NOTHING",
                &[&signature, &category, &content],
            )
            .await?;
            db.execute(
                "DELETE FROM app.chat_memory_facts
                 WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
                &[&id],
            )
            .await?;
            Ok(json!({"done": true}))
        }
        "insertSuppression" => {
            let (category, content) = (text(p, "category")?, text(p, "content")?);
            let reason = p["reason"].as_str().unwrap_or("rejected");
            let signature = fact_signature(category, content);
            db.execute(
                "INSERT INTO app.chat_memory_suppressions
                   (owner_user_id, signature, category, content, reason, source, before_content)
                 VALUES (app.current_actor_user_id(), $1, $2, $3, $4, 'pattern-reject', $3)
                 ON CONFLICT (owner_user_id, signature) DO NOTHING",
                &[&signature, &category, &content, &reason],
            )
            .await?;
            Ok(json!({}))
        }
        "isSuppressed" => {
            let signature = fact_signature(text(p, "category")?, text(p, "content")?);
            let row = db
                .query_one(
                    "SELECT EXISTS (SELECT 1 FROM app.chat_memory_suppressions
                       WHERE owner_user_id = app.current_actor_user_id() AND signature = $1)",
                    &[&signature],
                )
                .await?;
            Ok(json!({"suppressed": row.get::<_, bool>(0)}))
        }
        "listCorrections" => {
            let limit = p["limit"].as_i64().unwrap_or(25).clamp(1, 100);
            let offset = p["offset"].as_i64().unwrap_or(0).max(0);
            let rows = db
                .query(
                    &format!(
                        "SELECT jsonb_build_object('id', s.id::text, 'ownerUserId', s.owner_user_id::text,
                           'signature', s.signature, 'category', s.category, 'content', s.content,
                           'reason', s.reason, 'source', s.source, 'factId', s.fact_id::text,
                           'beforeContent', s.before_content, 'afterContent', s.after_content,
                           'createdAt', {ca}) AS c
                         FROM app.chat_memory_suppressions s
                         WHERE s.owner_user_id = app.current_actor_user_id()
                         ORDER BY s.created_at DESC, s.id DESC LIMIT $1 OFFSET $2",
                        ca = store::iso("s.created_at")
                    ),
                    &[&limit, &offset],
                )
                .await?;
            Ok(json!({"corrections": rows.iter().map(|r| r.get::<_, Value>("c")).collect::<Vec<_>>()}))
        }
        "createEpisode" => {
            let row = db
                .query_one(
                    "INSERT INTO app.memory_episodes
                       (owner_user_id, source_kind, source_ref, source_label, occurred_at, excerpt)
                     VALUES (app.current_actor_user_id(), $1, $2, $3, $4::text::timestamptz, $5)
                     RETURNING id::text",
                    &[
                        &text(p, "sourceKind")?,
                        &text(p, "sourceRef")?,
                        &p["sourceLabel"].as_str().unwrap_or(""),
                        &p["occurredAt"].as_str(),
                        &text(p, "excerpt")?,
                    ],
                )
                .await?;
            let id: String = row.get(0);
            store::upsert_document(cx, "episode", &id, text(p, "excerpt")?).await?;
            Ok(json!({"id": id}))
        }
        "insertCandidate" => {
            let payload = p["payloadJson"].to_string();
            let clamp = |n: Option<f64>| match n {
                Some(n) if n.is_finite() => n.clamp(0.0, 1.0),
                _ => 0.0,
            };
            let (confidence, importance) = (clamp(p["confidence"].as_f64()), clamp(p["importance"].as_f64()));
            let row = db
                .query_one(
                    &format!(
                        "INSERT INTO app.memory_candidates AS c
                           (owner_user_id, episode_id, kind, action, payload_json, candidate_signature,
                            confidence, importance, provenance)
                         VALUES (app.current_actor_user_id(), $1::text::uuid, $2, $3, $4::text::jsonb, $5,
                                 $6::float8::numeric, $7::float8::numeric, $8)
                         ON CONFLICT (owner_user_id, candidate_signature) DO UPDATE
                           SET candidate_signature = c.candidate_signature
                         RETURNING jsonb_build_object('id', c.id::text, 'ownerUserId', c.owner_user_id::text,
                           'episodeId', c.episode_id::text, 'kind', c.kind, 'action', c.action,
                           'payloadJson', c.payload_json, 'candidateSignature', c.candidate_signature,
                           'status', c.status, 'confidence', c.confidence::float8,
                           'importance', c.importance::float8, 'provenance', c.provenance,
                           'promotionReason', c.promotion_reason, 'createdAt', {ca}, 'updatedAt', {ua},
                           'resolvedAt', {ra}) AS c",
                        ca = store::iso("c.created_at"),
                        ua = store::iso("c.updated_at"),
                        ra = store::iso("c.resolved_at"),
                    ),
                    &[
                        &p["episodeId"].as_str(),
                        &text(p, "kind")?,
                        &text(p, "action")?,
                        &payload,
                        &text(p, "candidateSignature")?,
                        &confidence,
                        &importance,
                        &text(p, "provenance")?,
                    ],
                )
                .await?;
            Ok(json!({"candidate": row.get::<_, Value>("c")}))
        }
        "findEntityByAlias" => {
            let alias = text(p, "alias")?;
            let row = db
                .query_opt(
                    "SELECT entity_id::text FROM app.memory_aliases
                     WHERE owner_user_id = app.current_actor_user_id() AND alias = $1",
                    &[&alias],
                )
                .await?;
            Ok(json!({"entityId": row.map(|r| r.get::<_, String>(0))}))
        }
        "createEntity" => store::create_entity(cx, p).await,
        "updateEntity" => {
            let (id, name, summary) = (uuid(p, "id")?, text(p, "name")?, text(p, "summary")?);
            let changed = db
                .execute(
                    "UPDATE app.memory_entities SET name = $2, summary = $3, updated_at = now()
                     WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
                    &[&id, &name, &summary],
                )
                .await?;
            if changed == 0 {
                return Ok(json!({}));
            }
            store::upsert_document(cx, "entity", &id, format!("{name} {summary}").trim()).await?;
            Ok(json!({}))
        }
        "addAlias" => {
            let (entity, alias) = (uuid(p, "entityId")?, text(p, "alias")?);
            let ambiguous = p["ambiguous"].as_bool().unwrap_or(false);
            let normalized = alias.trim().to_lowercase();
            let row = db
                .query_one(
                    "INSERT INTO app.memory_aliases
                       (owner_user_id, entity_id, alias, normalized_alias, ambiguous)
                     VALUES (app.current_actor_user_id(), $1::text::uuid, $2, $3, $4) RETURNING id::text",
                    &[&entity, &alias, &normalized, &ambiguous],
                )
                .await?;
            Ok(json!({"id": row.get::<_, String>(0)}))
        }
        "forgetEntity" => {
            let id = uuid(p, "id")?;
            db.execute(
                "UPDATE app.memory_entities SET status = 'archived', updated_at = now()
                 WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
                   AND kind <> 'self'",
                &[&id],
            )
            .await?;
            Ok(json!({}))
        }
        _ => bail!("Unknown memory public call"),
    }
}
