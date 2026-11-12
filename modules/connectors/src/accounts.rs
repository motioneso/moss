//! Account routes. Every read and write goes through the host's `connectors.*` resources.
use crate::{fastify, google_sync, grants, health, kv, mail_sync, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

const NOT_FOUND: &str = "Connector account not found";
const OUTLOOK_MESSAGE: &str = "Use the dedicated Outlook calendar connection.";

pub fn providers(host: &impl Host) -> Result<Value> {
    Ok(json!({"providers":kv(host, "get", "connectors.providers", json!({}))?}))
}

pub fn list(host: &impl Host) -> Result<Value> {
    let accounts = kv(host, "get", "connectors.accounts", json!({}))?;
    for account in accounts.as_array().into_iter().flatten() {
        keep_schedule(host, account);
    }
    Ok(json!({"accounts":accounts}))
}

/// Mail accounts that are not revoked have a sync schedule, and revoked ones have none.
fn keep_schedule(host: &impl Host, account: &Value) {
    let (Some(id), Some(provider)) = (account["id"].as_str(), account["providerId"].as_str()) else {
        return;
    };
    let google = provider == "google";
    if !google && !mail_sync::is_mail_provider(provider) {
        return;
    }
    match (google, account["status"] == "revoked") {
        (true, true) => google_sync::cancel_schedule(host, id),
        (true, false) => google_sync::reconcile_schedule(host, id),
        (false, true) => mail_sync::cancel_schedule(host, id),
        (false, false) => mail_sync::reconcile_schedule(host, id),
    }
}

fn find(host: &impl Host, id: &str) -> Result<Option<Value>> {
    let rows = kv(host, "get", "connectors.accounts", json!({"id":id}))?;
    Ok(rows.as_array().and_then(|rows| rows.first().cloned()))
}

/// The host answers null for no such account and `rejected` for a database refusal.
fn written(result: Value) -> Result<Value> {
    if result.is_null() {
        return Err(Error::new(404, NOT_FOUND));
    }
    if result["rejected"] == true {
        return Err(Error::new(400, "Connector account request is invalid"));
    }
    Ok(json!({"account":result}))
}

struct Fields {
    scopes: Option<Vec<String>>,
    status: Option<String>,
    token_payload: Option<Map<String, Value>>,
}

fn parse_scopes(body: &Map<String, Value>) -> Result<Option<Vec<String>>> {
    let Some(value) = body.get("scopes") else {
        return Ok(None);
    };
    fastify::string_array(value, "scopes")?
        .iter()
        .enumerate()
        .map(|(i, scope)| fastify::trimmed(scope, &format!("scopes[{i}]")))
        .collect::<Result<Vec<_>>>()
        .map(Some)
}

fn parse_fields(body: &Map<String, Value>) -> Result<Fields> {
    let token_payload = match body.get("tokenPayload") {
        Some(value) => Some(fastify::token_payload(value)?),
        None => None,
    };
    let status = match body.get("status") {
        Some(value) => Some(fastify::status(value)?),
        None => None,
    };
    Ok(Fields {
        scopes: parse_scopes(body)?,
        status,
        token_payload,
    })
}

pub fn create(host: &impl Host, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    fastify::required(body, &["providerId", "tokenPayload"])?;
    let provider = fastify::string(&body["providerId"], "providerId")?;
    let fields = parse_fields(body)?;
    let provider = fastify::trimmed(&provider, "providerId")?;
    if provider == health::OUTLOOK_PROVIDER {
        return Err(Error::new(403, OUTLOOK_MESSAGE));
    }
    let result = kv(
        host,
        "set",
        "connectors.account-write",
        json!({
            "action": "create",
            "providerId": provider,
            "scopes": fields.scopes.unwrap_or_default(),
            "status": fields.status.unwrap_or_else(|| "active".into()),
            "tokenPayload": fields.token_payload,
        }),
    )?;
    written(result)
}

pub fn update(host: &impl Host, id: &str, body: &Value) -> Result<Value> {
    let saved = update_account(host, id, body)?;
    keep_schedule(host, &saved["account"]);
    Ok(saved)
}

fn update_account(host: &impl Host, id: &str, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    let fields = parse_fields(body)?;
    if find(host, id)?.is_some_and(|row| row["providerId"] == health::OUTLOOK_PROVIDER) {
        return Err(Error::new(403, OUTLOOK_MESSAGE));
    }
    let result = kv(
        host,
        "set",
        "connectors.account-write",
        json!({
            "action": "update",
            "id": id,
            "scopes": fields.scopes,
            "status": fields.status,
            "tokenPayload": fields.token_payload,
        }),
    )?;
    written(result)
}

pub fn revoke(host: &impl Host, id: &str) -> Result<Value> {
    let saved = written(kv(
        host,
        "set",
        "connectors.account-write",
        json!({"action":"revoke","id":id}),
    )?)?;
    keep_schedule(host, &saved["account"]);
    Ok(saved)
}

fn stored_grants(host: &impl Host, id: &str) -> Result<Option<(Vec<String>, Value)>> {
    let Some(account) = find(host, id)? else {
        return Ok(None);
    };
    let scopes = account["scopes"]
        .as_array()
        .map(|scopes| scopes.iter().filter_map(|s| s.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let stored = kv(host, "get", "connectors.feature-grants", json!({"accountId":id}))?;
    Ok(Some((scopes, stored)))
}

pub fn grants(host: &impl Host, id: &str) -> Result<Value> {
    let (scopes, stored) = stored_grants(host, id)?.ok_or_else(|| Error::new(404, NOT_FOUND))?;
    Ok(grants::effective(&scopes, &stored))
}

pub fn put_grants(host: &impl Host, id: &str, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    let mut changes = Vec::new();
    for feature in ["email", "calendar"] {
        let value = match body.get(feature) {
            Some(value) => Some(fastify::boolean(value, feature)?),
            None => None,
        };
        changes.push(value);
    }
    let (scopes, stored) = stored_grants(host, id)?.ok_or_else(|| Error::new(404, NOT_FOUND))?;
    let next = grants::merged(&stored, changes[0], changes[1]);
    let audit: Vec<Value> = [("email", changes[0]), ("calendar", changes[1])]
        .into_iter()
        .filter_map(|(feature, enabled)| enabled.map(|e| json!({"feature":feature,"enabled":e})))
        .collect();
    let saved = kv(
        host,
        "set",
        "connectors.feature-grants",
        json!({"accountId":id,"value":next,"audit":audit}),
    )?;
    if saved.is_null() {
        return Err(Error::new(404, NOT_FOUND));
    }
    Ok(grants::effective(&scopes, &next))
}

pub fn admin_list(host: &impl Host) -> Result<Value> {
    let result = kv(host, "get", "connectors.admin-accounts", json!({}))?;
    match result["status"].as_str() {
        Some("ok") => Ok(json!({"accounts":result["accounts"]})),
        Some("unauthenticated") => Err(Error::new(401, "Session is missing or expired")),
        Some("forbidden") => Err(Error::new(403, "Instance admin permission is required")),
        _ => Err(Error::new(500, "Internal server error")),
    }
}

pub fn diagnostics(host: &impl Host, limit: i64) -> Result<Value> {
    let limit = limit.clamp(1, 10);
    let read = kv(host, "get", "connectors.diagnostics", json!({"limit":limit + 1}))?;
    let rows = read["rows"].as_array().cloned().unwrap_or_default();
    Ok(health::section(&rows, &read["outlook"], limit))
}
