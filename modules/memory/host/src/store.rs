//! SQL for the `memory.*` resources. Every statement runs in the caller's transaction, so
//! row-level security decides what is visible and writable. Vectors are produced and stored
//! here only; the package never sees one.
use anyhow::{anyhow, bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Value};

const ISO: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

fn iso(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', {ISO})")
}

/// One fact in the shape the old server serialized, with its sources. `alias` names the
/// facts table in the surrounding query.
pub fn fact_json(alias: &str) -> String {
    let f = alias;
    format!(
        "jsonb_build_object(
           'id', {f}.id::text, 'ownerUserId', {f}.owner_user_id::text,
           'subjectEntityId', {f}.subject_entity_id::text, 'predicate', {f}.predicate,
           'objectEntityId', {f}.object_entity_id::text, 'objectText', {f}.object_text,
           'recordKind', {f}.record_kind, 'confidence', {f}.confidence,
           'provenance', {f}.provenance, 'status', {f}.status,
           'validFrom', {vf}, 'validTo', {vt}, 'staleAt', {sa},
           'supersededByFactId', {f}.superseded_by_fact_id::text,
           'conflictGroupId', {f}.conflict_group_id::text,
           'lastConfirmedAt', {lc}, 'importance', {f}.importance, 'pinned', {f}.pinned,
           'createdAt', {ca}, 'updatedAt', {ua},
           'sources', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', e.id::text, 'sourceKind', e.source_kind, 'sourceRef', e.source_ref,
                      'sourceLabel', e.source_label, 'excerpt', e.excerpt,
                      'occurredAt', {eo})
                    ORDER BY e.occurred_at DESC NULLS LAST, e.created_at DESC)
             FROM app.memory_episodes e
             JOIN app.memory_fact_sources s
               ON s.owner_user_id = e.owner_user_id AND s.episode_id = e.id
             WHERE s.owner_user_id = {f}.owner_user_id AND s.fact_id = {f}.id), '[]'::jsonb))",
        vf = iso(&format!("{f}.valid_from")),
        vt = iso(&format!("{f}.valid_to")),
        sa = iso(&format!("{f}.stale_at")),
        lc = iso(&format!("{f}.last_confirmed_at")),
        ca = iso(&format!("{f}.created_at")),
        ua = iso(&format!("{f}.updated_at")),
        eo = iso("e.occurred_at"),
    )
}

const ELIGIBLE: &str = "(f.recording_side IS NULL
  OR app.memory_recording_fact_eligible(f.owner_user_id, f.id, f.recording_side))";

fn text<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    p[name].as_str().ok_or_else(|| anyhow!("Missing {name}"))
}
fn opt<'a>(p: &'a Value, name: &str) -> Option<&'a str> {
    p[name].as_str()
}
fn number(p: &Value, name: &str) -> Result<f64> {
    p[name].as_f64().ok_or_else(|| anyhow!("Missing {name}"))
}

/// Names of the non-self entities among `ids`, keyed by entity id.
async fn names(cx: &DataContext, ids: &[String]) -> Result<Value> {
    let mut map = serde_json::Map::new();
    if ids.is_empty() {
        return Ok(Value::Object(map));
    }
    for row in cx
        .db()
        .query(
            "SELECT id::text, name FROM app.memory_entities
             WHERE owner_user_id = app.current_actor_user_id() AND kind <> 'self'
               AND id = ANY($1::text[]::uuid[])",
            &[&ids],
        )
        .await?
    {
        map.insert(row.get(0), Value::String(row.get(1)));
    }
    Ok(Value::Object(map))
}

fn subject_ids(facts: &[&Value]) -> Vec<String> {
    let mut ids: Vec<String> = facts
        .iter()
        .filter_map(|f| f["subjectEntityId"].as_str().map(str::to_owned))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Up to 100 facts that could answer a query, each with its search text and how close its
/// stored vector is to the query vector. `vector` is the embedded query.
pub async fn recall(cx: &DataContext, p: &Value, vector: &str, model: &str) -> Result<Value> {
    let inactive = p["includeInactive"].as_bool().unwrap_or(false);
    let stale = p["includeStale"].as_bool().unwrap_or(false);
    let sql = format!(
        "SELECT {fact} AS fact, d.search_text,
                (CASE WHEN d.embedding IS NULL OR d.embed_model_name IS DISTINCT FROM $4 THEN 0
                      ELSE 1 - (d.embedding <=> $1::text::vector) END)::float8 AS similarity,
                floor(extract(epoch FROM now()) * 1000)::float8 AS now_ms
         FROM app.memory_facts f
         LEFT JOIN app.memory_search_documents d
           ON d.owner_user_id = f.owner_user_id AND d.target_kind = 'fact' AND d.target_id = f.id
          AND ($2::bool OR d.status = 'active')
         WHERE f.owner_user_id = app.current_actor_user_id()
           AND {ELIGIBLE}
           AND (f.valid_from IS NULL OR f.valid_from <= now())
           AND ($2::bool OR (
                 (f.status IN ('active', 'conflicting') OR ($3::bool AND f.status = 'stale'))
                 AND (f.valid_to IS NULL OR f.valid_to > now())
                 AND ($3::bool OR f.stale_at IS NULL OR f.stale_at > now())))
         ORDER BY f.pinned DESC, f.importance DESC, f.updated_at DESC
         LIMIT 100",
        fact = fact_json("f"),
    );
    let rows = cx.db().query(&sql, &[&vector, &inactive, &stale, &model]).await?;
    let mut now_ms = 0.0;
    let mut candidates = Vec::new();
    for row in &rows {
        now_ms = row.get("now_ms");
        let fact: Value = row.get("fact");
        let search: Option<String> = row.get("search_text");
        let similarity: f64 = row.get("similarity");
        candidates.push(json!({"fact": fact, "searchText": search, "similarity": similarity}));
    }
    if rows.is_empty() {
        now_ms = cx
            .db()
            .query_one(
                "SELECT floor(extract(epoch FROM now()) * 1000)::float8",
                &[],
            )
            .await?
            .get(0);
    }
    let facts: Vec<&Value> = candidates.iter().map(|c| &c["fact"]).collect();
    let names = names(cx, &subject_ids(&facts)).await?;
    Ok(json!({"nowMs": now_ms, "candidates": candidates, "names": names}))
}

/// The always-relevant facts, newest confirmation first.
pub async fn core(cx: &DataContext, p: &Value) -> Result<Value> {
    let limit = p["limit"].as_i64().unwrap_or(20).clamp(1, 100);
    let sql = format!(
        "SELECT {fact} AS fact,
                floor(extract(epoch FROM now()) * 1000)::float8 AS now_ms
         FROM app.memory_facts f
         WHERE f.owner_user_id = app.current_actor_user_id()
           AND {ELIGIBLE}
           AND f.status = 'active'
           AND (f.valid_to IS NULL OR f.valid_to > now())
           AND (f.stale_at IS NULL OR f.stale_at > now())
           AND ((f.pinned = true AND f.confidence >= 0.70)
                OR f.provenance = 'confirmed' OR f.confidence >= 0.80)
         ORDER BY f.pinned DESC, f.importance DESC, f.last_confirmed_at DESC NULLS LAST,
                  f.updated_at DESC
         LIMIT $1",
        fact = fact_json("f"),
    );
    let rows = cx.db().query(&sql, &[&limit]).await?;
    let facts: Vec<Value> = rows.iter().map(|r| r.get("fact")).collect();
    let refs: Vec<&Value> = facts.iter().collect();
    let names = names(cx, &subject_ids(&refs)).await?;
    Ok(json!({"facts": facts, "names": names}))
}

pub(crate) async fn upsert_document(
    cx: &DataContext,
    kind: &str,
    target: &str,
    search: &str,
) -> Result<()> {
    cx.db()
        .execute(
            "INSERT INTO app.memory_search_documents
               (owner_user_id, target_kind, target_id, search_text, embedding,
                embed_model_name, embed_model_version, status, updated_at)
             VALUES (app.current_actor_user_id(), $1, $2::text::uuid, $3, NULL, NULL, NULL,
                     'active', now())
             ON CONFLICT (owner_user_id, target_kind, target_id) DO UPDATE SET
               search_text = EXCLUDED.search_text, embedding = EXCLUDED.embedding,
               embed_model_name = EXCLUDED.embed_model_name,
               embed_model_version = EXCLUDED.embed_model_version,
               status = 'active', updated_at = now()",
            &[&kind, &target, &search],
        )
        .await?;
    Ok(())
}

pub async fn create_entity(cx: &DataContext, p: &Value) -> Result<Value> {
    let (kind, name, summary) = (text(p, "kind")?, text(p, "name")?, text(p, "summary")?);
    let importance = number(p, "importance")?;
    let pinned = p["pinned"].as_bool().unwrap_or(false);
    let sql = format!(
        "INSERT INTO app.memory_entities (owner_user_id, kind, name, summary, importance, pinned)
         VALUES (app.current_actor_user_id(), $1, $2, $3, $4::float8::numeric, $5)
         RETURNING jsonb_build_object(
           'id', id::text, 'ownerUserId', owner_user_id::text, 'kind', kind, 'name', name,
           'summary', summary, 'status', status, 'importance', importance, 'pinned', pinned,
           'createdAt', {created}, 'updatedAt', {updated}) AS entity, id::text",
        created = iso("created_at"),
        updated = iso("updated_at"),
    );
    let row = cx
        .db()
        .query_one(&sql, &[&kind, &name, &summary, &importance, &pinned])
        .await?;
    let entity: Value = row.get("entity");
    let id: String = row.get(1);
    upsert_document(cx, "entity", &id, format!("{name} {summary}").trim()).await?;
    Ok(json!({"entity": entity}))
}

pub(crate) async fn ensure_self(cx: &DataContext) -> Result<String> {
    cx.db()
        .execute(
            "INSERT INTO app.memory_entities (owner_user_id, kind, name, summary)
             VALUES (app.current_actor_user_id(), 'self', 'Self', 'Owner self memory root')
             ON CONFLICT (owner_user_id) WHERE kind = 'self' DO NOTHING",
            &[],
        )
        .await?;
    let row = cx
        .db()
        .query_opt(
            "SELECT id::text FROM app.memory_entities
             WHERE owner_user_id = app.current_actor_user_id() AND kind = 'self'",
            &[],
        )
        .await?
        .ok_or_else(|| anyhow!("self memory entity was not created"))?;
    Ok(row.get(0))
}

/// Saves the fact, its episode, the link and both search documents (without vectors) in one
/// transaction. Embedding happens afterwards so a failed embedding never loses the fact.
pub async fn create_fact(cx: &DataContext, p: &Value) -> Result<Value> {
    let subject = match opt(p, "subjectEntityId") {
        Some(id) => id.to_owned(),
        None => ensure_self(cx).await?,
    };
    let source = &p["source"];
    let (predicate, record_kind, provenance) = (
        text(p, "predicate")?,
        text(p, "recordKind")?,
        text(p, "provenance")?,
    );
    let (confidence, importance) = (number(p, "confidence")?, number(p, "importance")?);
    let pinned = p["pinned"].as_bool().unwrap_or(false);
    let object_entity = opt(p, "objectEntityId");
    let object_text = opt(p, "objectText");
    let fact_id: String = cx
        .db()
        .query_one(
            "INSERT INTO app.memory_facts
               (owner_user_id, subject_entity_id, predicate, object_entity_id, object_text,
                record_kind, confidence, provenance, importance, pinned)
             VALUES (app.current_actor_user_id(), $1::text::uuid, $2, $3::text::uuid, $4, $5,
                     $6::float8::numeric, $7, $8::float8::numeric, $9)
             RETURNING id::text",
            &[
                &subject,
                &predicate,
                &object_entity,
                &object_text,
                &record_kind,
                &confidence,
                &provenance,
                &importance,
                &pinned,
            ],
        )
        .await?
        .get(0);
    let excerpt = text(source, "excerpt")?;
    let episode_id: String = cx
        .db()
        .query_one(
            "INSERT INTO app.memory_episodes
               (owner_user_id, source_kind, source_ref, source_label, occurred_at, excerpt)
             VALUES (app.current_actor_user_id(), $1, $2, $3, $4::text::timestamptz, $5)
             RETURNING id::text",
            &[
                &text(source, "sourceKind")?,
                &text(source, "sourceRef")?,
                &text(source, "sourceLabel")?,
                &opt(source, "occurredAt"),
                &excerpt,
            ],
        )
        .await?
        .get(0);
    cx.db()
        .execute(
            "INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id)
             VALUES (app.current_actor_user_id(), $1::text::uuid, $2::text::uuid)",
            &[&fact_id, &episode_id],
        )
        .await?;
    let subject_name = names(cx, std::slice::from_ref(&subject)).await?[&subject]
        .as_str()
        .map(str::to_owned);
    let search = [subject_name.as_deref(), Some(predicate), object_text]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    upsert_document(cx, "fact", &fact_id, &search).await?;
    upsert_document(cx, "episode", &episode_id, excerpt).await?;
    let sql = format!(
        "SELECT {} FROM app.memory_facts f WHERE f.id = $1::text::uuid",
        fact_json("f")
    );
    let fact: Value = cx.db().query_one(&sql, &[&fact_id]).await?.get(0);
    Ok(json!({"fact": fact}))
}

/// The text still waiting for a vector on one fact, if any.
pub async fn pending_text(cx: &DataContext, fact_id: &str) -> Result<Option<String>> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT search_text FROM app.memory_search_documents
             WHERE owner_user_id = app.current_actor_user_id()
               AND target_kind = 'fact' AND target_id = $1::text::uuid AND status = 'active'",
            &[&fact_id],
        )
        .await?
        .map(|row| row.get(0)))
}

/// Stores a vector, but only while the document still holds the text that was embedded.
pub async fn store_vector(
    cx: &DataContext,
    fact_id: &str,
    search: &str,
    vector: &str,
    model: &(String, String),
) -> Result<bool> {
    let changed = cx
        .db()
        .execute(
            "UPDATE app.memory_search_documents
             SET embedding = $1::text::vector, embed_model_name = $2, embed_model_version = $3,
                 updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id()
               AND target_kind = 'fact' AND target_id = $4::text::uuid AND search_text = $5",
            &[&vector, &model.0, &model.1, &fact_id, &search],
        )
        .await?;
    Ok(changed == 1)
}

pub async fn run(cx: &DataContext, request: &Request, vector: Option<&str>) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("get", "memory.recall") => {
            recall(cx, p, vector.ok_or_else(|| anyhow!("Missing vector"))?, p["model"].as_str().unwrap_or("")).await
        }
        ("get", "memory.core") => core(cx, p).await,
        ("set", "memory.entity") => create_entity(cx, p).await,
        ("set", "memory.fact") => create_fact(cx, p).await,
        _ => bail!("Unknown memory request"),
    }
}
