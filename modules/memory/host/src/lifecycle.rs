//! SQL for the fact lifecycle: pin, confirm, correct, status, supersede and delete, plus the
//! approval target and version used by the forget tool. Every statement runs in the caller's
//! transaction under row-level security, so one person's call never reaches another's rows.
//! A refusal is returned as `{"refused": {"status", "message"}}` for the guest to turn into
//! a plain status.
use crate::store::{fact_json, upsert_document};
use anyhow::{anyhow, bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Value};

const NOT_FOUND: &str = "Memory fact not found";
const RECORDING_CHANGED: &str =
    "This recording's memory has changed or is being removed; refresh its saved state before continuing";

fn refused(status: u16, message: &str) -> Value {
    json!({"refused": {"status": status, "message": message}})
}

fn id_of(p: &Value) -> Result<&str> {
    p["factId"].as_str().ok_or_else(|| anyhow!("Missing factId"))
}

struct Existing {
    group: Option<String>,
    superseded_by: Option<String>,
}

async fn existing(cx: &DataContext, id: &str) -> Result<Option<Existing>> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT conflict_group_id::text, superseded_by_fact_id::text
             FROM app.memory_facts
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
             FOR UPDATE",
            &[&id],
        )
        .await?
        .map(|row| Existing {
            group: row.get(0),
            superseded_by: row.get(1),
        }))
}

/// True when the fact or any fact in its conflict group belongs to a recording. Those are
/// owned by the meetings feature, which is not part of this server, so they are not changed.
async fn recording_managed(cx: &DataContext, id: &str) -> Result<bool> {
    Ok(cx
        .db()
        .query_one(
            "SELECT EXISTS (
               SELECT 1 FROM app.memory_facts f
               JOIN app.memory_recording_fact_versions v
                 ON v.owner_user_id = f.owner_user_id AND v.fact_id = f.id
               WHERE f.owner_user_id = app.current_actor_user_id()
                 AND (f.id = $1::text::uuid
                   OR (f.conflict_group_id IS NOT NULL AND f.conflict_group_id = (
                         SELECT g.conflict_group_id FROM app.memory_facts g
                         WHERE g.owner_user_id = app.current_actor_user_id()
                           AND g.id = $1::text::uuid))))",
            &[&id],
        )
        .await?
        .get(0))
}

async fn fact(cx: &DataContext, id: &str) -> Result<Value> {
    let sql = format!(
        "SELECT {} FROM app.memory_facts f
         WHERE f.owner_user_id = app.current_actor_user_id() AND f.id = $1::text::uuid",
        fact_json("f")
    );
    Ok(cx.db().query_one(&sql, &[&id]).await?.get(0))
}

async fn document_status(cx: &DataContext, ids: &[String], status: &str) -> Result<()> {
    cx.db()
        .execute(
            "UPDATE app.memory_search_documents SET status = $2, updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND target_kind = 'fact'
               AND target_id = ANY($1::text[]::uuid[])",
            &[&ids, &status],
        )
        .await?;
    Ok(())
}

async fn resolve_group(cx: &DataContext, group: &str) -> Result<()> {
    cx.db()
        .execute(
            "UPDATE app.memory_conflict_groups SET status = 'resolved', resolved_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&group],
        )
        .await?;
    Ok(())
}

/// Marks `ids` superseded by `by` and returns them.
async fn supersede_ids(cx: &DataContext, ids: &[String], by: &str) -> Result<()> {
    cx.db()
        .execute(
            "UPDATE app.memory_facts
             SET status = 'superseded', superseded_by_fact_id = $2::text::uuid,
                 valid_to = COALESCE(valid_to, now()), updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id()
               AND id = ANY($1::text[]::uuid[])",
            &[&ids, &by],
        )
        .await?;
    Ok(())
}

async fn group_ids(cx: &DataContext, group: &str, except: Option<&str>) -> Result<Vec<String>> {
    Ok(cx
        .db()
        .query(
            "SELECT id::text FROM app.memory_facts
             WHERE owner_user_id = app.current_actor_user_id()
               AND conflict_group_id = $1::text::uuid
               AND ($2::text IS NULL OR id <> $2::text::uuid)",
            &[&group, &except],
        )
        .await?
        .iter()
        .map(|row| row.get(0))
        .collect())
}

async fn pin(cx: &DataContext, p: &Value) -> Result<Value> {
    let pinned = p["pinned"].as_bool().unwrap_or(false);
    let changed = cx
        .db()
        .execute(
            "UPDATE app.memory_facts SET pinned = $2, updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&id_of(p)?, &pinned],
        )
        .await?;
    Ok(if changed == 0 { refused(404, NOT_FOUND) } else { json!({"ok": true}) })
}

async fn supersede(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = id_of(p)?;
    if existing(cx, id).await?.is_none() {
        return Ok(refused(404, NOT_FOUND));
    }
    if recording_managed(cx, id).await? {
        return Ok(refused(409, RECORDING_CHANGED));
    }
    let valid_to = p["validTo"].as_str();
    cx.db()
        .execute(
            "UPDATE app.memory_facts
             SET status = 'superseded', valid_to = COALESCE($2::text::timestamptz, now()),
                 updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&id, &valid_to],
        )
        .await?;
    document_status(cx, &[id.to_owned()], "inactive").await?;
    Ok(json!({"ok": true}))
}

async fn set_status(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = id_of(p)?;
    let status = p["status"].as_str().ok_or_else(|| anyhow!("Missing status"))?;
    let Some(found) = existing(cx, id).await? else {
        return Ok(refused(404, NOT_FOUND));
    };
    if found.group.is_some() {
        return Ok(refused(400, "conflict-group memory must be resolved with confirm or correct"));
    }
    if found.superseded_by.is_some() && status == "active" {
        return Ok(refused(
            400,
            "Cannot reactivate a superseded memory record; create a new fact instead",
        ));
    }
    if recording_managed(cx, id).await? {
        return Ok(refused(409, RECORDING_CHANGED));
    }
    cx.db()
        .execute(
            "UPDATE app.memory_facts
             SET status = $2,
                 stale_at = CASE WHEN $2 = 'stale' THEN now() ELSE stale_at END,
                 valid_to = CASE WHEN $2 = 'expired' THEN COALESCE(valid_to, now()) ELSE valid_to END,
                 updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&id, &status],
        )
        .await?;
    let search = if matches!(status, "expired" | "rejected") { "inactive" } else { "active" };
    document_status(cx, &[id.to_owned()], search).await?;
    Ok(json!({"fact": fact(cx, id).await?}))
}

async fn confirm(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = id_of(p)?;
    let Some(found) = existing(cx, id).await? else {
        return Ok(refused(404, NOT_FOUND));
    };
    if recording_managed(cx, id).await? {
        return Ok(refused(409, RECORDING_CHANGED));
    }
    if let Some(group) = &found.group {
        let siblings = group_ids(cx, group, Some(id)).await?;
        supersede_ids(cx, &siblings, id).await?;
        resolve_group(cx, group).await?;
        document_status(cx, &siblings, "inactive").await?;
    }
    cx.db()
        .execute(
            "UPDATE app.memory_facts
             SET provenance = 'confirmed', confidence = GREATEST(confidence, 0.90),
                 status = 'active', conflict_group_id = NULL,
                 last_confirmed_at = now(), updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&id],
        )
        .await?;
    document_status(cx, &[id.to_owned()], "active").await?;
    Ok(json!({"fact": fact(cx, id).await?}))
}

/// The newest episode of a fact, as the old code ordered its sources.
async fn first_episode(cx: &DataContext, id: &str) -> Result<Option<String>> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT e.id::text FROM app.memory_episodes e
             JOIN app.memory_fact_sources s
               ON s.owner_user_id = e.owner_user_id AND s.episode_id = e.id
             WHERE s.owner_user_id = app.current_actor_user_id() AND s.fact_id = $1::text::uuid
             ORDER BY e.occurred_at DESC NULLS LAST, e.created_at DESC LIMIT 1",
            &[&id],
        )
        .await?
        .map(|row| row.get(0)))
}

async fn correct(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = id_of(p)?;
    let replacement = p["replacementText"].as_str().ok_or_else(|| anyhow!("Missing replacementText"))?;
    let Some(found) = existing(cx, id).await? else {
        return Ok(refused(404, NOT_FOUND));
    };
    if recording_managed(cx, id).await? {
        return Ok(refused(409, RECORDING_CHANGED));
    }
    let created = cx
        .db()
        .query_one(
            "INSERT INTO app.memory_facts
               (owner_user_id, subject_entity_id, predicate, object_entity_id, object_text,
                record_kind, confidence, provenance, importance, pinned)
             SELECT owner_user_id, subject_entity_id, predicate, NULL, $2, record_kind,
                    GREATEST(confidence, 0.9), 'confirmed', importance, pinned
             FROM app.memory_facts
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
             RETURNING id::text, subject_entity_id::text, predicate",
            &[&id, &replacement],
        )
        .await?;
    let new_id: String = created.get(0);
    let (subject, predicate): (String, String) = (created.get(1), created.get(2));
    let episode = match first_episode(cx, id).await? {
        Some(episode) => episode,
        None => {
            let source = format!("memory:{id}");
            cx.db()
                .query_one(
                    "INSERT INTO app.memory_episodes
                       (owner_user_id, source_kind, source_ref, source_label, excerpt)
                     VALUES (app.current_actor_user_id(), 'manual', $1, 'Memory correction', '')
                     RETURNING id::text",
                    &[&source],
                )
                .await?
                .get(0)
        }
    };
    cx.db()
        .execute(
            "INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id)
             VALUES (app.current_actor_user_id(), $1::text::uuid, $2::text::uuid)
             ON CONFLICT (owner_user_id, fact_id, episode_id) DO NOTHING",
            &[&new_id, &episode],
        )
        .await?;
    cx.db()
        .execute(
            "INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id)
             SELECT s.owner_user_id, $1::text::uuid, s.episode_id
             FROM app.memory_fact_sources s
             JOIN app.memory_facts f ON f.owner_user_id = s.owner_user_id AND f.id = s.fact_id
             WHERE s.owner_user_id = app.current_actor_user_id()
               AND (f.id = $2::text::uuid
                 OR ($3::text IS NOT NULL AND f.conflict_group_id = $3::text::uuid))
             ON CONFLICT (owner_user_id, fact_id, episode_id) DO NOTHING",
            &[&new_id, &id, &found.group],
        )
        .await?;
    let subject_name: Option<String> = cx
        .db()
        .query_opt(
            "SELECT name FROM app.memory_entities
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND kind <> 'self'",
            &[&subject],
        )
        .await?
        .map(|row| row.get(0));
    let search = [subject_name.as_deref(), Some(predicate.as_str()), Some(replacement)]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    upsert_document(cx, "fact", &new_id, &search).await?;
    let mut replaced = vec![id.to_owned()];
    if let Some(group) = &found.group {
        replaced = group_ids(cx, group, None).await?;
    }
    supersede_ids(cx, &replaced, &new_id).await?;
    if let Some(group) = &found.group {
        resolve_group(cx, group).await?;
    }
    document_status(cx, &replaced, "inactive").await?;
    Ok(json!({"fact": fact(cx, &new_id).await?}))
}

/// When exactly one fact remains in conflict after `deleted` goes, it becomes active again
/// and the group is resolved. Two or more leave the conflict open.
async fn release_sole_sibling(cx: &DataContext, group: &str, deleted: &str) -> Result<()> {
    let rows = cx
        .db()
        .query(
            "SELECT id::text FROM app.memory_facts
             WHERE owner_user_id = app.current_actor_user_id()
               AND conflict_group_id = $1::text::uuid AND id <> $2::text::uuid
               AND status = 'conflicting'
             FOR UPDATE",
            &[&group, &deleted],
        )
        .await?;
    if rows.len() != 1 {
        return Ok(());
    }
    let sibling: String = rows[0].get(0);
    cx.db()
        .execute(
            "UPDATE app.memory_facts SET status = 'active', conflict_group_id = NULL,
                    updated_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid",
            &[&sibling],
        )
        .await?;
    resolve_group(cx, group).await?;
    document_status(cx, &[sibling], "active").await
}

/// Removes one fact, releasing a lone conflict sibling first. False when nothing was deleted.
async fn remove(cx: &DataContext, id: &str, xmin: Option<&str>) -> Result<bool> {
    let Some(found) = existing(cx, id).await? else {
        return Ok(false);
    };
    if let Some(group) = &found.group {
        release_sole_sibling(cx, group, id).await?;
    }
    document_status(cx, &[id.to_owned()], "inactive").await?;
    let deleted = cx
        .db()
        .execute(
            "DELETE FROM app.memory_facts
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND ($2::text IS NULL OR xmin::text = $2)",
            &[&id, &xmin],
        )
        .await?;
    Ok(deleted == 1)
}

async fn delete(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = id_of(p)?;
    if existing(cx, id).await?.is_none() {
        return Ok(refused(404, NOT_FOUND));
    }
    if recording_managed(cx, id).await? {
        return Ok(refused(409, RECORDING_CHANGED));
    }
    remove(cx, id, None).await?;
    Ok(json!({"ok": true}))
}

/// The readable label and a version hash of one fact and the two entities it names. The
/// hash changes when any of them is edited, so an approval cannot outlive its target.
const TARGET: &str = "SELECT
    concat_ws(': ', COALESCE(s.name, 'Saved subject'), f.predicate,
              COALESCE(f.object_text, o.name,
                       CASE WHEN f.object_entity_id IS NOT NULL THEN 'saved item' END)) AS label,
    encode(sha256(convert_to(jsonb_build_array(
        to_jsonb(f), s.name, o.name, f.xmin::text, s.xmin::text, o.xmin::text)::text, 'UTF8')),
        'hex') AS version,
    f.xmin::text AS xmin, f.subject_entity_id::text, f.object_entity_id::text
  FROM app.memory_facts f
  LEFT JOIN app.memory_entities s
    ON s.owner_user_id = f.owner_user_id AND s.id = f.subject_entity_id
  LEFT JOIN app.memory_entities o
    ON o.owner_user_id = f.owner_user_id AND o.id = f.object_entity_id
  WHERE f.owner_user_id = app.current_actor_user_id() AND f.id = $1::text::uuid";

async fn target(cx: &DataContext, p: &Value) -> Result<Value> {
    let row = cx.db().query_opt(TARGET, &[&id_of(p)?]).await?;
    Ok(match row {
        Some(row) => json!({"target": {"label": row.get::<_, String>(0), "version": row.get::<_, String>(1)}}),
        None => json!({"target": null}),
    })
}

/// Deletes the fact only if its version still equals the approved one. The entities are
/// locked while the version is re-read, so nothing changes between the check and the delete.
async fn forget_approved(cx: &DataContext, p: &Value) -> Result<Value> {
    let id = id_of(p)?;
    let approved = p["version"].as_str().ok_or_else(|| anyhow!("Missing version"))?;
    let Some(row) = cx.db().query_opt(TARGET, &[&id]).await? else {
        return Ok(json!({"deleted": false}));
    };
    let entities: Vec<String> = [row.get::<_, Option<String>>(3), row.get::<_, Option<String>>(4)]
        .into_iter()
        .flatten()
        .collect();
    cx.db()
        .execute(
            "SELECT 1 FROM app.memory_entities
             WHERE owner_user_id = app.current_actor_user_id()
               AND id = ANY($1::text[]::uuid[]) FOR SHARE",
            &[&entities],
        )
        .await?;
    let Some(row) = cx.db().query_opt(TARGET, &[&id]).await? else {
        return Ok(json!({"deleted": false}));
    };
    let (version, xmin): (String, String) = (row.get(1), row.get(2));
    if version != approved || recording_managed(cx, id).await? {
        return Ok(json!({"deleted": false}));
    }
    Ok(json!({"deleted": remove(cx, id, Some(&xmin)).await?}))
}

pub async fn run(cx: &DataContext, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("get", "memory.target") => target(cx, p).await,
        ("set", "memory.forget") => forget_approved(cx, p).await,
        ("set", "memory.lifecycle") => match p["action"].as_str() {
            Some("pin") => pin(cx, p).await,
            Some("confirm") => confirm(cx, p).await,
            Some("correct") => correct(cx, p).await,
            Some("status") => set_status(cx, p).await,
            Some("supersede") => supersede(cx, p).await,
            Some("delete") => delete(cx, p).await,
            _ => bail!("Unknown memory lifecycle action"),
        },
        _ => bail!("Unknown memory request"),
    }
}
