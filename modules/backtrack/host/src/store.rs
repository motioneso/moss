//! The SQL behind the Backtrack store. Every statement runs in the call's actor transaction, so
//! the row policies on the three tables decide what is visible. Nothing here logs a value.
use anyhow::{ensure, Result};
use safety_core::db::DataContext;
use serde_json::{json, Value};

pub const STORE: &str = "backtrack.store";
const TIME: &str = "YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"";

fn text<'a>(parameters: &'a Value, key: &str) -> Option<&'a str> {
    parameters.get(key).and_then(Value::as_str)
}

pub async fn lock(cx: &DataContext) -> Result<Value> {
    cx.db()
        .execute("SELECT pg_advisory_xact_lock(hashtextextended(app.current_actor_user_id()::text || ':backtrack',0))", &[])
        .await?;
    Ok(json!({"locked": true}))
}

/// The instance switch: the stored setting, else the environment, else off.
pub async fn storage(cx: &DataContext, environment: Option<&str>) -> Result<Value> {
    let row = cx
        .db()
        .query_opt("SELECT value->>'value' FROM app.instance_settings WHERE key='backtrack.storage'", &[])
        .await?;
    let stored: Option<String> = row.and_then(|r| r.get(0));
    let value = stored.as_deref().or(environment).unwrap_or("off");
    Ok(json!({"on": value == "on"}))
}

pub async fn paused(cx: &DataContext) -> Result<Value> {
    let row = cx
        .db()
        .query_opt("SELECT paused FROM app.backtrack_preferences WHERE owner_user_id=app.current_actor_user_id()", &[])
        .await?;
    Ok(json!({"paused": row.map(|r| r.get::<_, bool>(0)).unwrap_or(false)}))
}

pub async fn set_paused(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let paused = parameters.get("paused").and_then(Value::as_bool).ok_or_else(|| anyhow::anyhow!("paused required"))?;
    let row = cx
        .db()
        .query_one(
            "INSERT INTO app.backtrack_preferences(owner_user_id,paused,updated_at) VALUES(app.current_actor_user_id(),$1,now()) \
             ON CONFLICT(owner_user_id) DO UPDATE SET paused=EXCLUDED.paused,updated_at=now() RETURNING paused",
            &[&paused],
        )
        .await?;
    Ok(json!({"paused": row.get::<_, bool>(0)}))
}

/// Which of the given windows overlap a deletion marker.
pub async fn overlaps(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let windows = parameters.get("windows").and_then(Value::as_array).ok_or_else(|| anyhow::anyhow!("windows required"))?;
    ensure!(windows.len() <= 200, "Too many windows");
    let mut hits = Vec::new();
    for (index, pair) in windows.iter().enumerate() {
        let (Some(from), Some(to)) = (pair[0].as_str(), pair[1].as_str()) else { anyhow::bail!("Invalid window") };
        let hit: bool = cx
            .db()
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM app.backtrack_deletions d WHERE d.owner_user_id=app.current_actor_user_id() \
                 AND d.range && tstzrange($1::text::timestamptz,$2::text::timestamptz,'[]'))",
                &[&from, &to],
            )
            .await?
            .get(0);
        if hit {
            hits.push(index);
        }
    }
    Ok(json!({"indexes": hits}))
}

/// Stores the rows. A row already stored for this Mac, text and start time is skipped.
pub async fn insert(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let device = text(parameters, "deviceId").ok_or_else(|| anyhow::anyhow!("deviceId required"))?;
    let rows = parameters.get("segments").and_then(Value::as_array).ok_or_else(|| anyhow::anyhow!("segments required"))?;
    ensure!(rows.len() <= 200, "Too many segments");
    let mut inserted = 0u64;
    for row in rows {
        let field = |k: &str| text(row, k).ok_or_else(|| anyhow::anyhow!("segment field missing"));
        let address = text(row, "address");
        inserted += cx
            .db()
            .execute(
                "INSERT INTO app.backtrack_segments(owner_user_id,device_id,started_at,ended_at,app_name,bundle_id,window_title,address,body,body_hash,client_started_at) \
                 VALUES(app.current_actor_user_id(),$1::text::uuid,$2::text::timestamptz,$3::text::timestamptz,$4,$5,$6,$7,$8,decode($9,'hex'),$10::text::timestamptz) \
                 ON CONFLICT(owner_user_id,device_id,body_hash,client_started_at) DO NOTHING",
                &[&device, &field("startedAt")?, &field("endedAt")?, &field("appName")?, &field("bundleId")?, &field("windowTitle")?, &address, &field("body")?, &field("bodyHash")?, &field("clientStartedAt")?],
            )
            .await?;
    }
    Ok(json!({"inserted": inserted}))
}

/// Marker first, then the segments in the range, both under the person's lock.
pub async fn delete(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let from = text(parameters, "from");
    let to = text(parameters, "to").ok_or_else(|| anyhow::anyhow!("to required"))?;
    let at = text(parameters, "deletedAt").ok_or_else(|| anyhow::anyhow!("deletedAt required"))?;
    cx.db()
        .execute(
            "INSERT INTO app.backtrack_deletions(owner_user_id,range) VALUES(app.current_actor_user_id(),\
             tstzrange($1::text::timestamptz,LEAST($2::text::timestamptz,$3::text::timestamptz),'[)'))",
            &[&from, &to, &at],
        )
        .await?;
    let removed = cx
        .db()
        .query(
            "DELETE FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id() \
             AND NOT (ended_at < COALESCE($1::text::timestamptz,'-infinity'::timestamptz) \
             OR started_at >= COALESCE($2::text::timestamptz,'infinity'::timestamptz)) RETURNING id::text",
            &[&from, &Some(to)],
        )
        .await?;
    let ids: Vec<String> = removed.iter().map(|r| r.get::<_, String>(0)).collect();
    drop_marks(cx, &ids).await?;
    Ok(json!({"deleted": ids.len()}))
}

const MODULE_ID: &str = "backtrack";

/// The index marks table belongs to the package, so its statements run as the package role.
/// Statements on the segment table run as the app role. No statement joins the two.
async fn as_module(cx: &DataContext) -> Result<()> {
    cx.db().batch_execute(&format!("SET LOCAL ROLE {}", moss_module_host::database::runtime_role(MODULE_ID))).await?;
    Ok(())
}

async fn as_app(cx: &DataContext) -> Result<()> {
    cx.db().batch_execute("RESET ROLE").await?;
    Ok(())
}

/// Removes the index marks of the listed segments.
async fn drop_marks(cx: &DataContext, ids: &[String]) -> Result<()> {
    as_module(cx).await?;
    for part in ids.chunks(IDS_PER_CALL) {
        cx.db()
            .execute("DELETE FROM app.backtrack_index_marks WHERE segment_id = ANY($1::text[]::uuid[])", &[&part.to_vec()])
            .await?;
    }
    as_app(cx).await
}

/// Ids of live segments that have no index mark, oldest first. `older_than_ten_minutes` limits
/// the scan to segments that have waited too long.
async fn unindexed(cx: &DataContext, limit: usize, older_than_ten_minutes: bool) -> Result<Vec<String>> {
    const PAGE: i64 = 500;
    let age = if older_than_ten_minutes { "AND created_at < now() - interval '10 minutes'" } else { "" };
    let mut found: Vec<String> = Vec::new();
    let mut after: Option<(String, String)> = None;
    loop {
        let (at, id) = after.clone().unwrap_or_else(|| ("-infinity".to_owned(), "00000000-0000-0000-0000-000000000000".to_owned()));
        let page = cx
            .db()
            .query(
                &format!(
                    "SELECT id::text, created_at::text FROM app.backtrack_segments \
                     WHERE owner_user_id=app.current_actor_user_id() AND {LIVE} {age} \
                     AND (created_at, id) > ($1::text::timestamptz, $2::text::uuid) ORDER BY created_at, id LIMIT {PAGE}"
                ),
                &[&at, &id],
            )
            .await?;
        if page.is_empty() {
            return Ok(found);
        }
        let ids: Vec<String> = page.iter().map(|r| r.get::<_, String>(0)).collect();
        after = page.last().map(|r| (r.get::<_, String>(1), r.get::<_, String>(0)));
        as_module(cx).await?;
        let marked = cx
            .db()
            .query("SELECT segment_id::text FROM app.backtrack_index_marks WHERE segment_id = ANY($1::text[]::uuid[])", &[&ids])
            .await?;
        as_app(cx).await?;
        let marked: std::collections::HashSet<String> = marked.iter().map(|r| r.get::<_, String>(0)).collect();
        for id in ids {
            if !marked.contains(&id) {
                found.push(id);
                if found.len() >= limit {
                    return Ok(found);
                }
            }
        }
        if page.len() < PAGE as usize {
            return Ok(found);
        }
    }
}

const LIVE: &str = "started_at >= now() - interval '37 days' AND created_at >= now() - interval '37 days'";
const IDS_PER_CALL: usize = 500;

fn uuids(parameters: &Value, key: &str, max: usize) -> Result<Vec<String>> {
    let list = parameters.get(key).and_then(Value::as_array).ok_or_else(|| anyhow::anyhow!("{key} required"))?;
    ensure!(list.len() <= max, "Too many ids");
    list.iter().map(|v| v.as_str().map(str::to_owned).ok_or_else(|| anyhow::anyhow!("Invalid id"))).collect()
}

/// Ids of the segments a delete over this range would remove.
pub async fn segment_ids(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let from = text(parameters, "from");
    let to = text(parameters, "to");
    let rows = cx
        .db()
        .query(
            "SELECT id::text FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id() \
             AND NOT (ended_at < COALESCE($1::text::timestamptz,'-infinity'::timestamptz) \
             OR started_at >= COALESCE($2::text::timestamptz,'infinity'::timestamptz))",
            &[&from, &to],
        )
        .await?;
    Ok(json!({"ids": rows.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>()}))
}

/// The next batch of this person's segments past 37 days, by start or arrival.
pub async fn expired(cx: &DataContext) -> Result<Value> {
    let rows = cx
        .db()
        .query(
            "SELECT id::text FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id() \
             AND (started_at < now() - interval '37 days' OR created_at < now() - interval '37 days') \
             ORDER BY created_at LIMIT 500",
            &[],
        )
        .await?;
    Ok(json!({"ids": rows.iter().map(|r| r.get::<_, String>(0)).collect::<Vec<_>>()}))
}

/// Removes the listed expired segments and this person's deletion markers past 38 days.
pub async fn upkeep(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let ids = uuids(parameters, "ids", IDS_PER_CALL)?;
    let segments = cx
        .db()
        .execute(
            "DELETE FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id() \
             AND id = ANY($1::text[]::uuid[])",
            &[&ids],
        )
        .await?;
    let markers = cx
        .db()
        .execute(
            "DELETE FROM app.backtrack_deletions WHERE owner_user_id=app.current_actor_user_id() AND created_at < now() - interval '38 days'",
            &[],
        )
        .await?;
    drop_marks(cx, &ids).await?;
    Ok(json!({"segments": segments, "markers": markers}))
}

/// Whether any text has waited over ten minutes without being indexed.
pub async fn stale(cx: &DataContext) -> Result<Value> {
    Ok(json!({"stale": !unindexed(cx, 1, true).await?.is_empty()}))
}

/// The oldest unindexed live segments, for the index job.
pub async fn pending(cx: &DataContext) -> Result<Value> {
    let ids = unindexed(cx, 200, false).await?;
    let rows = cx
        .db()
        .query(
            "SELECT jsonb_build_object('id',id::text,'windowTitle',window_title,'address',address,'body',body) \
             FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id() \
             AND id = ANY($1::text[]::uuid[]) ORDER BY created_at, id",
            &[&ids],
        )
        .await?;
    Ok(json!({"segments": rows.iter().map(|r| r.get::<_, Value>(0)).collect::<Vec<_>>()}))
}

pub async fn mark_indexed(cx: &DataContext, parameters: &Value) -> Result<Value> {
    let ids = uuids(parameters, "ids", 200)?;
    let mine: Vec<String> = cx
        .db()
        .query(
            "SELECT id::text FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id() \
             AND id = ANY($1::text[]::uuid[])",
            &[&ids],
        )
        .await?
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    as_module(cx).await?;
    let marked = cx
        .db()
        .execute(
            "INSERT INTO app.backtrack_index_marks(segment_id,owner_user_id) \
             SELECT x, app.current_actor_user_id() FROM unnest($1::text[]::uuid[]) AS x ON CONFLICT (segment_id) DO NOTHING",
            &[&mine],
        )
        .await?;
    as_app(cx).await?;
    Ok(json!({"marked": marked}))
}

/// A job key that is the same for one person within one minute, so a burst of uploads queues
/// one index run. It is a hash of the person and the minute, never of any text.
pub async fn index_key(cx: &DataContext) -> Result<Value> {
    let key: String = cx
        .db()
        .query_one(
            "SELECT md5(app.current_actor_user_id()::text || ':backtrack-index:' || floor(extract(epoch from now())/60)::text)::uuid::text",
            &[],
        )
        .await?
        .get(0);
    Ok(json!({"key": key}))
}

pub async fn status(cx: &DataContext) -> Result<Value> {
    let paused = paused(cx).await?["paused"].clone();
    let row = cx
        .db()
        .query_one(
            &format!(
                "SELECT count(DISTINCT device_id) FILTER (WHERE started_at >= now() - interval '30 days')::bigint, \
                 count(DISTINCT date_trunc('day', started_at))::bigint, \
                 coalesce(sum(octet_length(app_name)+octet_length(bundle_id)+octet_length(window_title)+coalesce(octet_length(address),0)+octet_length(body)),0)::bigint, \
                 to_char(min(started_at) AT TIME ZONE 'UTC','{TIME}'), to_char(max(created_at) AT TIME ZONE 'UTC','{TIME}') \
                 FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id()"
            ),
            &[],
        )
        .await?;
    let mut body = json!({"paused": paused, "macs": row.get::<_, i64>(0), "days": row.get::<_, i64>(1), "bytes": row.get::<_, i64>(2)});
    if let Some(oldest) = row.get::<_, Option<String>>(3) {
        body["oldest"] = oldest.into();
    }
    if let Some(last) = row.get::<_, Option<String>>(4) {
        body["lastReceivedAt"] = last.into();
    }
    Ok(body)
}

/// Every column of the person's own segments except the search column, with the hash as hex.
pub async fn export(cx: &DataContext) -> Result<Value> {
    let rows = cx
        .db()
        .query(
            &format!(
                "SELECT jsonb_build_object('id',id::text,'ownerUserId',owner_user_id::text,'deviceId',device_id::text,\
                 'startedAt',to_char(started_at AT TIME ZONE 'UTC','{TIME}'),'endedAt',to_char(ended_at AT TIME ZONE 'UTC','{TIME}'),\
                 'appName',app_name,'bundleId',bundle_id,'windowTitle',window_title,'address',address,'body',body,\
                 'bodyHash',encode(body_hash,'hex'),'indexedAt',NULL::text,\
                 'createdAt',to_char(created_at AT TIME ZONE 'UTC','{TIME}'),\
                 'clientStartedAt',to_char(client_started_at AT TIME ZONE 'UTC','{TIME}')) \
                 FROM app.backtrack_segments WHERE owner_user_id=app.current_actor_user_id() ORDER BY started_at DESC, id"
            ),
            &[],
        )
        .await?;
    let mut out: Vec<Value> = rows.iter().map(|r| r.get::<_, Value>(0)).collect();
    as_module(cx).await?;
    let marks = cx
        .db()
        .query(&format!("SELECT segment_id::text, to_char(indexed_at AT TIME ZONE 'UTC','{TIME}') FROM app.backtrack_index_marks"), &[])
        .await?;
    as_app(cx).await?;
    let marks: std::collections::HashMap<String, String> = marks.iter().map(|r| (r.get(0), r.get(1))).collect();
    for row in &mut out {
        if let Some(at) = row["id"].as_str().and_then(|id| marks.get(id)) {
            row["indexedAt"] = json!(at);
        }
    }
    Ok(Value::Array(out))
}
