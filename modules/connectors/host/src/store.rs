//! SQL for the `connectors.*` resources. Every statement runs in the caller's
//! transaction, so row-level security decides what is visible.
use anyhow::{bail, Result};
use moss_module_host::runtime::Request;
use portability::secrets::JsonSecretCipher;
use safety_core::db::DataContext;
use serde_json::{json, Map, Value};
use uuid::Uuid;

const ISO: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

pub(crate) fn iso(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', {ISO})")
}

/// The safe account shape. The encrypted secret is never selected, only whether one exists.
fn account_select(from: &str) -> String {
    format!(
        "SELECT jsonb_build_object(
           'id', a.id::text, 'providerId', a.provider_id,
           'providerType', d.provider_type::text, 'providerDisplayName', d.display_name,
           'providerStatus', d.status::text, 'ownerUserId', a.owner_user_id::text,
           'scopes', to_jsonb(a.scopes), 'status', a.status::text,
           'hasSecret', a.encrypted_secret IS NOT NULL,
           'revokedAt', {revoked}, 'createdAt', {created}, 'updatedAt', {updated},
           'lastSyncStartedAt', {started}, 'lastSyncFinishedAt', {finished},
           'lastSyncStatus', a.last_sync_status, 'lastSyncError', a.last_sync_error,
           'lastSyncCounts', a.last_sync_counts)
         FROM {from}",
        revoked = iso("a.revoked_at"),
        created = iso("a.created_at"),
        updated = iso("a.updated_at"),
        started = iso("a.last_sync_started_at"),
        finished = iso("a.last_sync_finished_at"),
    )
}

const OWN: &str = "app.connector_accounts a JOIN app.connector_definitions d ON d.provider_id = a.provider_id";
const ORDER: &str = "ORDER BY a.created_at DESC, a.id";

const COUNT_KEYS: [&str; 7] = [
    "calendarUpserted",
    "calendarReconciled",
    "emailUpserted",
    "emailFailures",
    "escalations",
    "truncated",
    "emailDeferred",
];

/// The response schema lists the sync counts it allows. Anything else is dropped.
fn scrub_counts(account: &mut Value) {
    if account["lastSyncCounts"].is_array() {
        account["lastSyncCounts"] = Value::Object(Map::new());
        return;
    }
    let Some(counts) = account["lastSyncCounts"].as_object() else {
        return;
    };
    let mut kept = Map::new();
    for key in COUNT_KEYS {
        if let Some(value) = counts.get(key).filter(|v| v.is_number() || v.is_boolean()) {
            kept.insert(key.into(), value.clone());
        }
    }
    if let Some(detail) = counts.get("emailErrorDetail").and_then(Value::as_object) {
        // The response schema allows an integer or null status and string or null text fields.
        let mut inner = Map::new();
        for (key, allowed) in [
            ("status", (|v: &Value| v.is_i64() || v.is_u64()) as fn(&Value) -> bool),
            ("reason", Value::is_string),
            ("operation", Value::is_string),
        ] {
            if let Some(value) = detail.get(key).filter(|v| v.is_null() || allowed(v)) {
                inner.insert(key.into(), value.clone());
            }
        }
        kept.insert("emailErrorDetail".into(), Value::Object(inner));
    }
    account["lastSyncCounts"] = Value::Object(kept);
}

pub(crate) async fn accounts(cx: &DataContext, filter: &str, id: Option<&str>) -> Result<Vec<Value>> {
    let sql = format!("{} {filter} {ORDER}", account_select(OWN));
    let rows = match id {
        Some(id) => cx.db().query(&sql, &[&id]).await?,
        None => cx.db().query(&sql, &[]).await?,
    };
    Ok(rows
        .iter()
        .map(|row| {
            let mut account: Value = row.get(0);
            scrub_counts(&mut account);
            account
        })
        .collect())
}

/// A database refusal the old server reported as a 400 (foreign key, row-level
/// security, duplicate key). Anything else stays an error.
fn refusal(error: &tokio_postgres::Error) -> bool {
    error
        .code()
        .is_some_and(|code| matches!(code.code(), "23503" | "42501" | "23505"))
}

pub(crate) fn text<'a>(parameters: &'a Value, name: &str) -> Result<&'a str> {
    parameters[name]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing {name}"))
}

pub async fn run(cx: &DataContext, cipher: &JsonSecretCipher, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("get", "connectors.providers") => providers(cx).await,
        ("get", "connectors.accounts") => {
            let rows = match p["id"].as_str() {
                Some(id) => accounts(cx, "WHERE a.id::text = $1::text", Some(id)).await?,
                None => accounts(cx, "", None).await?,
            };
            Ok(Value::Array(rows))
        }
        ("set", "connectors.account-write") => write(cx, cipher, p).await,
        ("get", "connectors.feature-grants") => {
            let key = moss_connectors::grants::key(text(p, "accountId")?);
            Ok(preference(cx, &key).await?)
        }
        ("set", "connectors.feature-grants") => set_grants(cx, p).await,
        ("set", "connectors.outlook-health") => set_outlook_health(cx, p).await,
        ("set", "connectors.monitor-status") => monitor_status(cx, p).await,
        ("get", "connectors.admin-accounts") => admin(cx).await,
        ("get", "connectors.diagnostics") => diagnostics(cx, p["limit"].as_i64().unwrap_or(11)).await,
        _ => bail!("Unknown connectors resource"),
    }
}

async fn providers(cx: &DataContext) -> Result<Value> {
    let sql = format!(
        "SELECT jsonb_build_object('id', provider_id, 'providerType', provider_type::text,
           'displayName', display_name, 'status', status::text,
           'defaultScopes', to_jsonb(default_scopes),
           'createdAt', {}, 'updatedAt', {})
         FROM app.connector_definitions ORDER BY provider_type, display_name",
        iso("created_at"),
        iso("updated_at")
    );
    let rows = cx.db().query(&sql, &[]).await?;
    Ok(Value::Array(rows.iter().map(|row| row.get(0)).collect()))
}

async fn write(cx: &DataContext, cipher: &JsonSecretCipher, p: &Value) -> Result<Value> {
    let action = text(p, "action")?;
    let outcome = match action {
        "create" => create(cx, cipher, p).await,
        "update" => update(cx, cipher, p).await,
        "revoke" => revoke(cx, cipher, p).await,
        _ => bail!("Unknown connector write"),
    };
    match outcome {
        Ok(value) => Ok(value),
        Err(error) => match error.downcast_ref::<tokio_postgres::Error>() {
            Some(db) if refusal(db) => Ok(json!({"rejected":true})),
            _ => Err(error),
        },
    }
}

pub(crate) fn seal(cipher: &JsonSecretCipher, payload: &Value) -> Result<Value> {
    let object = payload
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Secret payload must be an object"))?;
    Ok(cipher.encrypt_json(object))
}

async fn visible(cx: &DataContext, id: Uuid) -> Result<Value> {
    accounts(cx, "WHERE a.id = $1::text::uuid", Some(&id.to_string()))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("Connector account is not visible after write"))
}

pub(crate) async fn create(cx: &DataContext, cipher: &JsonSecretCipher, p: &Value) -> Result<Value> {
    let id = Uuid::new_v4();
    let scopes: Vec<String> = serde_json::from_value(p["scopes"].clone())?;
    let secret = seal(cipher, &p["tokenPayload"])?;
    cx.db()
        .execute(
            "INSERT INTO app.connector_accounts
               (id, provider_id, owner_user_id, scopes, status, encrypted_secret, revoked_at, created_at, updated_at)
             VALUES ($1, $2, app.current_actor_user_id(), $3, $4::text::app.connector_account_status, $5, NULL, now(), now())",
            &[&id, &text(p, "providerId")?, &scopes, &text(p, "status")?, &secret],
        )
        .await?;
    visible(cx, id).await
}

/// Only the canonical lowercase spelling names an account. Another spelling of the same id would
/// pass the database lookup but miss the route's text lookups and guards, so it counts as not found.
fn canonical_id(p: &Value) -> Result<Option<Uuid>> {
    let raw = text(p, "id")?;
    let id: Uuid = raw.parse()?;
    Ok((id.to_string() == raw).then_some(id))
}

pub(crate) async fn update(cx: &DataContext, cipher: &JsonSecretCipher, p: &Value) -> Result<Value> {
    let Some(id) = canonical_id(p)? else {
        return Ok(Value::Null);
    };
    let scopes: Option<Vec<String>> = match &p["scopes"] {
        Value::Null => None,
        value => Some(serde_json::from_value(value.clone())?),
    };
    let status = p["status"].as_str();
    let secret = match &p["tokenPayload"] {
        Value::Null => None,
        payload => Some(seal(cipher, payload)?),
    };
    // A provided status is a reactivation, so it also clears the revoke time.
    let changed = cx
        .db()
        .execute(
            "UPDATE app.connector_accounts SET
               updated_at = now(),
               scopes = COALESCE($2, scopes),
               status = COALESCE($3::text::app.connector_account_status, status),
               revoked_at = CASE WHEN $3::text IS NULL THEN revoked_at ELSE NULL END,
               encrypted_secret = COALESCE($4, encrypted_secret)
             WHERE id = $1",
            &[&id, &scopes, &status, &secret],
        )
        .await?;
    if changed == 0 {
        return Ok(Value::Null);
    }
    visible(cx, id).await
}

async fn revoke(cx: &DataContext, cipher: &JsonSecretCipher, p: &Value) -> Result<Value> {
    let Some(id) = canonical_id(p)? else {
        return Ok(Value::Null);
    };
    let secret = cipher.encrypt_json(json!({"revoked":true}).as_object().expect("object"));
    let changed = cx
        .db()
        .execute(
            "UPDATE app.connector_accounts SET
               encrypted_secret = $2, status = 'revoked', revoked_at = now(), updated_at = now()
             WHERE id = $1",
            &[&id, &secret],
        )
        .await?;
    if changed == 0 {
        return Ok(Value::Null);
    }
    visible(cx, id).await
}

pub(crate) async fn preference(cx: &DataContext, key: &str) -> Result<Value> {
    let row = cx
        .db()
        .query_opt("SELECT value_json FROM app.preferences WHERE key = $1", &[&key])
        .await?;
    Ok(row.map(|row| row.get(0)).unwrap_or(Value::Null))
}

async fn set_grants(cx: &DataContext, p: &Value) -> Result<Value> {
    let account = text(p, "accountId")?;
    let found = cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.connector_accounts WHERE id::text = $1::text",
            &[&account],
        )
        .await?;
    if found.is_none() {
        return Ok(Value::Null);
    }
    let key = moss_connectors::grants::key(account);
    cx.db()
        .execute(
            "INSERT INTO app.preferences(owner_user_id, key, value_json, updated_at)
             VALUES (app.current_actor_user_id(), $1, $2, now())
             ON CONFLICT (owner_user_id, key) DO UPDATE
               SET value_json = EXCLUDED.value_json,
                   revision = app.preferences.revision + 1,
                   updated_at = EXCLUDED.updated_at",
            &[&key, &p["value"]],
        )
        .await?;
    for entry in p["audit"].as_array().into_iter().flatten() {
        let feature = entry["feature"].as_str().unwrap_or("");
        let metadata = json!({"feature":feature,"enabled":entry["enabled"]});
        cx.db()
            .execute(
                "INSERT INTO app.admin_audit_events
                   (id, actor_user_id, action, target_type, target_id, metadata, request_id, created_at)
                 VALUES ($1, $2, 'connector.feature_grant.set', 'connector_account', $3, $4, $5, now())",
                &[
                    &Uuid::new_v4(),
                    &cx.actor_user_id(),
                    &account,
                    &metadata,
                    &cx.access().request_id(),
                ],
            )
            .await?;
    }
    Ok(json!({"saved":true}))
}

async fn admin(cx: &DataContext) -> Result<Value> {
    let user = cx
        .db()
        .query_opt(
            "SELECT is_instance_admin FROM app.get_user_by_id($1)",
            &[&cx.actor_user_id()],
        )
        .await?;
    let Some(user) = user else {
        return Ok(json!({"status":"unauthenticated"}));
    };
    if !user.get::<_, bool>(0) {
        return Ok(json!({"status":"forbidden"}));
    }
    let sql = format!(
        "SELECT jsonb_build_object(
           'id', a.id::text, 'providerId', a.provider_id,
           'providerType', a.provider_type::text, 'providerDisplayName', a.provider_display_name,
           'providerStatus', a.provider_status::text, 'ownerUserId', a.owner_user_id::text,
           'scopes', to_jsonb(a.scopes), 'status', a.status::text, 'hasSecret', a.has_secret,
           'revokedAt', {}, 'createdAt', {}, 'updatedAt', {},
           'lastSyncStartedAt', {}, 'lastSyncFinishedAt', {},
           'lastSyncStatus', a.last_sync_status, 'lastSyncError', a.last_sync_error,
           'lastSyncCounts', a.last_sync_counts)
         FROM app.list_connector_account_safe_metadata() a",
        iso("a.revoked_at"),
        iso("a.created_at"),
        iso("a.updated_at"),
        iso("a.last_sync_started_at"),
        iso("a.last_sync_finished_at"),
    );
    let rows = cx.db().query(&sql, &[]).await?;
    let accounts: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut account: Value = row.get(0);
            scrub_counts(&mut account);
            account
        })
        .collect();
    Ok(json!({"status":"ok","accounts":accounts}))
}

async fn diagnostics(cx: &DataContext, limit: i64) -> Result<Value> {
    let sql = format!(
        "SELECT jsonb_build_object('id', id::text, 'providerId', provider_id, 'status', status::text,
           'revokedAt', {}, 'lastSyncStartedAt', {}, 'lastSyncFinishedAt', {},
           'lastSyncStatus', last_sync_status::text, 'errorLabel', {LABEL},
           'previousStatus', previous_sync->>'status', 'previousFinishedAt', previous_sync->>'finishedAt')
         FROM app.connector_accounts ORDER BY created_at DESC, id LIMIT $1",
        iso("revoked_at"),
        iso("last_sync_started_at"),
        iso("last_sync_finished_at"),
    );
    let rows: Vec<Value> = cx
        .db()
        .query(&sql, &[&limit.clamp(1, 11)])
        .await?
        .iter()
        .map(|row| row.get(0))
        .collect();
    let keys: Vec<String> = rows
        .iter()
        .filter(|row| row["providerId"] == moss_connectors::health::OUTLOOK_PROVIDER)
        .filter_map(|row| row["id"].as_str())
        .map(moss_connectors::health::outlook_key)
        .collect();
    let mut outlook = Map::new();
    for key in keys {
        let id = key.split('.').nth(1).unwrap_or("").to_string();
        outlook.insert(id, preference(cx, &key).await?);
    }
    Ok(json!({"rows":rows,"outlook":outlook}))
}

/// Reduces the stored error text to one fixed label, inside the query.
const LABEL: &str = "case
  when last_sync_error is null or btrim(last_sync_error) = '' then null
  when lower(btrim(last_sync_error)) in
    ('auth-error', 'no-active-connection', 'disconnected', 'rate-limited', 'network-error')
    then lower(btrim(last_sync_error))
  when last_sync_error ~* '(\\y(401|403)\\y|unauthori[sz]ed|invalid_grant|auth|forbidden|sign.?in)'
    then 'auth-error'
  when last_sync_error ~* '(\\y429\\y|rate.?limit|quota)' then 'rate-limited'
  when last_sync_error ~* '(timeout|timed out|econn|enotfound|ehostunreach|network|socket|unreachable)'
    then 'network-error'
  else 'sync-error'
end";

/// Saves a monitor's health row under the signed-in person. The account must be theirs.
async fn monitor_status(cx: &DataContext, p: &Value) -> Result<Value> {
    let account = text(p, "accountId")?;
    let found = cx
        .db()
        .query_opt("SELECT 1 FROM app.connector_accounts WHERE id::text = $1::text", &[&account])
        .await?;
    if found.is_none() {
        return Ok(Value::Null);
    }
    let key = format!("connector.{account}.monitor_status");
    cx.db()
        .execute(
            "INSERT INTO app.preferences(owner_user_id, key, value_json, updated_at)
             VALUES (app.current_actor_user_id(), $1, $2, now())
             ON CONFLICT (owner_user_id, key) DO UPDATE
               SET value_json = EXCLUDED.value_json,
                   revision = app.preferences.revision + 1,
                   updated_at = EXCLUDED.updated_at",
            &[&key, &p["record"]],
        )
        .await?;
    Ok(json!({"saved":true}))
}

/// Saves the Outlook reader's health for one of the person's Outlook accounts.
async fn set_outlook_health(cx: &DataContext, p: &Value) -> Result<Value> {
    let account = text(p, "accountId")?;
    let found = cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.connector_accounts WHERE id::text = $1::text AND provider_id = $2",
            &[&account, &moss_connectors::health::OUTLOOK_PROVIDER],
        )
        .await?;
    if found.is_none() {
        return Ok(json!({"saved":false}));
    }
    let key = moss_connectors::health::outlook_key(account);
    // A fenced write lands only while the stored health still names this run as current.
    if let Some(run) = p["fenceRun"].as_str() {
        let changed = cx
            .db()
            .execute(
                "UPDATE app.preferences
                    SET value_json = $2, revision = revision + 1, updated_at = now()
                  WHERE owner_user_id = app.current_actor_user_id() AND key = $1
                    AND value_json->>'currentRun' = $3::text",
                &[&key, &p["value"], &run],
            )
            .await?;
        return Ok(json!({"saved":changed > 0}));
    }
    cx.db()
        .execute(
            "INSERT INTO app.preferences(owner_user_id, key, value_json, updated_at)
             VALUES (app.current_actor_user_id(), $1, $2, now())
             ON CONFLICT (owner_user_id, key) DO UPDATE
               SET value_json = EXCLUDED.value_json,
                   revision = app.preferences.revision + 1,
                   updated_at = EXCLUDED.updated_at",
            &[&key, &p["value"]],
        )
        .await?;
    Ok(json!({"saved":true}))
}
