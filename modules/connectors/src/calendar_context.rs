//! Calendar context. Each calendar-capable account is read live first. A transient failure
//! falls back to the cached events of that account only. Sign-in, grant and revoked problems
//! become gaps, never stale data.
use crate::{grants, health, kv, Error, Result};
use chrono::{DateTime, Duration, SecondsFormat, Timelike, Utc};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};

const DEFAULT_LOOKAHEAD_HOURS: i64 = 48;
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;
const OUTLOOK_FRESH_MINUTES: i64 = 15;
const EARLY_HOUR: u32 = 9;
const LATE_HOUR: u32 = 18;

fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn instant(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

/// Why a live read failed, as the old classifier decided it. `None` means a sign-in problem.
pub fn degraded_reason(failure: &Value) -> Option<&'static str> {
    if failure["result"] == "auth_failed" {
        return None;
    }
    let error = &failure["error"];
    Some(match error["status"].as_u64() {
        Some(401 | 403) => return None,
        Some(429) => "rate_limited",
        Some(s) if s >= 400 => "provider_error",
        _ if error["reason"] == "timeout" => "timeout",
        _ if error["status"].is_null() && error["reason"].is_null() => "network_error",
        _ => "internal_error",
    })
}

fn local_hour(zone: chrono_tz::Tz, starts: &str) -> u32 {
    instant(starts).map_or(12, |t| t.with_timezone(&zone).hour())
}

/// The flags of every item, in order. A conflict is an overlap with another timed item.
pub fn flags(items: &[Value], zone: chrono_tz::Tz) -> Vec<Vec<&'static str>> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let mut out = Vec::new();
            let all_day = item["allDay"] == true;
            let (starts, ends) = (item["startsAt"].as_str().unwrap_or(""), item["endsAt"].as_str().unwrap_or(""));
            if !all_day
                && items.iter().enumerate().any(|(other, o)| {
                    other != index
                        && o["allDay"] != true
                        && starts < o["endsAt"].as_str().unwrap_or("")
                        && o["startsAt"].as_str().unwrap_or("") < ends
                })
            {
                out.push("conflict");
            }
            if !all_day {
                let hour = local_hour(zone, starts);
                if hour < EARLY_HOUR {
                    out.push("early");
                }
                if hour >= LATE_HOUR {
                    out.push("late");
                }
            }
            if item["location"].as_str().is_some_and(|l| !l.trim().is_empty()) {
                out.push("has_location");
            }
            if item["attendeeCount"].as_u64().unwrap_or(0) >= 2 {
                out.push("prep_attendees");
            }
            out
        })
        .collect()
}

struct Window {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}

/// Keeps events still running or ahead, starting before the window ends. An all-day banner
/// that spans the whole window with no place and no guests is routine noise and is dropped.
fn in_window(item: &Value, now: DateTime<Utc>, window: &Window) -> bool {
    let (starts, ends) = (item["startsAt"].as_str().unwrap_or(""), item["endsAt"].as_str().unwrap_or(""));
    if ends < iso(now).as_str() || ends < iso(window.start).as_str() || starts >= iso(window.end).as_str() {
        return false;
    }
    let routine = item["allDay"] == true
        && starts <= iso(window.start).as_str()
        && ends >= iso(window.end).as_str()
        && item["location"].as_str().map_or(true, |l| l.trim().is_empty())
        && item["attendeeCount"].as_u64().unwrap_or(0) == 0;
    !routine
}

fn meta(account: &Value) -> Value {
    json!({
        "connectorAccountId": account["id"], "providerId": account["providerId"],
        "providerLabel": account["providerDisplayName"],
    })
}

fn live_item(event: &Value, meta: &Value) -> Value {
    let e = &event["event"];
    json!({
        "eventKey": event["externalId"], "account": meta, "title": e["title"],
        "startsAt": e["startsAt"], "endsAt": e["endsAt"],
        "allDay": e["externalMetadata"]["allDay"] == true, "location": e["location"],
        "attendeeCount": e["externalMetadata"]["attendeeCount"].as_u64().unwrap_or(0),
        "source": "live", "degradedReason": null,
    })
}

fn cache_item(row: &Value, meta: &Value, degraded: Value) -> Value {
    json!({
        "eventKey": row["externalId"], "account": meta, "title": row["title"],
        "startsAt": row["startsAt"], "endsAt": row["endsAt"],
        "allDay": row["allDay"] == true, "location": row["location"],
        "attendeeCount": row["attendeeCount"].as_u64().unwrap_or(0),
        "readOnly": row["readOnly"] == true, "unconfirmed": row["unconfirmed"] == true,
        "source": "cache", "degradedReason": degraded,
    })
}

/// The least fresh account decides. One unknown time makes the whole answer unknown.
fn least_fresh(accounts: &[Value]) -> Value {
    let times: Vec<&str> = accounts.iter().filter_map(|a| a["asOf"].as_str()).collect();
    if accounts.is_empty() || times.len() != accounts.len() {
        return Value::Null;
    }
    json!(times.into_iter().min())
}

struct Reader<'a, H: Host> {
    host: &'a H,
    cached: Option<Vec<Value>>,
    now: DateTime<Utc>,
    window: Window,
}

impl<H: Host> Reader<'_, H> {
    /// Every cached event, read once, for accounts that fall back.
    fn cache_for(&mut self, account: &str) -> Result<Vec<Value>> {
        if self.cached.is_none() {
            let reply = Client(self.host).api("calendar", "listEvents", json!({}))?;
            self.cached = Some(reply["events"].as_array().cloned().unwrap_or_default());
        }
        Ok(self
            .cached
            .iter()
            .flatten()
            .filter(|row| row["connectorAccountId"] == account)
            .cloned()
            .collect())
    }
}

fn gap(account: &Value, reason: &str) -> Value {
    json!({"account": meta(account), "reason": reason})
}

pub fn list(host: &impl Host, input: &Value) -> Result<Value> {
    let clock = host.call("context", "read", "call", json!({}))?;
    let now = instant(clock["now"].as_str().unwrap_or(""))
        .ok_or_else(|| Error::new(503, "Calendar clock is unavailable"))?;
    let start = input["windowStart"].as_str().and_then(instant).unwrap_or(now);
    let end = input["windowEnd"]
        .as_str()
        .and_then(instant)
        .unwrap_or(start + Duration::hours(DEFAULT_LOOKAHEAD_HOURS));
    let limit = input["limit"].as_i64().unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let capable: Vec<&Value> = setup["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| input["accountId"].is_null() || a["id"] == input["accountId"])
        .filter(|a| {
            let scopes: Vec<String> = a["scopes"]
                .as_array()
                .map(|s| s.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                .unwrap_or_default();
            grants::effective(&scopes, &Value::Null)["calendar"] == true
        })
        .collect();
    if capable.is_empty() {
        return Ok(json!({"items":[],"accounts":[],"gaps":[],"truncated":false,"asOf":null}));
    }
    let mut reader = Reader { host, cached: None, now, window: Window { start, end } };
    let (mut items, mut accounts, mut gaps) = (Vec::<Value>::new(), Vec::<Value>::new(), Vec::<Value>::new());
    for account in capable {
        let id = account["id"].as_str().unwrap_or("");
        let stored = &setup["grants"][id];
        let meta = meta(account);
        let granted = grants::is_granted(stored, "calendar");
        if account["providerId"] == health::OUTLOOK_PROVIDER {
            if granted {
                outlook(&mut reader, account, &setup["outlook"][id], &meta, &mut items, &mut accounts, &mut gaps)?;
            } else {
                gaps.push(gap(account, "feature_grant_disabled"));
            }
            continue;
        }
        if account["status"] == "revoked" {
            gaps.push(gap(account, "connector_revoked"));
            continue;
        }
        if !granted {
            gaps.push(gap(account, "feature_grant_disabled"));
            continue;
        }
        if account["status"] != "active" {
            gaps.push(gap(account, "auth_error"));
            continue;
        }
        if account["providerType"] != "google" {
            gaps.push(gap(account, "unsupported_provider"));
            continue;
        }
        let live = kv(
            host,
            "get",
            "connectors.live-calendar",
            json!({"accountId":id,"timeMin":iso(start),"timeMax":iso(end)}),
        )?;
        if let Some(events) = live["events"].as_array() {
            items.extend(
                events.iter().map(|e| live_item(e, &meta)).filter(|i| in_window(i, now, &reader.window)),
            );
            accounts.push(json!({"account":meta,"source":"live","degradedReason":null,"asOf":iso(now)}));
            continue;
        }
        let Some(reason) = degraded_reason(&live) else {
            gaps.push(gap(account, "auth_error"));
            continue;
        };
        let rows = reader.cache_for(id)?;
        items.extend(
            rows.iter()
                .map(|r| cache_item(r, &meta, json!(reason)))
                .filter(|i| in_window(i, now, &reader.window)),
        );
        accounts.push(json!({
            "account":meta,"source":"cache","degradedReason":reason,"asOf":account["lastSyncFinishedAt"],
        }));
    }
    items.sort_by(|a, b| a["startsAt"].as_str().cmp(&b["startsAt"].as_str()));
    let truncated = items.len() > limit;
    items.truncate(limit);
    let zone = setup["timezone"]
        .as_str()
        .and_then(|name| name.parse::<chrono_tz::Tz>().ok())
        .unwrap_or(chrono_tz::America::Los_Angeles);
    let marks = flags(&items, zone);
    for (item, mark) in items.iter_mut().zip(marks) {
        item["flags"] = json!(mark);
    }
    let as_of = least_fresh(&accounts);
    Ok(json!({"items":items,"accounts":accounts,"gaps":gaps,"truncated":truncated,"asOf":as_of}))
}

/// Outlook is mirrored into the cache by a browser helper, so it is read from the cache and is
/// fresh only while the helper has finished a pass within 15 minutes.
fn outlook<H: Host>(
    reader: &mut Reader<'_, H>,
    account: &Value,
    stored: &Value,
    meta: &Value,
    items: &mut Vec<Value>,
    accounts: &mut Vec<Value>,
    gaps: &mut Vec<Value>,
) -> Result<()> {
    let health = health::read_outlook(stored);
    let finished = health["lastCompleteAt"].as_str().and_then(instant);
    let fresh = account["status"] == "active"
        && health["state"] == "current"
        && finished.is_some_and(|f| reader.now - f < Duration::minutes(OUTLOOK_FRESH_MINUTES));
    let id = account["id"].as_str().unwrap_or("");
    for row in reader.cache_for(id)? {
        let reason = if row["unconfirmed"] == true {
            json!("unconfirmed")
        } else if fresh {
            Value::Null
        } else {
            json!("source_stale")
        };
        let item = cache_item(&row, meta, reason);
        if in_window(&item, reader.now, &reader.window) {
            items.push(item);
        }
    }
    let reason = if fresh { Value::Null } else { json!("source_stale") };
    accounts.push(json!({"account":meta,"source":"cache","asOf":health["lastCompleteAt"],"degradedReason":reason}));
    if !fresh {
        gaps.push(gap(account, "service_unavailable"));
    }
    Ok(())
}
