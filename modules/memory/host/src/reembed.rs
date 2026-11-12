//! Owner-started re-embed. New vectors are staged in their own table and the old ones stay in
//! the database. One transaction swaps every staged vector in when the run is complete, so a
//! stopped, cancelled or failed run leaves the old vectors exactly as they were. Search only
//! reads vectors made by the current model, so note search finds nothing from old passages
//! until the swap lands. Only counts,
//! ids and model names cross this boundary; passage text never leaves the database except to
//! the embedding service.
//!
//! The two run tables belong to the module, so they are only reachable as the module's own
//! database role. Passages and facts belong to the app role. Each statement block switches to
//! the role that owns what it touches and switches back, all inside one transaction.
use anyhow::Result;
use moss_module_host::database::runtime_role;
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

async fn module_role(cx: &DataContext) -> Result<()> {
    cx.db().batch_execute(&format!("SET LOCAL ROLE {}", runtime_role(crate::MODULE_ID))).await?;
    Ok(())
}

async fn app_role(cx: &DataContext) -> Result<()> {
    cx.db().batch_execute("RESET ROLE").await?;
    Ok(())
}

const TARGETS: [(&str, &str, &str); 2] = [
    ("chunk", "app.memory_chunks", "text"),
    ("document", "app.memory_search_documents", "search_text"),
];

/// Highest id this run has staged for one kind of passage. Batches walk ids in order, so
/// everything at or below it is already staged.
async fn cursor(cx: &DataContext, run: &str, kind: &str) -> Result<String> {
    module_role(cx).await?;
    let row = cx
        .db()
        .query_one(
            "SELECT coalesce(max(target_id::text), '00000000-0000-0000-0000-000000000000')
             FROM app.memory_reembed_staged WHERE run_id = $1::text::uuid AND target_kind = $2",
            &[&run, &kind],
        )
        .await?;
    app_role(cx).await?;
    Ok(row.get(0))
}

/// Counts that the Search model screen shows. `other` counts passages whose vector was made by a
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
    module_role(cx).await?;
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
    app_role(cx).await?;
    Ok(json!({
        "model": {"name": model.0, "version": model.1},
        "otherModel": counts.get::<_, i64>(0),
        "missing": counts.get::<_, i64>(1),
        "run": run,
    }))
}

/// Starts a run for the current model. Refused when one is already running or nothing needs it.
pub async fn start(cx: &DataContext, model: &(String, String)) -> Result<Value> {
    module_role(cx).await?;
    let running = cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND status = 'running'",
            &[],
        )
        .await?;
    app_role(cx).await?;
    if running.is_some() {
        return Ok(refused(409, "A re-embed is already running"));
    }
    let total: i64 = status(cx, model).await?["otherModel"].as_i64().unwrap_or(0);
    if total == 0 {
        return Ok(refused(409, "Nothing needs a new search model"));
    }
    module_role(cx).await?;
    let id: Option<String> = cx
        .db()
        .query_opt(
            "INSERT INTO app.memory_reembed_runs(id, owner_user_id, status, model_name, model_version, total)
             VALUES (gen_random_uuid(), app.current_actor_user_id(), 'running', $1, $2, $3::int8::int)
             ON CONFLICT (owner_user_id) WHERE status = 'running' DO NOTHING
             RETURNING id::text",
            &[&model.0, &model.1, &total],
        )
        .await?
        .map(|row| row.get(0));
    app_role(cx).await?;
    let Some(id) = id else { return Ok(refused(409, "A re-embed is already running")) };
    Ok(json!({"id": id, "status": "running", "total": total, "staged": 0}))
}

/// The run's target model while it is still running.
pub async fn running(cx: &DataContext, run: &str) -> Result<Option<(String, String)>> {
    module_role(cx).await?;
    let found = cx
        .db()
        .query_opt(
            "SELECT model_name, model_version FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'running'",
            &[&run],
        )
        .await?
        .map(|row| (row.get(0), row.get(1)));
    app_role(cx).await?;
    Ok(found)
}

/// The next passages that still have no staged vector for this run.
pub async fn next_batch(cx: &DataContext, run: &str, model: &str) -> Result<Vec<Pending>> {
    let mut out = Vec::new();
    for (kind, table, column) in TARGETS {
        let left = BATCH - out.len() as i64;
        if left <= 0 {
            break;
        }
        let done = cursor(cx, run, kind).await?;
        let sql = format!(
            "SELECT t.id::text, md5(t.{column}), t.{column} FROM {table} t
             WHERE t.owner_user_id = app.current_actor_user_id() AND t.embedding IS NOT NULL
               AND t.embed_model_name IS DISTINCT FROM $1
               AND t.id > $2::text::uuid
             ORDER BY t.id LIMIT $3"
        );
        for row in cx.db().query(&sql, &[&model, &done, &left]).await? {
            out.push(Pending { kind, id: row.get(0), hash: row.get(1), text: row.get(2) });
        }
    }
    Ok(out)
}

/// Stages one vector with the hash of the text that was embedded. The swap applies it only
/// while the passage still has that text.
pub async fn stage(cx: &DataContext, run: &str, item: &Pending, vector: &str) -> Result<()> {
    module_role(cx).await?;
    cx.db()
        .execute(
            "INSERT INTO app.memory_reembed_staged(run_id, owner_user_id, target_kind, target_id, text_hash, embedding)
             VALUES ($1::text::uuid, app.current_actor_user_id(), $2, $3::text::uuid, $4, $5::text::vector)
             ON CONFLICT DO NOTHING",
            &[&run, &item.kind, &item.id, &item.hash, &vector],
        )
        .await?;
    app_role(cx).await?;
    Ok(())
}

/// Passages still waiting for a staged vector.
pub async fn remaining(cx: &DataContext, run: &str, model: &str) -> Result<i64> {
    let mut total = 0;
    for (kind, table, _) in TARGETS {
        let done = cursor(cx, run, kind).await?;
        let row = cx
            .db()
            .query_one(
                &format!(
                    "SELECT count(*)::int8 FROM {table} t
                     WHERE t.owner_user_id = app.current_actor_user_id() AND t.embedding IS NOT NULL
                       AND t.embed_model_name IS DISTINCT FROM $1
                       AND t.id > $2::text::uuid"
                ),
                &[&model, &done],
            )
            .await?;
        total += row.get::<_, i64>(0);
    }
    Ok(total)
}

/// Swaps every staged vector in, a slice at a time, inside the caller's transaction, then marks
/// the run done. A passage whose text changed since it was staged keeps its old vector.
pub async fn swap(cx: &DataContext, run: &str, model: &(String, String)) -> Result<()> {
    for (kind, table, column) in TARGETS {
        let mut after = String::from("00000000-0000-0000-0000-000000000000");
        loop {
            module_role(cx).await?;
            let slice = cx
                .db()
                .query(
                    "SELECT target_id::text, text_hash, embedding::text FROM app.memory_reembed_staged
                     WHERE run_id = $1::text::uuid AND target_kind = $2 AND target_id > $3::text::uuid
                     ORDER BY target_id LIMIT 500",
                    &[&run, &kind, &after],
                )
                .await?;
            app_role(cx).await?;
            let Some(last) = slice.last() else { break };
            after = last.get(0);
            let ids: Vec<String> = slice.iter().map(|r| r.get(0)).collect();
            let hashes: Vec<String> = slice.iter().map(|r| r.get(1)).collect();
            let vectors: Vec<String> = slice.iter().map(|r| r.get(2)).collect();
            cx.db()
                .execute(
                    &format!(
                        "UPDATE {table} t SET embedding = s.vector::vector, embed_model_name = $4,
                                embed_model_version = $5, updated_at = now()
                         FROM unnest($1::text[], $2::text[], $3::text[]) AS s(id, hash, vector)
                         WHERE t.id = s.id::uuid AND t.owner_user_id = app.current_actor_user_id()
                           AND md5(t.{column}) = s.hash"
                    ),
                    &[&ids, &hashes, &vectors, &model.0, &model.1],
                )
                .await?;
        }
    }
    close(cx, run, "done").await
}

/// Ends a run and drops what it staged. Old vectors are untouched.
pub async fn close(cx: &DataContext, run: &str, status: &str) -> Result<()> {
    module_role(cx).await?;
    cx.db()
        .execute(
            "UPDATE app.memory_reembed_runs SET status = $2, finished_at = now()
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'running'",
            &[&run, &status],
        )
        .await?;
    cx.db()
        .execute("DELETE FROM app.memory_reembed_staged WHERE run_id = $1::text::uuid", &[&run])
        .await?;
    app_role(cx).await?;
    Ok(())
}

/// Cancels the running run, if any, and returns whether one was running.
pub async fn cancel(cx: &DataContext) -> Result<Value> {
    module_role(cx).await?;
    let run: Option<String> = cx
        .db()
        .query_opt(
            "SELECT id::text FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND status = 'running' FOR UPDATE",
            &[],
        )
        .await?
        .map(|row| row.get(0));
    app_role(cx).await?;
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
    module_role(cx).await?;
    let held = cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.memory_reembed_runs
             WHERE owner_user_id = app.current_actor_user_id() AND id = $1::text::uuid
               AND status = 'running' FOR UPDATE",
            &[&run],
        )
        .await?
        .is_some();
    app_role(cx).await?;
    Ok(held)
}

/// How far a run has got, as total passages and staged passages.
pub async fn progress(cx: &DataContext, run: &str) -> Result<(i64, i64)> {
    module_role(cx).await?;
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
    app_role(cx).await?;
    Ok((row.get(0), row.get(1)))
}
