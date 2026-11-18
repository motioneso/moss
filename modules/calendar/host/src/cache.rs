//! SQL for the `calendar.cache-write` resource. Every statement runs in the caller's
//! transaction, so row-level security decides what is visible and writable.
use anyhow::{bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use uuid::Uuid;

const ISO: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing {name}"))
}

/// A database refusal the old server reported as a 400 (check, foreign key, row-level
/// security). Anything else stays an error.
fn refusal(error: &tokio_postgres::Error) -> bool {
    error
        .code()
        .is_some_and(|code| matches!(code.code(), "23503" | "23514" | "42501" | "22007" | "22008"))
}

pub async fn run(cx: &DataContext, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), p["action"].as_str()) {
        ("set", Some("upsert")) => upsert(cx, p).await,
        ("set", Some("prune")) => prune(cx, p).await,
        ("get", Some("mirror-rows")) => mirror_rows(cx, p).await,
        ("set", Some("mirror-merge")) => mirror_merge(cx, p).await,
        _ => bail!("Unknown calendar cache action"),
    }
}

async fn upsert(cx: &DataContext, p: &Value) -> Result<Value> {
    let Ok(account) = Uuid::parse_str(text(p, "connectorAccountId")?) else {
        return Ok(json!({"rejected":true}));
    };
    let external = text(p, "externalId")?;
    let e = &p["event"];
    let (title, starts, ends) = (text(e, "title")?, text(e, "startsAt")?, text(e, "endsAt")?);
    let (location, summary, excerpt) = (
        e["location"].as_str(),
        e["summary"].as_str(),
        e["bodyExcerpt"].as_str(),
    );
    let metadata = if e["externalMetadata"].is_object() {
        e["externalMetadata"].clone()
    } else {
        json!({})
    };
    let sql = format!(
        "WITH c AS (
           INSERT INTO app.calendar_events
             (id, connector_account_id, owner_user_id, title, starts_at, ends_at, location,
              summary, body_excerpt, external_id, external_metadata, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, app.current_actor_user_id(), $2,
                   $3::text::timestamptz, $4::text::timestamptz, $5, $6, $7, $8, $9, now(), now())
           ON CONFLICT (connector_account_id, external_id) DO UPDATE SET
             title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
             location = EXCLUDED.location, summary = EXCLUDED.summary,
             body_excerpt = EXCLUDED.body_excerpt,
             external_metadata = app.calendar_events.external_metadata || EXCLUDED.external_metadata,
             updated_at = now()
           RETURNING *)
         SELECT jsonb_build_object(
           'id', c.id::text, 'ownerUserId', c.owner_user_id::text, 'title', c.title,
           'startsAt', to_char(c.starts_at AT TIME ZONE 'UTC', {ISO}),
           'endsAt', to_char(c.ends_at AT TIME ZONE 'UTC', {ISO}),
           'location', c.location, 'summary', c.summary, 'bodyExcerpt', c.body_excerpt,
           'externalId', c.external_id,
           'createdAt', to_char(c.created_at AT TIME ZONE 'UTC', {ISO}),
           'updatedAt', to_char(c.updated_at AT TIME ZONE 'UTC', {ISO}))
         FROM c"
    );
    let result = cx
        .db()
        .query_one(
            &sql,
            &[&account, &title, &starts, &ends, &location, &summary, &excerpt, &external, &metadata],
        )
        .await;
    match result {
        Ok(row) => Ok(row.get(0)),
        Err(error) if refusal(&error) => Ok(json!({"rejected":true})),
        Err(error) => Err(error.into()),
    }
}

/// Deletes the account's cached events whose last write is older than `seenSince`.
async fn prune(cx: &DataContext, p: &Value) -> Result<Value> {
    let (Ok(account), Some(since)) = (
        Uuid::parse_str(text(p, "connectorAccountId")?),
        p["seenSince"].as_str(),
    ) else {
        return Ok(json!({"deleted":0}));
    };
    let deleted = cx
        .db()
        .execute(
            "DELETE FROM app.calendar_events
              WHERE connector_account_id = $1 AND updated_at < $2::text::timestamptz",
            &[&account, &since],
        )
        .await?;
    Ok(json!({"deleted":deleted}))
}

/// The account's Outlook mirror rows whose external id starts with `prefix`, with only the
/// metadata keys the import reads. Rows belong to the caller by row-level security.
async fn mirror_rows(cx: &DataContext, p: &Value) -> Result<Value> {
    let (Ok(account), Some(prefix)) = (Uuid::parse_str(text(p, "connectorAccountId")?), p["prefix"].as_str()) else {
        return Ok(json!({"rows":[]}));
    };
    let sql = format!(
        "SELECT jsonb_build_object(
           'id', id::text, 'externalId', external_id,
           'startsAt', to_char(starts_at AT TIME ZONE 'UTC', {ISO}),
           'endsAt', to_char(ends_at AT TIME ZONE 'UTC', {ISO}),
           'metadata', jsonb_strip_nulls(jsonb_build_object(
             'allDay', external_metadata->'allDay',
             'observedAt', external_metadata->'observedAt',
             'mirrorMissingObservedAt', external_metadata->'mirrorMissingObservedAt',
             'mirrorMissingRange', external_metadata->'mirrorMissingRange',
             'mirrorMissingCount', external_metadata->'mirrorMissingCount',
             'mirrorUnconfirmed', external_metadata->'mirrorUnconfirmed')))
         FROM app.calendar_events
         WHERE connector_account_id = $1
           AND owner_user_id = app.current_actor_user_id()
           AND external_metadata->>'source' = 'outlook-browser-calendar'
           AND left(external_id, length($2::text)) = $2::text
         ORDER BY id LIMIT 5000"
    );
    let rows = cx.db().query(&sql, &[&account, &prefix]).await?;
    Ok(json!({"rows":rows.iter().map(|r| r.get::<_, Value>(0)).collect::<Vec<_>>()}))
}

/// Merges the given keys into one mirror row's metadata.
async fn mirror_merge(cx: &DataContext, p: &Value) -> Result<Value> {
    let (Ok(account), Ok(id)) = (Uuid::parse_str(text(p, "connectorAccountId")?), Uuid::parse_str(text(p, "id")?)) else {
        return Ok(json!({"updated":0}));
    };
    let updated = cx
        .db()
        .execute(
            "UPDATE app.calendar_events
                SET external_metadata = external_metadata || $3, updated_at = updated_at
              WHERE connector_account_id = $1 AND id = $2
                AND owner_user_id = app.current_actor_user_id()
                AND external_metadata->>'source' = 'outlook-browser-calendar'",
            &[&account, &id, &p["metadata"]],
        )
        .await?;
    Ok(json!({"updated":updated}))
}
