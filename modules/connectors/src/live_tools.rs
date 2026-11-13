//! Live read tools. Each one reads the signed-in person's single active Google account
//! through the host, after the feature grant check. Failures carry a plain message only.
use crate::{grants, kv, Error, Result};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const MESSAGES_DEFAULT: i64 = 10;
const MESSAGES_MAX: i64 = 20;
const EVENTS_DEFAULT: i64 = 20;
const EVENTS_MAX: i64 = 50;
const BODY_CHARS: usize = 12_000;
const WINDOW_DAYS: i64 = 14;
const CONNECT_FIRST: &str = "Connect Google in Settings first.";

fn clamp(value: &Value, fallback: i64, max: i64) -> i64 {
    value.as_f64().map_or(fallback, |n| (n.floor() as i64).clamp(1, max))
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// The one active Google account, or the sign-in message. A disabled feature answers with the
/// old refusal instead of an error.
fn account(host: &impl Host, feature: &str) -> Result<std::result::Result<String, Value>> {
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let found = setup["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["providerId"] == "google" && a["status"] == "active");
    let Some(found) = found else {
        return Err(Error::new(409, CONNECT_FIRST));
    };
    let id = found["id"].as_str().unwrap_or("").to_string();
    if grants::is_granted(&setup["grants"][id.as_str()], feature) {
        return Ok(Ok(id));
    }
    let what = if feature == "email" { "Email" } else { "Calendar" };
    Ok(Err(json!({"data":{
        "error": format!("{what} access disabled for this account"),
        "code": "CONNECTOR_FEATURE_GRANT_DISABLED",
    }})))
}

/// A failed live read becomes a plain message. The host answer holds no token or mail text.
fn answer(read: Value) -> Result<Value> {
    match read["result"].as_str() {
        Some("inactive") | Some("auth_failed") => Err(Error::new(409, CONNECT_FIRST)),
        Some("failed") => Err(Error::new(502, "Google could not be reached. Try again shortly.")),
        _ => Ok(read),
    }
}

pub fn search(host: &impl Host, input: &Value) -> Result<Value> {
    let id = match account(host, "email")? {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let mut params = json!({"accountId":id,"limit":clamp(&input["limit"], MESSAGES_DEFAULT, MESSAGES_MAX)});
    if let Some(query) = text(&input["query"]) {
        params["query"] = json!(query);
    }
    let read = answer(kv(host, "get", "connectors.live-gmail-list", params)?)?;
    Ok(json!({"data":{"messages":read["messages"],"skipped":read["skipped"]}}))
}

pub fn message(host: &impl Host, input: &Value) -> Result<Value> {
    let Some(message_id) = text(&input["id"]) else {
        return Err(Error::new(400, "id is required"));
    };
    let id = match account(host, "email")? {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let read = answer(kv(host, "get", "connectors.live-gmail-get", json!({"accountId":id,"id":message_id}))?)?;
    let mut found = read["message"].clone();
    if let Some(body) = found["bodyText"].as_str() {
        found["bodyText"] = json!(body.chars().take(BODY_CHARS).collect::<String>());
    }
    Ok(json!({"data":{"message":found}}))
}

pub fn events(host: &impl Host, input: &Value) -> Result<Value> {
    let clock = host.call("context", "read", "call", json!({}))?;
    let now = DateTime::parse_from_rfc3339(clock["now"].as_str().unwrap_or(""))
        .map_err(|_| Error::new(503, "Calendar clock is unavailable"))?
        .with_timezone(&Utc);
    let iso = |t: DateTime<Utc>| t.to_rfc3339_opts(SecondsFormat::Millis, true);
    let min = text(&input["timeMin"]);
    let start = min
        .and_then(|m| DateTime::parse_from_rfc3339(m).ok())
        .map_or(now, |t| t.with_timezone(&Utc));
    let id = match account(host, "calendar")? {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let params = json!({
        "accountId": id,
        "timeMin": min.map_or_else(|| iso(now), String::from),
        "timeMax": text(&input["timeMax"]).map_or_else(|| iso(start + Duration::days(WINDOW_DAYS)), String::from),
    });
    let read = answer(kv(host, "get", "connectors.live-calendar", params)?)?;
    let limit = clamp(&input["limit"], EVENTS_DEFAULT, EVENTS_MAX) as usize;
    let rows: Vec<Value> = read["events"]
        .as_array()
        .into_iter()
        .flatten()
        .take(limit)
        .map(|e| {
            let (event, meta) = (&e["event"], &e["event"]["externalMetadata"]);
            json!({
                "id": e["externalId"], "title": event["title"], "startsAt": event["startsAt"],
                "endsAt": event["endsAt"], "location": event["location"],
                "htmlLink": meta["htmlLink"], "status": meta["status"],
                "attendeeCount": meta["attendeeCount"].as_u64().unwrap_or(0),
            })
        })
        .collect();
    Ok(json!({"data":{"events":rows}}))
}
