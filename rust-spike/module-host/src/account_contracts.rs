//! Account policy routes and calendar days, inside the caller's RLS transaction.
//! Preference keys are derived from the installed module identity, never guest input.
use crate::{
    manifest::Manifest,
    runtime::{CallScope, Request},
};
use anyhow::{ensure, Context, Result};
use chrono::{DateTime, NaiveDate, Utc};
use safety_core::db::DataContext;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyTier {
    #[default]
    AskEachTime,
    AlwaysConfirm,
    TrustedAuto,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyRoute {
    #[serde(default)]
    pub install_tier: PolicyTier,
    #[serde(default)]
    pub legacy_boolean: Option<String>,
}
fn segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}
pub fn validate_routes(manifest: &Manifest) -> Result<()> {
    let mut aliases = std::collections::BTreeSet::new();
    for (family, route) in &manifest.policy_routes {
        ensure!(segment(family), "Invalid policy family");
        if let Some(alias) = &route.legacy_boolean {
            ensure!(
                segment(alias) && aliases.insert(alias),
                "Invalid or repeated legacy policy alias"
            );
        }
    }
    Ok(())
}
pub fn handles(port: &str, request: &Request) -> bool {
    (port == "action-policy" && matches!(request.operation.as_str(), "route-read" | "route-write"))
        || (port == "context" && request.operation == "local-date")
}
pub async fn invoke(
    cx: &DataContext,
    scope: &CallScope,
    port: &str,
    request: &Request,
) -> Result<Value> {
    crate::runtime::authorize(scope.module(), port, request)?;
    if port == "context" {
        ensure!(request.resource == "account", "Unknown date resource");
        return local_date(cx, &request.parameters, Utc::now()).await;
    }
    let route = scope
        .module()
        .policy_routes
        .get(&request.resource)
        .context("Policy route is not declared")?;
    let canonical = format!(
        "assistant.action_policy.v1.{}.{}",
        scope.module().id,
        request.resource
    );
    let legacy = route
        .legacy_boolean
        .as_ref()
        .map(|suffix| format!("{}.{suffix}", scope.module().id));
    let owner = scope.access().actor_user_id();
    if request.operation == "route-write" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Write {
            tier: PolicyTier,
        }
        let write: Write = serde_json::from_value(request.parameters.clone())?;
        let value = serde_json::to_value(&write.tier)?;
        for (key, val) in std::iter::once((&canonical, value.clone())).chain(
            legacy
                .as_ref()
                .map(|key| (key, json!(write.tier == PolicyTier::TrustedAuto))),
        ) {
            cx.db().execute("INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,revision=app.preferences.revision+1,updated_at=now()", &[&owner,key,&val]).await?;
        }
        return Ok(json!({"tier":value}));
    }
    ensure!(
        request.parameters == json!({}),
        "Policy read takes no parameters"
    );
    let keys = vec![canonical.clone(), legacy.clone().unwrap_or_default()];
    let rows = cx
        .db()
        .query(
            "SELECT key,value_json FROM app.preferences WHERE key=ANY($1::text[])",
            &[&keys],
        )
        .await?;
    let canonical_value = rows
        .iter()
        .find(|r| r.get::<_, String>(0) == canonical)
        .map(|r| r.get::<_, Value>(1));
    let legacy_value = rows
        .iter()
        .find(|r| Some(r.get::<_, String>(0)) == legacy)
        .map(|r| r.get::<_, Value>(1));
    let tier = if let Some(value) = canonical_value {
        value
    } else if let Some(value) = legacy_value {
        json!(if value == true {
            PolicyTier::TrustedAuto
        } else {
            PolicyTier::AskEachTime
        })
    } else {
        // Match install-time compatibility: insert only if neither key exists, then
        // reread. A concurrent explicit choice always wins over the install grant.
        cx.db()
            .batch_execute("SAVEPOINT account_policy_install")
            .await?;
        let inserted = cx.db().execute("INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) SELECT $1,$2,$3,now() WHERE NOT EXISTS(SELECT 1 FROM app.preferences WHERE owner_user_id=$1 AND key=ANY($4::text[])) ON CONFLICT(owner_user_id,key) DO NOTHING", &[&owner,&canonical,&serde_json::to_value(&route.install_tier)?,&keys]).await;
        if inserted.is_err() {
            cx.db().batch_execute("ROLLBACK TO SAVEPOINT account_policy_install; RELEASE SAVEPOINT account_policy_install").await?;
            return Ok(json!({"tier":PolicyTier::AskEachTime}));
        }
        cx.db()
            .batch_execute("RELEASE SAVEPOINT account_policy_install")
            .await?;
        cx.db()
            .query_opt(
                "SELECT value_json FROM app.preferences WHERE key=$1",
                &[&canonical],
            )
            .await?
            .map(|r| r.get(0))
            .unwrap_or(json!(PolicyTier::AskEachTime))
    };
    Ok(json!({"tier":tier}))
}

/// Returns consecutive local midnights, not a fixed 24-hour window. Offset days
/// are calendar days in the persisted zone. Invalid/missing zones retain legacy fallback.
pub async fn local_date(cx: &DataContext, parameters: &Value, now: DateTime<Utc>) -> Result<Value> {
    #[derive(Default, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        instant: Option<DateTime<Utc>>,
        date: Option<NaiveDate>,
        #[serde(default)]
        offset_days: i32,
    }
    let input: Input = serde_json::from_value(parameters.clone())?;
    ensure!(
        input.instant.is_none() || input.date.is_none(),
        "Choose an instant or a date"
    );
    ensure!(
        (-36600..=36600).contains(&input.offset_days),
        "Date offset is too large"
    );
    let instant = input.instant.unwrap_or(now).to_rfc3339();
    let date = input.date.map(|d| d.to_string());
    // PostgreSQL already carries the install's IANA timezone database. Use calendar
    // addition before converting midnight to an instant, including DST transitions.
    let row = cx.db().query_one(
        "WITH zone AS (SELECT coalesce((SELECT p.value_json->>'timezone' FROM app.preferences p WHERE p.key='locale' AND jsonb_typeof(p.value_json->'timezone')='string' AND EXISTS(SELECT 1 FROM pg_timezone_names WHERE lower(name)=lower(p.value_json->>'timezone') AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%')), 'America/Los_Angeles') AS tz), day AS (SELECT tz, coalesce($2::text::date, ($1::text::timestamptz AT TIME ZONE tz)::date) + $3::integer AS d FROM zone) SELECT jsonb_build_object('timezone',tz,'date',to_char(d,'YYYY-MM-DD'),'start',to_char(d::timestamp AT TIME ZONE tz AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'nextStart',to_char((d+1)::timestamp AT TIME ZONE tz AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'now',$4::text) FROM day",
        &[&instant,&date,&input.offset_days,&now.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)]
    ).await?;
    Ok(row.get(0))
}
