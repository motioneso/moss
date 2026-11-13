//! Thread and recent-message reads for the thread and monitor providers. Every statement runs
//! in the caller's transaction and names the signed-in person as owner, so no other person's
//! mail is reachable even through a shared-message grant.
use anyhow::{bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use uuid::Uuid;

const THREAD_LIMIT: i64 = 50;
const RECENT_LIMIT: i64 = 500;
const TIME: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

fn received() -> String {
    format!("to_char(m.received_at AT TIME ZONE 'UTC', {TIME})")
}

/// The thread provider's message shape. The excerpt is already capped by the cache.
fn thread_select() -> String {
    format!(
        "SELECT jsonb_build_object('externalId', m.external_id, 'cacheMessageId', m.id::text,
           'sender', m.sender, 'subject', m.subject, 'receivedAt', {r},
           'bodyExcerpt', COALESCE(NULLIF(m.body_excerpt, ''), m.snippet, ''),
           'threadId', m.external_metadata->>'threadId')
         FROM app.email_messages m WHERE m.owner_user_id = app.current_actor_user_id()",
        r = received()
    )
}

pub async fn run(cx: &DataContext, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match p["mode"].as_str() {
        Some("thread") => thread(cx, text(p, "threadRef")?).await,
        Some("newer") => newer(cx, p).await,
        Some("recent") => recent(cx, p).await,
        Some("saved") => saved(cx, p).await,
        Some("reply") => reply(cx, p).await,
        _ => bail!("Unknown email read"),
    }
}

fn text<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    p[name].as_str().ok_or_else(|| anyhow::anyhow!("Missing {name}"))
}

/// A provider thread id first. A reference that matches no thread may name one message (IMAP).
async fn thread(cx: &DataContext, reference: &str) -> Result<Value> {
    let sql = format!(
        "{} AND m.external_metadata->>'threadId' = $1 ORDER BY m.received_at, m.id LIMIT $2",
        thread_select()
    );
    let mut rows = cx.db().query(&sql, &[&reference, &THREAD_LIMIT]).await?;
    if rows.is_empty() {
        let sql = format!("{} AND m.external_id = $1 LIMIT 1", thread_select());
        rows = cx.db().query(&sql, &[&reference]).await?;
    }
    Ok(Value::Array(rows.iter().map(|row| row.get(0)).collect()))
}

/// For each thread, the newest cached message received after the named message.
async fn newer(cx: &DataContext, p: &Value) -> Result<Value> {
    let sql = format!(
        "{} AND m.external_metadata->>'threadId' = $1
           AND m.received_at > (SELECT a.received_at FROM app.email_messages a
                                WHERE a.owner_user_id = app.current_actor_user_id()
                                  AND a.external_id = $2 LIMIT 1)
         ORDER BY m.received_at DESC, m.id LIMIT 1",
        thread_select()
    );
    let mut out = Vec::new();
    for pair in p["threads"].as_array().into_iter().flatten().take(50) {
        let (Some(thread), Some(after)) = (pair["threadRef"].as_str(), pair["afterExternalId"].as_str()) else {
            continue;
        };
        if let Some(row) = cx.db().query_opt(&sql, &[&thread, &after]).await? {
            out.push(json!({"threadRef": thread, "newest": row.get::<_, Value>(0)}));
        }
    }
    Ok(Value::Array(out))
}

/// Recent messages of the named accounts, newest first, with a short stable hash of the
/// message reference so the package never needs to hash.
async fn recent(cx: &DataContext, p: &Value) -> Result<Value> {
    let accounts: Vec<Uuid> = p["accountIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a.as_str().and_then(|a| Uuid::parse_str(a).ok()))
        .collect();
    if accounts.is_empty() {
        return Ok(json!([]));
    }
    let since = text(p, "since")?;
    let sql = format!(
        "SELECT jsonb_build_object('hash', left(encode(sha256(convert_to(COALESCE(m.external_id, m.id::text),'UTF8')),'hex'),16),
           'subject', m.subject, 'snippet', m.snippet, 'summary', m.summary, 'receivedAt', {r})
         FROM app.email_messages m
         WHERE m.owner_user_id = app.current_actor_user_id()
           AND m.connector_account_id = ANY($1) AND m.received_at >= $2::text::timestamptz
         ORDER BY m.received_at DESC, m.id LIMIT $3",
        r = received()
    );
    let rows = cx.db().query(&sql, &[&accounts, &since, &RECENT_LIMIT]).await?;
    Ok(Value::Array(rows.iter().map(|row| row.get(0)).collect()))
}

/// The newest cached messages of the named accounts with their saved triage, for the email
/// context. Only the signed-in person's own rows are read.
async fn saved(cx: &DataContext, p: &Value) -> Result<Value> {
    let accounts: Vec<Uuid> = p["accountIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a.as_str().and_then(|a| Uuid::parse_str(a).ok()))
        .collect();
    if accounts.is_empty() {
        return Ok(json!([]));
    }
    let limit = p["limit"].as_i64().unwrap_or(50).clamp(1, 200);
    let sql = format!(
        "SELECT jsonb_build_object('cacheMessageId', m.id::text, 'externalId', m.external_id,
           'accountId', m.connector_account_id::text, 'sender', m.sender, 'recipients', to_jsonb(m.recipients),
           'subject', m.subject, 'snippet', m.snippet, 'summary', m.summary, 'signals', m.signals,
           'receivedAt', {r}, 'threadId', m.external_metadata->>'threadId',
           'hasListUnsubscribe', m.external_metadata->'hasListUnsubscribe')
         FROM app.email_messages m
         WHERE m.owner_user_id = app.current_actor_user_id() AND m.connector_account_id = ANY($1)
         ORDER BY m.received_at DESC, m.id LIMIT $2",
        r = received()
    );
    let rows = cx.db().query(&sql, &[&accounts, &limit]).await?;
    Ok(Value::Array(rows.iter().map(|row| row.get(0)).collect()))
}

/// What a reply needs from one cached message of the signed-in person: the account it came
/// through, who sent it and how it threads. A message that is not theirs answers null.
async fn reply(cx: &DataContext, p: &Value) -> Result<Value> {
    let Ok(id) = Uuid::parse_str(text(p, "cacheMessageId")?) else {
        return Ok(Value::Null);
    };
    let sql = "SELECT jsonb_build_object('accountId', m.connector_account_id::text, 'externalId', m.external_id,
           'sender', m.sender, 'subject', m.subject, 'threadId', m.external_metadata->>'threadId',
           'messageId', m.external_metadata->>'messageId', 'references', m.external_metadata->'references')
         FROM app.email_messages m WHERE m.owner_user_id = app.current_actor_user_id() AND m.id = $1";
    Ok(cx.db().query_opt(sql, &[&id]).await?.map_or(Value::Null, |row| row.get(0)))
}
