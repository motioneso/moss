//! Owner-started re-embed. New vectors are staged in their own table while search keeps using
//! the old ones. One transaction swaps every staged vector in when the run is complete, so a
//! stopped, cancelled or failed run leaves the old vectors exactly as they were. Only counts,
//! ids and model names cross this boundary; passage text never leaves the database except to
//! the embedding service.
use anyhow::Result;
use safety_core::db::DataContext;
use serde_json::{json, Value};

/// Passages embedded per step.
pub const BATCH: i64 = 16;

pub fn refused(status: u16, message: &str) -> Value {
    json!({"refused": {"status": status, "message": message}})
}

/// A vector row waiting to be staged: kind, row id, hash of the text that was embedded, text.
pub struct Pending {
    pub kind: &'static str,
    pub id: String,
    pub hash: String,
    pub text: String,
}

/// Counts that the Memory screen shows. `other` counts passages whose vector was made by a
/// model other than the current one. `missing` counts saved facts with no vector at all.
pub async fn status(cx: &DataContext, model: &(String, String)) -> Result<Value> {
    let counts = cx
        .db()
        .query_one(
            "SELECT
               (SELECT count(*) FROM app.memory_chunks
                 WHERE owner_user_id = app.current_actor_user_id() AND embedding IS NOT NULL
                   AND embed_model_name IS DISTINCT FROM $1)::int8
             + (SELECT count(*) FROM app.memory_search_documents
                 WHERE owner_user_id = app.current_actor_user_id() AND embedding IS NOT NULL
                   AND embed_model_name IS DISTINCT FROM $1)::int8,
               (SELECT count(*) FROM app.memory_search_documents
                 WHERE owner_user_id = app.current_actor_user_id() AND target_kind = 'fact'
                   AND status = 'active' AND embedding IS NULL)::int8",
            &[&model.0],
        )
        .await?;
    let run = cx
        .db()
        .query_opt(
            "SELECT r.id::text, r.status, r.total,
                    (SELECT count(*) FROM app.memory_reembed_staged s WHERE s.run_id = r.id)::int8
             FROM app.memory_reembed_runs r
             WHERE r.owner_user_id = app.current_actor_user_id()
             ORDER BY r.started_at DESC LIMIT 1",
            &[],
        )
        .await?
        .map(|row| {
            json!({"id": row.get::<_, String>(0), "status": row.get::<_, String>(1),
                   "total": row.get::<_, i32>(2), "staged": row.get::<_, i64>(3)})
        });
    Ok(json!({
        "model": {"name": model.0, "version": model.1},
        "otherModel": counts.get::<_, i64>(0),
        "missing": counts.get::<_, i64>(1),
        "run": run,
    }))
}

/// Starts a run for the current model. Refused when one is already running or nothing needs it.
pub async fn start(cx: &DataContext, model: &(String, String)) -> Result<Value> {
    let running = cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND status = 'running'",
            &[],
        )
        .await?;
    if running.is_some() {
        return Ok(refused(409, "A re-embed is already running"));
    }
    let total: i64 = status(cx, model).await?["otherModel"].as_i64().unwrap_or(0);
    if total == 0 {
        return Ok(refused(409, "Nothing needs a new search model"));
    }
    let id: String = cx
        .db()
        .query_one(
            "INSERT INTO app.memory_reembed_runs(id, owner_user_id, status, model_name, model_version, total)
             VALUES (gen_random_uuid(), app.current_actor_user_id(), 'running', $1, $2, $3::int8::int)
             RETURNING id::text",
            &[&model.0, &model.1, &total],
        )
        .await?
        .get(0);
    Ok(json!({"id": id, "status": "running", "total": total, "staged": 0}))
}

/// The run's target model while it is still running.
pub async fn running(cx: &DataContext, run: &str) -> Result<Option<(String, String)>> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT model_name, model_version FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'running'",
            &[&run],
        )
        .await?
        .map(|row| (row.get(0), row.get(1))))
}

/// The next passages that still have no staged vector for this run.
pub async fn next_batch(cx: &DataContext, run: &str, model: &str) -> Result<Vec<Pending>> {
    let mut out = Vec::new();
    for (kind, table, column) in [
        ("chunk", "app.memory_chunks", "text"),
        ("document", "app.memory_search_documents", "search_text"),
    ] {
        let left = BATCH - out.len() as i64;
        if left <= 0 {
            break;
        }
        let sql = format!(
            "SELECT t.id::text, md5(t.{column}), t.{column} FROM {table} t
             WHERE t.owner_user_id = app.current_actor_user_id() AND t.embedding IS NOT NULL
               AND t.embed_model_name IS DISTINCT FROM $2
               AND NOT EXISTS (SELECT 1 FROM app.memory_reembed_staged s
                               WHERE s.run_id = $1::text::uuid AND s.target_kind = '{kind}'
                                 AND s.target_id = t.id)
             ORDER BY t.id LIMIT $3"
        );
        for row in cx.db().query(&sql, &[&run, &model, &left]).await? {
            out.push(Pending { kind, id: row.get(0), hash: row.get(1), text: row.get(2) });
        }
    }
    Ok(out)
}

/// Stages one vector, but only while the passage still holds the text that was embedded.
pub async fn stage(cx: &DataContext, run: &str, item: &Pending, vector: &str) -> Result<()> {
    let table = if item.kind == "chunk" { "app.memory_chunks" } else { "app.memory_search_documents" };
    let column = if item.kind == "chunk" { "text" } else { "search_text" };
    let sql = format!(
        "INSERT INTO app.memory_reembed_staged(run_id, owner_user_id, target_kind, target_id, text_hash, embedding)
         SELECT $1::text::uuid, app.current_actor_user_id(), '{kind}', t.id, md5(t.{column}), $4::text::vector
         FROM {table} t
         WHERE t.owner_user_id = app.current_actor_user_id() AND t.id = $2::text::uuid
           AND md5(t.{column}) = $3
         ON CONFLICT DO NOTHING",
        kind = item.kind
    );
    cx.db().execute(&sql, &[&run, &item.id, &item.hash, &vector]).await?;
    Ok(())
}

/// Passages still waiting for a staged vector.
pub async fn remaining(cx: &DataContext, run: &str, model: &str) -> Result<i64> {
    let row = cx
        .db()
        .query_one(
            "SELECT
               (SELECT count(*) FROM app.memory_chunks t
                 WHERE t.owner_user_id = app.current_actor_user_id() AND t.embedding IS NOT NULL
                   AND t.embed_model_name IS DISTINCT FROM $2
                   AND NOT EXISTS (SELECT 1 FROM app.memory_reembed_staged s WHERE s.run_id = $1::text::uuid
                                   AND s.target_kind = 'chunk' AND s.target_id = t.id))::int8
             + (SELECT count(*) FROM app.memory_search_documents t
                 WHERE t.owner_user_id = app.current_actor_user_id() AND t.embedding IS NOT NULL
                   AND t.embed_model_name IS DISTINCT FROM $2
                   AND NOT EXISTS (SELECT 1 FROM app.memory_reembed_staged s WHERE s.run_id = $1::text::uuid
                                   AND s.target_kind = 'document' AND s.target_id = t.id))::int8",
            &[&run, &model],
        )
        .await?;
    Ok(row.get(0))
}

/// Swaps every staged vector in with one statement batch inside the caller's transaction, then
/// marks the run done. A passage whose text changed since it was staged keeps its old vector.
pub async fn swap(cx: &DataContext, run: &str, model: &(String, String)) -> Result<()> {
    for (table, column, kind) in [
        ("app.memory_chunks", "text", "chunk"),
        ("app.memory_search_documents", "search_text", "document"),
    ] {
        let sql = format!(
            "UPDATE {table} t SET embedding = s.embedding, embed_model_name = $2,
                    embed_model_version = $3, updated_at = now()
             FROM app.memory_reembed_staged s
             WHERE s.run_id = $1::text::uuid AND s.target_kind = '{kind}' AND s.target_id = t.id
               AND t.owner_user_id = app.current_actor_user_id()
               AND md5(t.{column}) = s.text_hash"
        );
        cx.db().execute(&sql, &[&run, &model.0, &model.1]).await?;
    }
    cx.db()
        .execute("DELETE FROM app.memory_reembed_staged WHERE run_id = $1::text::uuid", &[&run])
        .await?;
    close(cx, run, "done").await
}

/// Ends a run and drops what it staged. Old vectors are untouched.
pub async fn close(cx: &DataContext, run: &str, status: &str) -> Result<()> {
    cx.db()
        .execute(
            "UPDATE app.memory_reembed_runs SET status = $2, finished_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'running'",
            &[&run, &status],
        )
        .await?;
    if status != "done" {
        cx.db()
            .execute("DELETE FROM app.memory_reembed_staged WHERE run_id = $1::text::uuid", &[&run])
            .await?;
    }
    Ok(())
}

/// Cancels the running run, if any, and returns whether one was running.
pub async fn cancel(cx: &DataContext) -> Result<Value> {
    let run: Option<String> = cx
        .db()
        .query_opt(
            "SELECT id::text FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND status = 'running' FOR UPDATE",
            &[],
        )
        .await?
        .map(|row| row.get(0));
    let Some(run) = run else { return Ok(json!({"cancelled": false})) };
    close(cx, &run, "cancelled").await?;
    Ok(json!({"cancelled": true}))
}

/// Saved facts that were stored with no vector, oldest first.
pub async fn missing(cx: &DataContext, limit: i64) -> Result<Vec<(String, String)>> {
    Ok(cx
        .db()
        .query(
            "SELECT target_id::text, search_text FROM app.memory_search_documents
             WHERE owner_user_id = app.current_actor_user_id() AND target_kind = 'fact'
               AND status = 'active' AND embedding IS NULL
             ORDER BY updated_at, id LIMIT $1",
            &[&limit],
        )
        .await?
        .iter()
        .map(|row| (row.get(0), row.get(1)))
        .collect())
}

/// Takes the run's row lock and says whether it is still running. Cancel takes the same lock,
/// so a step never stages after a cancel has been committed.
pub async fn hold(cx: &DataContext, run: &str) -> Result<bool> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'running' FOR UPDATE",
            &[&run],
        )
        .await?
        .is_some())
}

/// How far a run has got, as total passages and staged passages.
pub async fn progress(cx: &DataContext, run: &str) -> Result<(i64, i64)> {
    let row = cx
        .db()
        .query_one(
            "SELECT r.total::int8,
                    (SELECT count(*) FROM app.memory_reembed_staged s WHERE s.run_id = r.id)::int8
             FROM app.memory_reembed_runs r
             WHERE r.owner_user_id = app.current_actor_user_id() AND r.id = $1::text::uuid",
            &[&run],
        )
        .await?;
    Ok((row.get(0), row.get(1)))
}
