//! SQL for the `email.*` resources. Every statement runs in the caller's transaction,
//! so row-level security decides what is visible and writable.
use anyhow::{bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Map, Value};
use uuid::Uuid;

const ISO: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

fn iso(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', {ISO})")
}

/// The message shape the old routes serialize. `from` names a table with alias `m`.
fn message_select(from: &str) -> String {
    format!(
        "SELECT jsonb_build_object(
           'id', m.id::text, 'ownerUserId', m.owner_user_id::text, 'sender', m.sender,
           'recipients', to_jsonb(m.recipients), 'subject', m.subject,
           'snippet', m.snippet, 'bodyExcerpt', m.body_excerpt, 'summary', m.summary,
           'signals', m.signals, 'receivedAt', {received}, 'externalId', m.external_id,
           'createdAt', {created}, 'updatedAt', {updated})
         FROM {from}",
        received = iso("m.received_at"),
        created = iso("m.created_at"),
        updated = iso("m.updated_at"),
    )
}

const TABLE: &str = "app.email_messages m";
const ORDER: &str = "ORDER BY m.received_at DESC, m.id";

pub const TASK_MODE: &str = "email.task_creation_mode";
pub const SIGNAL_KEYS: [&str; 4] = [
    "email.signal_create_tasks",
    "email.signal_suggest_replies",
    "email.signal_draft_replies",
    "email.signal_auto_send",
];
const DRAFT_POLICY_KEY: &str = "assistant.action_policy.v1.email.email_drafts";
const BRIEFINGS_ENTRY: &str = "email.briefings";

fn allowed(key: &str) -> bool {
    key == TASK_MODE || SIGNAL_KEYS.contains(&key)
}

/// A database refusal the old server reported as a 400 (foreign key, row-level
/// security, duplicate key). Anything else stays an error.
fn refusal(error: &tokio_postgres::Error) -> bool {
    error
        .code()
        .is_some_and(|code| matches!(code.code(), "23503" | "42501" | "23505"))
}

fn text<'a>(parameters: &'a Value, name: &str) -> Result<&'a str> {
    parameters[name]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing {name}"))
}

pub async fn run(cx: &DataContext, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("get", "email.messages") => {
            let page = p["limit"].as_i64().map(|limit| (limit.clamp(1, 500), p["offset"].as_i64().unwrap_or(0).max(0)));
            messages(cx, p["id"].as_str(), page).await
        }
        ("get", "email.preferences") => {
            let keys: Vec<String> = p["keys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|k| k.as_str().map(String::from))
                .collect();
            preferences(cx, &keys).await
        }
        ("set", "email.preferences") => set_preferences(cx, p).await,
        ("get", "email.source-behaviors") => source(cx).await,
        ("set", "email.source-behaviors") => set_source(cx, p).await,
        ("get", "email.draft-policy") => draft_policy(cx).await,
        ("set", "email.draft-policy") => set_draft_policy(cx, p).await,
        ("set", "email.cache-write") => match p["action"].as_str() {
            Some("insert") => insert(cx, p).await,
            Some("update") => update(cx, p).await,
            Some("prune") => prune(cx, p).await,
            _ => bail!("Unknown cache action"),
        },
        ("get", "email.cache-keys") => cache_keys(cx, p).await,
        _ => bail!("Unknown email resource"),
    }
}

async fn messages(cx: &DataContext, id: Option<&str>, page: Option<(i64, i64)>) -> Result<Value> {
    let rows = match id {
        // A malformed id matches nothing, so the route answers not found.
        Some(id) => match Uuid::parse_str(id) {
            Ok(id) => {
                let sql = format!("{} WHERE m.id = $1 {ORDER}", message_select(TABLE));
                cx.db().query(&sql, &[&id]).await?
            }
            Err(_) => Vec::new(),
        },
        None => {
            // One bounded page per call keeps each host answer under the response limit.
            let (limit, offset) = page.unwrap_or((i64::MAX, 0));
            let sql = format!("{} {ORDER} LIMIT $1 OFFSET $2", message_select(TABLE));
            cx.db().query(&sql, &[&limit, &offset]).await?
        }
    };
    Ok(Value::Array(rows.iter().map(|row| row.get(0)).collect()))
}

async fn preferences(cx: &DataContext, keys: &[String]) -> Result<Value> {
    let keys: Vec<&String> = keys.iter().filter(|k| allowed(k)).collect();
    let rows = cx
        .db()
        .query(
            "SELECT key, value_json FROM app.preferences WHERE key = ANY($1)",
            &[&keys],
        )
        .await?;
    let mut out = Map::new();
    for row in rows {
        out.insert(row.get::<_, String>(0), row.get::<_, Value>(1));
    }
    Ok(Value::Object(out))
}

async fn upsert(cx: &DataContext, key: &str, value: &Value) -> Result<()> {
    cx.db()
        .execute(
            "INSERT INTO app.preferences(owner_user_id, key, value_json, updated_at)
             VALUES (app.current_actor_user_id(), $1, $2, now())
             ON CONFLICT (owner_user_id, key) DO UPDATE
               SET value_json = EXCLUDED.value_json,
                   revision = app.preferences.revision + 1,
                   updated_at = EXCLUDED.updated_at",
            &[&key, value],
        )
        .await?;
    Ok(())
}

/// Writes the named keys, then answers with every Email key stored for the person.
async fn set_preferences(cx: &DataContext, p: &Value) -> Result<Value> {
    let values = p["values"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Missing values"))?;
    for (key, value) in values {
        if !allowed(key) {
            bail!("Unknown email preference");
        }
        if key == TASK_MODE {
            if !matches!(value.as_str(), Some("off" | "suggest" | "auto_safe" | "auto")) {
                bail!("Invalid task creation mode");
            }
        } else if !value.is_boolean() {
            bail!("Invalid email signal");
        }
        upsert(cx, key, value).await?;
    }
    let mut keys: Vec<String> = SIGNAL_KEYS.iter().map(|k| k.to_string()).collect();
    keys.push(TASK_MODE.into());
    preferences(cx, &keys).await
}

async fn stored(cx: &DataContext, key: &str) -> Result<Value> {
    let row = cx
        .db()
        .query_opt("SELECT value_json FROM app.preferences WHERE key = $1", &[&key])
        .await?;
    Ok(row.map(|row| row.get(0)).unwrap_or(Value::Null))
}

async fn source(cx: &DataContext) -> Result<Value> {
    let behaviors = stored(cx, "sourceBehaviors").await?;
    Ok(match behaviors.get(BRIEFINGS_ENTRY).and_then(Value::as_bool) {
        Some(enabled) => json!({"enabled":enabled}),
        None => json!({}),
    })
}

/// Merges only the briefings entry so sibling modules' entries survive.
async fn set_source(cx: &DataContext, p: &Value) -> Result<Value> {
    let Some(enabled) = p["enabled"].as_bool() else {
        bail!("Invalid briefing switch");
    };
    let update = json!({BRIEFINGS_ENTRY: enabled});
    cx.db()
        .execute(
            "INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at)
             VALUES(app.current_actor_user_id(),'sourceBehaviors',$1,now())
             ON CONFLICT(owner_user_id,key) DO UPDATE SET
               value_json=(CASE WHEN jsonb_typeof(app.preferences.value_json)='object'
                                THEN app.preferences.value_json ELSE '{}'::jsonb END)
                          || EXCLUDED.value_json,
               revision=app.preferences.revision+1, updated_at=now()",
            &[&update],
        )
        .await?;
    Ok(json!({"saved":true}))
}

async fn draft_policy(cx: &DataContext) -> Result<Value> {
    Ok(match stored(cx, DRAFT_POLICY_KEY).await? {
        Value::String(tier) => json!({"tier":tier}),
        _ => json!({}),
    })
}

async fn set_draft_policy(cx: &DataContext, p: &Value) -> Result<Value> {
    let tier = text(p, "tier")?;
    if !matches!(tier, "trusted_auto" | "ask_each_time") {
        bail!("Invalid draft policy");
    }
    upsert(cx, DRAFT_POLICY_KEY, &json!(tier)).await?;
    Ok(json!({"saved":true}))
}

fn field_text(fields: &Value, name: &str) -> Option<String> {
    fields[name].as_str().map(String::from)
}

fn recipients(fields: &Value) -> Vec<String> {
    fields["recipients"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str().map(String::from))
        .collect()
}

fn object_or_empty(fields: &Value, name: &str) -> Value {
    if fields[name].is_object() {
        fields[name].clone()
    } else {
        json!({})
    }
}

async fn insert(cx: &DataContext, p: &Value) -> Result<Value> {
    let (Ok(account), Some(external)) = (
        Uuid::parse_str(text(p, "connectorAccountId")?),
        p["externalId"].as_str(),
    ) else {
        return Ok(json!({"rejected":true}));
    };
    let f = &p["fields"];
    let (recipients, metadata, signals) = (
        recipients(f),
        object_or_empty(f, "externalMetadata"),
        object_or_empty(f, "signals"),
    );
    let (sender, subject, received) = (
        field_text(f, "sender"),
        field_text(f, "subject"),
        field_text(f, "receivedAt"),
    );
    let (snippet, excerpt, summary) = (
        field_text(f, "snippet"),
        field_text(f, "bodyExcerpt"),
        field_text(f, "summary"),
    );
    let sql = format!(
        "WITH m AS (
           INSERT INTO app.email_messages
             (id, connector_account_id, owner_user_id, sender, recipients, subject, snippet,
              body_excerpt, received_at, external_id, external_metadata, summary, signals,
              created_at, updated_at)
           VALUES (gen_random_uuid(), $1, app.current_actor_user_id(), $2, $3, $4, $5, $6,
                   $7::text::timestamptz, $8, $9, $10, $11, now(), now())
           ON CONFLICT (connector_account_id, external_id) DO UPDATE SET
             sender = EXCLUDED.sender, recipients = EXCLUDED.recipients,
             subject = EXCLUDED.subject, snippet = EXCLUDED.snippet,
             body_excerpt = EXCLUDED.body_excerpt, received_at = EXCLUDED.received_at,
             external_metadata = EXCLUDED.external_metadata,
             analysis_attempts = CASE WHEN EXCLUDED.external_metadata->>'historyId'
               IS DISTINCT FROM app.email_messages.external_metadata->>'historyId'
               THEN 0 ELSE app.email_messages.analysis_attempts END,
             judgement_requested_at = CASE WHEN EXCLUDED.external_metadata->>'historyId'
               IS DISTINCT FROM app.email_messages.external_metadata->>'historyId'
               THEN NULL ELSE app.email_messages.judgement_requested_at END,
             summary = COALESCE(EXCLUDED.summary, app.email_messages.summary),
             signals = CASE WHEN $12 THEN EXCLUDED.signals ELSE app.email_messages.signals END,
             updated_at = now()
           RETURNING *)
         {}",
        message_select("m m")
    );
    let result = cx
        .db()
        .query_one(
            &sql,
            &[
                &account, &sender, &recipients, &subject, &snippet, &excerpt, &received,
                &external, &metadata, &summary, &signals, &f.get("signals").is_some_and(Value::is_object),
            ],
        )
        .await;
    match result {
        Ok(row) => Ok(row.get(0)),
        Err(error) if refusal(&error) => Ok(json!({"rejected":true})),
        Err(error) => Err(error.into()),
    }
}

/// Sync markers of the named cached messages of one account. `finished` repeats the old
/// rule for a saved first-pass verdict, so a sync leaves an unchanged finished message alone.
async fn cache_keys(cx: &DataContext, p: &Value) -> Result<Value> {
    let Ok(account) = Uuid::parse_str(text(p, "connectorAccountId")?) else {
        return Ok(json!([]));
    };
    let ids: Vec<String> = strings(&p["externalIds"]);
    let rows = cx
        .db()
        .query(
            "SELECT external_id, external_metadata->>'sizeBytes', external_metadata->>'historyId',
                    analysis_attempts,
                    (summary IS NOT NULL AND signals->'actionability' IS NOT NULL
                       AND jsonb_typeof(signals->'actionability') = 'object'
                       AND CASE
                         WHEN signals#>>'{actionability,category}' IN ('needs_action','needs_reply','time_sensitive_info')
                           THEN btrim(COALESCE(signals#>>'{actionability,inferredSubject}', '')) <> ''
                                AND jsonb_typeof(signals#>'{actionability,suggestedTasks}') = 'array'
                                AND jsonb_array_length(signals#>'{actionability,suggestedTasks}') > 0
                         ELSE COALESCE(signals#>>'{actionability,category}', 'unknown') <> 'unknown'
                       END)
                    OR signals->>'pendingJudgement' = 'true'
                    OR signals->>'skipped' = 'own_sent'
                    OR signals#>>'{actionability,category}' IN ('noise','receipt_or_notice')
               FROM app.email_messages
              WHERE connector_account_id = $1 AND external_id = ANY($2)",
            &[&account, &ids],
        )
        .await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                let size: Option<String> = r.get(1);
                let history: Option<String> = r.get(2);
                let attempts: i32 = r.get(3);
                let finished: Option<bool> = r.get(4);
                json!({
                    "externalId":r.get::<_, String>(0),
                    "sizeBytes":size.and_then(|s| s.parse::<i64>().ok()),
                    "historyId":history,
                    "analysisAttempts":attempts,
                    "finished":finished.unwrap_or(false),
                })
            })
            .collect(),
    ))
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect()
}

/// Deletes the account's cached messages with the given key prefix and a received time
/// inside the window that the server no longer lists. Older messages stay.
async fn prune(cx: &DataContext, p: &Value) -> Result<Value> {
    let (Ok(account), Some(prefix), Some(since)) = (
        Uuid::parse_str(text(p, "connectorAccountId")?),
        p["prefix"].as_str(),
        p["since"].as_str(),
    ) else {
        return Ok(json!({"deleted":0}));
    };
    let keep = strings(&p["keep"]);
    let like = format!("{}%", prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let deleted = cx
        .db()
        .execute(
            "DELETE FROM app.email_messages
              WHERE connector_account_id = $1 AND external_id LIKE $2
                AND COALESCE((external_metadata->>'arrivedAt')::timestamptz, received_at) >= $3::text::timestamptz
                AND NOT (external_id = ANY($4))",
            &[&account, &like, &since, &keep],
        )
        .await?;
    Ok(json!({"deleted":deleted}))
}

async fn update(cx: &DataContext, p: &Value) -> Result<Value> {
    let Ok(id) = Uuid::parse_str(text(p, "id")?) else {
        return Ok(Value::Null);
    };
    let touched = cx
        .db()
        .execute("UPDATE app.email_messages SET updated_at = now() WHERE id = $1", &[&id])
        .await?;
    if touched == 0 {
        return Ok(Value::Null);
    }
    let f = &p["fields"];
    for (name, column) in [
        ("sender", "sender"),
        ("subject", "subject"),
        ("snippet", "snippet"),
        ("bodyExcerpt", "body_excerpt"),
        ("summary", "summary"),
    ] {
        if f.get(name).is_some() {
            let value = field_text(f, name);
            let sql = format!("UPDATE app.email_messages SET {column} = $2 WHERE id = $1");
            cx.db().execute(&sql, &[&id, &value]).await?;
        }
    }
    if f.get("receivedAt").is_some() {
        let value = field_text(f, "receivedAt");
        cx.db()
            .execute(
                "UPDATE app.email_messages SET received_at = $2::text::timestamptz WHERE id = $1",
                &[&id, &value],
            )
            .await?;
    }
    if f.get("recipients").is_some() {
        cx.db()
            .execute(
                "UPDATE app.email_messages SET recipients = $2 WHERE id = $1",
                &[&id, &recipients(f)],
            )
            .await?;
    }
    for (name, column) in [("externalMetadata", "external_metadata"), ("signals", "signals")] {
        if f.get(name).is_some() {
            let sql = format!("UPDATE app.email_messages SET {column} = $2 WHERE id = $1");
            cx.db().execute(&sql, &[&id, &object_or_empty(f, name)]).await?;
        }
    }
    let sql = format!("{} WHERE m.id = $1", message_select(TABLE));
    Ok(cx.db().query_one(&sql, &[&id]).await?.get(0))
}
