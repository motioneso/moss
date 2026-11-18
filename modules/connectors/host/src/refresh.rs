//! SQL for the `connectors.refresh-*` resources. Every statement runs in the caller's
//! transaction, so row-level security decides whose refresh rows are visible. Rows hold only
//! status, timestamps, bounded error codes and counts, never mail text.
use crate::store::{self, iso, text};
use anyhow::{bail, Result};
use moss_module_host::runtime::Request;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use uuid::Uuid;

/// Dispatch gives up on an account after this many failed queue attempts.
const MAX_DISPATCH_ATTEMPTS: i32 = 3;
/// An account that is still unfinished this long after the refresh started is failed.
const STALE_MINUTES: i32 = 15;
const TERMINAL: &str = "('succeeded','partial','failed')";
const ERROR_CODES: [&str; 7] = [
    "no-eligible-accounts",
    "no-active-connection",
    "auth-error",
    "email-error",
    "email-message-error",
    "email-needs-config",
    "enqueue-failed",
];

fn id(p: &Value, name: &str) -> Result<Uuid> {
    Uuid::parse_str(text(p, name)?).map_err(|_| anyhow::anyhow!("Invalid {name}"))
}

pub async fn run(cx: &DataContext, request: &Request) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("set", "connectors.refresh-request") => start_refresh(cx, id(p, "key")?).await,
        ("get", "connectors.refresh-status") => status(cx, id(p, "refreshId")?).await,
        ("get", "connectors.refresh-pending") => pending(cx, p["refreshId"].as_str()).await,
        ("set", "connectors.refresh-dispatch") => dispatched(cx, id(p, "refreshId")?, id(p, "accountId")?, p["ok"] == true).await,
        ("set", "connectors.refresh-account-start") => {
            begin(cx, id(p, "refreshId")?, id(p, "accountId")?, text(p, "provider")?).await
        }
        ("set", "connectors.refresh-account-finish") => finish(cx, p).await,
        ("set", "connectors.refresh-sweep") => sweep(cx).await,
        _ => bail!("Unknown connectors resource"),
    }
}

/// Whether the account can be refreshed now: connected, a mail provider, and Email granted.
fn eligible(account: &Value, stored: &Value) -> bool {
    let scopes: Vec<String> = account["scopes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(String::from))
        .collect();
    account["status"] == "active"
        && matches!(account["providerType"].as_str(), Some("google" | "imap"))
        && moss_connectors::grants::effective(&scopes, stored)["email"] == true
}

async fn eligible_accounts(cx: &DataContext) -> Result<Vec<(Uuid, String)>> {
    let mut found = Vec::new();
    for account in store::accounts(cx, "", None).await? {
        let Some(account_id) = account["id"].as_str() else { continue };
        let stored = store::preference(cx, &moss_connectors::grants::key(account_id)).await?;
        if eligible(&account, &stored) {
            found.push((Uuid::parse_str(account_id)?, account["providerType"].as_str().unwrap_or("").to_string()));
        }
    }
    found.sort();
    Ok(found)
}

/// Returns the refresh a request key already has, joins the person's active refresh, or
/// starts a new one. The advisory lock makes concurrent requests agree on one refresh.
async fn start_refresh(cx: &DataContext, key: Uuid) -> Result<Value> {
    let db = cx.db();
    db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", &[&format!("email-refresh:{}", cx.actor_user_id())])
        .await?;
    if let Some(row) = db
        .query_opt("SELECT refresh_id, (SELECT status IN ('queued','running') FROM app.connector_email_refreshes r WHERE r.id = k.refresh_id) FROM app.connector_email_refresh_keys k WHERE idempotency_key = $1", &[&key])
        .await?
    {
        let refresh: Uuid = row.get(0);
        let active: Option<bool> = row.get(1);
        return Ok(json!({"refreshId":refresh.to_string(),"created":false,"active":active.unwrap_or(false),"deduped":true}));
    }
    let alias = "INSERT INTO app.connector_email_refresh_keys(owner_user_id, idempotency_key, refresh_id)
                 VALUES (app.current_actor_user_id(), $1, $2) ON CONFLICT DO NOTHING";
    if let Some(row) = db
        .query_opt("SELECT id FROM app.connector_email_refreshes WHERE status IN ('queued','running') LIMIT 1", &[])
        .await?
    {
        let refresh: Uuid = row.get(0);
        db.execute(alias, &[&key, &refresh]).await?;
        return Ok(json!({"refreshId":refresh.to_string(),"created":false,"active":true,"deduped":true}));
    }
    let refresh = Uuid::new_v4();
    let accounts = eligible_accounts(cx).await?;
    if accounts.is_empty() {
        db.execute(
            "INSERT INTO app.connector_email_refreshes(id, owner_user_id, status, error_code, completed_at)
             VALUES ($1, app.current_actor_user_id(), 'failed', 'no-eligible-accounts', now())",
            &[&refresh],
        )
        .await?;
        db.execute(alias, &[&key, &refresh]).await?;
        return Ok(json!({"refreshId":refresh.to_string(),"created":true,"active":false,"deduped":false}));
    }
    db.execute(
        "INSERT INTO app.connector_email_refreshes(id, owner_user_id, status) VALUES ($1, app.current_actor_user_id(), 'queued')",
        &[&refresh],
    )
    .await?;
    for (account, provider) in &accounts {
        db.execute(
            "INSERT INTO app.connector_email_refresh_accounts(refresh_id, owner_user_id, account_id, provider_type, status)
             VALUES ($1, app.current_actor_user_id(), $2, $3::text::app.connector_provider_type, 'queued')",
            &[&refresh, account, provider],
        )
        .await?;
    }
    db.execute(alias, &[&key, &refresh]).await?;
    Ok(json!({"refreshId":refresh.to_string(),"created":true,"active":true,"deduped":false}))
}

/// The safe status shape. Another person's refresh is not visible, so it reads as missing.
async fn status(cx: &DataContext, refresh: Uuid) -> Result<Value> {
    let sql = format!(
        "SELECT jsonb_build_object(
           'refreshId', r.id::text, 'status', r.status, 'createdAt', {created},
           'startedAt', {started}, 'completedAt', {completed}, 'errorCode', r.error_code,
           'accounts', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'accountId', a.account_id::text, 'providerType', a.provider_type::text,
               'status', a.status, 'startedAt', {a_started}, 'completedAt', {a_completed},
               'counts', jsonb_build_object('emailUpserted', a.email_upserted, 'emailFailures', a.email_failures),
               'errorCode', a.error_code) ORDER BY a.account_id)
             FROM app.connector_email_refresh_accounts a WHERE a.refresh_id = r.id), '[]'::jsonb))
         FROM app.connector_email_refreshes r WHERE r.id = $1",
        created = iso("r.created_at"),
        started = iso("r.started_at"),
        completed = iso("r.completed_at"),
        a_started = iso("a.started_at"),
        a_completed = iso("a.completed_at"),
    );
    Ok(cx.db().query_opt(&sql, &[&refresh]).await?.map_or(Value::Null, |row| row.get(0)))
}

/// Account rows still waiting for a job. The key is fixed per row, so queuing a row twice
/// makes one job.
async fn pending(cx: &DataContext, refresh: Option<&str>) -> Result<Value> {
    let rows = cx
        .db()
        .query(
            "SELECT jsonb_build_object('refreshId', refresh_id::text, 'accountId', account_id::text,
                      'provider', provider_type::text,
                      'dedupeKey', md5(refresh_id::text || account_id::text)::uuid::text)
             FROM app.connector_email_refresh_accounts
             WHERE dispatch_status = 'pending' AND status = 'queued' AND dispatch_attempts < $2
               AND ($1::text IS NULL OR refresh_id::text = $1)
             ORDER BY refresh_id, account_id LIMIT 50",
            &[&refresh, &MAX_DISPATCH_ATTEMPTS],
        )
        .await?;
    Ok(Value::Array(rows.iter().map(|row| row.get(0)).collect()))
}

/// Marks a row sent, or counts a failed send and fails the row on its last attempt.
async fn dispatched(cx: &DataContext, refresh: Uuid, account: Uuid, ok: bool) -> Result<Value> {
    let db = cx.db();
    if ok {
        db.execute(
            "UPDATE app.connector_email_refresh_accounts SET dispatch_status = 'dispatched'
             WHERE refresh_id = $1 AND account_id = $2 AND status = 'queued' AND dispatch_status = 'pending'",
            &[&refresh, &account],
        )
        .await?;
        return Ok(json!({"ok":true}));
    }
    let attempts: Option<i32> = db
        .query_opt(
            "UPDATE app.connector_email_refresh_accounts SET dispatch_attempts = dispatch_attempts + 1
             WHERE refresh_id = $1 AND account_id = $2 AND status = 'queued' AND dispatch_status = 'pending'
             RETURNING dispatch_attempts",
            &[&refresh, &account],
        )
        .await?
        .map(|row| row.get(0));
    if attempts.is_some_and(|n| n >= MAX_DISPATCH_ATTEMPTS) {
        lock_parent(cx, refresh).await?;
        db.execute(
            "UPDATE app.connector_email_refresh_accounts
             SET status = 'failed', error_code = 'enqueue-failed', completed_at = now()
             WHERE refresh_id = $1 AND account_id = $2 AND status = 'queued'",
            &[&refresh, &account],
        )
        .await?;
        aggregate(cx, refresh).await?;
    }
    Ok(json!({"ok":true}))
}

/// Locks the parent row so account updates and the rollup of one refresh run one at a time.
async fn lock_parent(cx: &DataContext, refresh: Uuid) -> Result<Option<String>> {
    Ok(cx
        .db()
        .query_opt("SELECT status FROM app.connector_email_refreshes WHERE id = $1 FOR UPDATE", &[&refresh])
        .await?
        .map(|row| row.get(0)))
}

/// Sets the parent once every account has an outcome. All succeeded is succeeded, all failed
/// is failed, anything else is partial. One shared error code is kept, several are dropped.
async fn aggregate(cx: &DataContext, refresh: Uuid) -> Result<()> {
    let rows = cx
        .db()
        .query(
            "SELECT status, error_code FROM app.connector_email_refresh_accounts WHERE refresh_id = $1",
            &[&refresh],
        )
        .await?;
    let accounts: Vec<(String, Option<String>)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    if accounts.is_empty() || accounts.iter().any(|(s, _)| s == "queued" || s == "running") {
        return Ok(());
    }
    let status = if accounts.iter().all(|(s, _)| s == "succeeded") {
        "succeeded"
    } else if accounts.iter().all(|(s, _)| s == "failed") {
        "failed"
    } else {
        "partial"
    };
    let mut codes: Vec<&str> = accounts.iter().filter_map(|(_, c)| c.as_deref()).collect();
    codes.sort_unstable();
    codes.dedup();
    let code = (codes.len() == 1).then(|| codes[0].to_string());
    cx.db()
        .execute(
            "UPDATE app.connector_email_refreshes SET status = $2, error_code = $3, completed_at = now()
             WHERE id = $1 AND status IN ('queued','running')",
            &[&refresh, &status, &code],
        )
        .await?;
    Ok(())
}

/// Starts one account's run. The state is `started` when the job should sync and `skip` when
/// it should do nothing. An account that cannot be refreshed is failed here with the reason.
async fn begin(cx: &DataContext, refresh: Uuid, account: Uuid, provider: &str) -> Result<Value> {
    let db = cx.db();
    let skip = || Ok(json!({"state":"skip"}));
    match lock_parent(cx, refresh).await?.as_deref() {
        Some("queued" | "running") => {}
        _ => return skip(),
    }
    let Some(row) = db
        .query_opt(
            "SELECT status, provider_type::text FROM app.connector_email_refresh_accounts
             WHERE refresh_id = $1 AND account_id = $2 FOR UPDATE",
            &[&refresh, &account],
        )
        .await?
    else {
        return skip();
    };
    let (state, row_provider): (String, String) = (row.get(0), row.get(1));
    match state.as_str() {
        "running" => return Ok(json!({"state":"started"})),
        "queued" => {}
        _ => return skip(),
    }
    let found = store::accounts(cx, "WHERE a.id::text = $1::text", Some(&account.to_string())).await?;
    let problem = match found.first() {
        None => Some("no-active-connection"),
        Some(a) if a["status"] != "active" || a["providerType"] != provider || row_provider != provider => {
            Some("no-active-connection")
        }
        Some(a) => {
            let stored = store::preference(cx, &moss_connectors::grants::key(&account.to_string())).await?;
            (!eligible(a, &stored)).then_some("email-needs-config")
        }
    };
    if let Some(code) = problem {
        settle(cx, refresh, account, "failed", Some(code), 0, 0).await?;
        return skip();
    }
    db.execute(
        "UPDATE app.connector_email_refresh_accounts SET status = 'running', started_at = COALESCE(started_at, now())
         WHERE refresh_id = $1 AND account_id = $2",
        &[&refresh, &account],
    )
    .await?;
    db.execute(
        "UPDATE app.connector_email_refreshes SET status = 'running', started_at = COALESCE(started_at, now())
         WHERE id = $1 AND status IN ('queued','running')",
        &[&refresh],
    )
    .await?;
    Ok(json!({"state":"started"}))
}

/// Records one account's outcome, then rolls the refresh up. A row that already finished keeps
/// its first outcome.
async fn settle(cx: &DataContext, refresh: Uuid, account: Uuid, status: &str, error: Option<&str>, upserted: i32, failures: i32) -> Result<()> {
    if !matches!(status, "succeeded" | "partial" | "failed") {
        bail!("Invalid status");
    }
    let error = error.map(|e| if ERROR_CODES.contains(&e) { e } else { "email-error" });
    lock_parent(cx, refresh).await?;
    cx.db()
        .execute(
            "UPDATE app.connector_email_refresh_accounts
             SET status = $3, error_code = $4, email_upserted = $5, email_failures = $6, completed_at = now()
             WHERE refresh_id = $1 AND account_id = $2 AND status IN ('queued','running')",
            &[&refresh, &account, &status, &error, &upserted, &failures],
        )
        .await?;
    aggregate(cx, refresh).await
}

async fn finish(cx: &DataContext, p: &Value) -> Result<Value> {
    let count = |name: &str| i32::try_from(p["counts"][name].as_u64().unwrap_or(0)).unwrap_or(i32::MAX);
    settle(
        cx,
        id(p, "refreshId")?,
        id(p, "accountId")?,
        text(p, "status")?,
        p["error"].as_str(),
        count("emailUpserted"),
        count("emailFailures"),
    )
    .await?;
    Ok(json!({"ok":true}))
}

/// Fails accounts that stayed unfinished too long, then says whether rows still wait for a job
/// and whether the person still has an active refresh.
async fn sweep(cx: &DataContext) -> Result<Value> {
    let db = cx.db();
    let stale = db
        .query(
            "SELECT DISTINCT a.refresh_id FROM app.connector_email_refresh_accounts a
             JOIN app.connector_email_refreshes r ON r.id = a.refresh_id
             WHERE a.status IN ('queued','running') AND a.dispatch_status = 'dispatched'
               AND r.created_at < now() - make_interval(mins => $1)",
            &[&STALE_MINUTES],
        )
        .await?;
    for row in stale {
        let refresh: Uuid = row.get(0);
        lock_parent(cx, refresh).await?;
        db.execute(
            "UPDATE app.connector_email_refresh_accounts
             SET status = 'failed', error_code = 'email-error', completed_at = now()
             WHERE refresh_id = $1 AND status IN ('queued','running') AND dispatch_status = 'dispatched'",
            &[&refresh],
        )
        .await?;
        aggregate(cx, refresh).await?;
    }
    let row = db
        .query_one(
            &format!(
                "SELECT EXISTS (SELECT 1 FROM app.connector_email_refresh_accounts
                                WHERE dispatch_status = 'pending' AND status = 'queued' AND dispatch_attempts < $1),
                        EXISTS (SELECT 1 FROM app.connector_email_refreshes WHERE status NOT IN {TERMINAL})"
            ),
            &[&MAX_DISPATCH_ATTEMPTS],
        )
        .await?;
    Ok(json!({"pending":row.get::<_, bool>(0),"active":row.get::<_, bool>(1)}))
}
