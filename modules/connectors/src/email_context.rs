//! Email context. Google accounts are read live first and each new message is triaged by the
//! person's configured model through Email's public API, within a small budget. Messages
//! already triaged in the cache reuse that result. A transient live failure falls back to the
//! cached mail of that account only. Sign-in, grant and revoked problems become gaps.
//! IMAP accounts are answered from the cache.
use crate::calendar_context::degraded_reason;
use crate::{grants, kv, Error, Result};
use chrono::{DateTime, Utc};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};

const DEFAULT_LIMIT: i64 = 30;
const MAX_LIMIT: i64 = 30;
/// Live triage runs at most this many model calls per read, so the call stays inside the
/// five seconds a package call is given.
pub const TRIAGE_CAP: usize = 2;
/// No new triage starts after this many milliseconds from the start of the read.
const TRIAGE_BUDGET_MS: i64 = 1500;

fn instant(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

fn meta(account: &Value) -> Value {
    json!({
        "connectorAccountId": account["id"], "providerId": account["providerId"],
        "providerLabel": account["providerDisplayName"],
    })
}

fn gap(account: &Value, reason: &str) -> Value {
    json!({"account": meta(account), "reason": reason})
}

/// The triage fields of an item, from a saved summary and signals. A sign-in-code message
/// carries the skip marker and reads as untriaged.
pub fn triage_fields(summary: &Value, signals: &Value) -> Value {
    let signals = if signals.is_object() && signals["skipped"] != "otp" { signals } else { &Value::Null };
    let tasks: Vec<Value> = signals["actionability"]["suggestedTasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["text"].as_str().map(|text| json!({"title":text,"dueDate":t["dueDate"].as_str()})))
        .collect();
    json!({
        "summary": if signals.is_null() { Value::Null } else { summary.clone() },
        "actionability": signals["actionability"]["category"].as_str().unwrap_or("unknown"),
        "importance": signals["importance"].as_str().unwrap_or("normal"),
        "confidence": signals["confidence"].as_f64().unwrap_or(0.0),
        "reason": signals["actionability"]["reason"].as_str(),
        "inferredSubject": signals["actionability"]["inferredSubject"].as_str(),
        "dueDate": signals["actionability"]["dueDate"].as_str(),
        "suggestedTasks": tasks,
        "awaitingJudgement": signals["pendingJudgement"] == true,
        "bulk": signals["bulk"] == true,
        "answered": signals["answered"] == true,
    })
}

fn merge(mut item: Value, fields: Value) -> Value {
    if let (Some(item), Some(fields)) = (item.as_object_mut(), fields.as_object()) {
        item.extend(fields.clone());
    }
    item
}

/// An item built from a cached row. The row's account decides the account block.
pub fn cache_item(row: &Value, meta: &Value, degraded: Value) -> Value {
    merge(
        json!({
            "messageKey": row["externalId"], "account": meta, "sender": row["sender"],
            "recipients": row["recipients"], "subject": row["subject"], "receivedAt": row["receivedAt"],
            "threadId": row["threadId"], "snippet": row["snippet"],
            "source": "cache", "degradedReason": degraded, "cacheMessageId": row["cacheMessageId"],
        }),
        triage_fields(&row["summary"], &row["signals"]),
    )
}

fn has_decision(row: &Value) -> bool {
    let signals = &row["signals"];
    signals.is_object() && (signals.get("actionability").is_some() || signals.get("skipped").is_some())
}

fn live_base(message: &Value, meta: &Value, cached: Option<&Value>) -> Value {
    json!({
        "messageKey": message["id"], "account": meta, "sender": message["from"],
        "recipients": message["to"], "subject": message["subject"], "receivedAt": message["receivedAt"],
        "threadId": message["threadId"], "snippet": message["snippet"],
        "source": "live", "degradedReason": null,
        "cacheMessageId": cached.map_or(Value::Null, |c| c["cacheMessageId"].clone()),
    })
}

/// What a read of the cache returns for one account, in the shape of the context.
fn from_cache(host: &impl Host, account: &Value, degraded: Value, limit: i64) -> Result<Vec<Value>> {
    let rows = saved(host, std::slice::from_ref(&account["id"]), limit)?;
    let meta = meta(account);
    Ok(rows.iter().map(|r| cache_item(r, &meta, degraded.clone())).collect())
}

fn saved(host: &impl Host, accounts: &[Value], limit: i64) -> Result<Vec<Value>> {
    let reply = Client(host).api("email", "listSavedMessages", json!({"accountIds":accounts,"limit":limit}))?;
    Ok(reply.as_array().cloned().unwrap_or_default())
}

fn now(host: &impl Host) -> Result<DateTime<Utc>> {
    let clock = host.call("context", "read", "call", json!({}))?;
    instant(clock["now"].as_str().unwrap_or("")).ok_or_else(|| Error::new(503, "Email clock is unavailable"))
}

/// Triages one live message, or returns None when the model is unavailable or fails.
fn triage(host: &impl Host, message: &Value, context: &Value) -> Result<Option<Value>> {
    let input = json!({
        "message": {
            "id": message["id"], "sender": message["from"], "subject": message["subject"],
            "snippet": message["snippet"], "bodyExcerpt": message["snippet"],
            "receivedDay": message["receivedAt"].as_str().map(|t| t.chars().take(10).collect::<String>()),
            "knownSender": false, "threadLastSender": message["from"],
        },
        "today": context["today"], "ownAddresses": context["ownAddresses"],
    });
    let reply = Client(host).api("email", "triageMessage", input)?;
    Ok(if reply["error"].is_null() { Some(reply) } else { None })
}

pub fn list(host: &impl Host, input: &Value) -> Result<Value> {
    let started = now(host)?;
    let limit = input["limit"].as_i64().unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let capable: Vec<&Value> = setup["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| {
            let scopes: Vec<String> = a["scopes"]
                .as_array()
                .map(|s| s.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                .unwrap_or_default();
            grants::effective(&scopes, &Value::Null)["email"] == true
        })
        .collect();
    let (mut items, mut accounts, mut gaps) = (Vec::<Value>::new(), Vec::<Value>::new(), Vec::<Value>::new());
    let mut context: Option<Value> = None;
    let mut triaged = 0;
    let mut more = false;
    for account in capable {
        let id = account["id"].as_str().unwrap_or("");
        let meta = meta(account);
        if account["status"] == "revoked" {
            gaps.push(gap(account, "connector_revoked"));
            continue;
        }
        if !grants::is_granted(&setup["grants"][id], "email") {
            gaps.push(gap(account, "feature_grant_disabled"));
            continue;
        }
        if account["status"] != "active" {
            gaps.push(gap(account, "auth_error"));
            continue;
        }
        match account["providerType"].as_str() {
            Some("imap") => {
                items.extend(from_cache(host, account, Value::Null, limit)?);
                accounts.push(json!({"account":meta,"source":"cache","degradedReason":null}));
                continue;
            }
            Some("google") => {}
            _ => {
                gaps.push(gap(account, "unsupported_provider"));
                continue;
            }
        }
        let live = kv(
            host,
            "get",
            "connectors.live-gmail-list",
            json!({"accountId":id,"query":"in:inbox newer_than:7d","limit":limit}),
        )?;
        let Some(messages) = live["messages"].as_array() else {
            let Some(reason) = degraded_reason(&live) else {
                gaps.push(gap(account, "auth_error"));
                continue;
            };
            items.extend(from_cache(host, account, json!(reason), limit)?);
            accounts.push(json!({"account":meta,"source":"cache","degradedReason":reason}));
            continue;
        };
        let skipped = live["skipped"].as_u64().unwrap_or(0);
        if skipped > 0 && messages.is_empty() {
            items.extend(from_cache(host, account, json!("live_read_incomplete"), limit)?);
            accounts.push(json!({"account":meta,"source":"cache","degradedReason":"live_read_incomplete"}));
            continue;
        }
        if skipped > 0 || live["more"] == true {
            more = true;
        }
        let rows = saved(host, std::slice::from_ref(&account["id"]), 200)?;
        for message in messages {
            let cached = rows.iter().find(|r| r["externalId"] == message["id"]);
            let base = live_base(message, &meta, cached);
            let fields = match cached.filter(|r| has_decision(r)) {
                Some(row) => triage_fields(&row["summary"], &row["signals"]),
                None => {
                    let within = (now(host)? - started).num_milliseconds() < TRIAGE_BUDGET_MS;
                    let result = if triaged < TRIAGE_CAP && within {
                        triaged += 1;
                        if context.is_none() {
                            context = Client(host).api("email", "emailTriageContext", json!({})).ok();
                        }
                        // A failed or slow model call leaves the item untriaged instead of failing the read.
                        triage(host, message, context.as_ref().unwrap_or(&Value::Null)).ok().flatten()
                    } else {
                        None
                    };
                    match result {
                        Some(done) => triage_fields(&done["summary"], &done["signals"]),
                        None => triage_fields(&Value::Null, &Value::Null),
                    }
                }
            };
            items.push(merge(base, fields));
        }
        accounts.push(json!({"account":meta,"source":"live","degradedReason":null}));
    }
    items.sort_by(|a, b| b["receivedAt"].as_str().cmp(&a["receivedAt"].as_str()));
    let truncated = more || items.len() as i64 > limit;
    items.truncate(limit as usize);
    Ok(json!({"items":items,"accounts":accounts,"gaps":gaps,"truncated":truncated}))
}

/// The saved-only context for one account, used by the monitor. No live read and no model call.
pub fn list_saved(host: &impl Host, account_id: &str) -> Result<Value> {
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let Some(account) = setup["accounts"].as_array().into_iter().flatten().find(|a| a["id"] == account_id) else {
        return Ok(json!({"items":[],"accounts":[],"gaps":[]}));
    };
    let meta = meta(account);
    let reason = if account["status"] == "revoked" {
        Some("connector_revoked")
    } else if !grants::is_granted(&setup["grants"][account_id], "email") {
        Some("feature_grant_disabled")
    } else if account["status"] != "active" {
        Some("auth_error")
    } else {
        None
    };
    if let Some(reason) = reason {
        return Ok(json!({"items":[],"accounts":[],"gaps":[gap(account, reason)]}));
    }
    let items = from_cache(host, account, Value::Null, 200)?;
    Ok(json!({"items":items,"accounts":[{"account":meta,"source":"cache","degradedReason":null}],"gaps":[]}))
}
