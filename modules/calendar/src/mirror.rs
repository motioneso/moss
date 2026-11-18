//! Imports one scan of an Outlook calendar into the event cache. Connectors calls this through
//! Calendar's public API. The whole batch is checked before the first write. A complete scan
//! may mark events it no longer sees as missing, and two misses in the same range make an
//! event unconfirmed. A partial scan only adds or refreshes events.
use crate::{Error, Result};
use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Value};
use std::collections::HashSet;

const SOURCE: &str = "outlook-browser-calendar";
const MAX_EVENTS: usize = 1000;
const MAX_DAYS: i64 = 33;

fn bad(message: &str) -> Error {
    Error::new(400, message)
}

fn instant(text: &str) -> Option<DateTime<Utc>> {
    let at = DateTime::parse_from_rfc3339(text).ok()?.with_timezone(&Utc);
    (at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) == text).then_some(at)
}

fn day(text: &str) -> Option<NaiveDate> {
    let date = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    (date.format("%Y-%m-%d").to_string() == text).then_some(date)
}

/// Local midnight in the zone. A skipped midnight falls forward to the first valid instant.
fn midnight(date: NaiveDate, zone: chrono_tz::Tz) -> DateTime<Utc> {
    let wall = date.and_time(NaiveTime::MIN);
    for hours in 0..4 {
        if let Some(at) = zone.from_local_datetime(&(wall + chrono::Duration::hours(hours))).earliest() {
            return at.with_timezone(&Utc);
        }
    }
    Utc.from_utc_datetime(&wall)
}

/// The external id of a mirrored occurrence. A JSON pair keeps keys with commas unambiguous.
pub fn external_id(calendar_key: &str, occurrence_key: &str) -> String {
    json!([calendar_key, occurrence_key]).to_string()
}

struct Window {
    start: String,
    end: String,
    zone: chrono_tz::Tz,
}

impl Window {
    fn range(&self) -> (DateTime<Utc>, DateTime<Utc>) {
        (
            midnight(day(&self.start).expect("checked"), self.zone),
            midnight(day(&self.end).expect("checked"), self.zone),
        )
    }
}

fn check(batch: &Value) -> Result<(Window, DateTime<Utc>)> {
    let key = batch["calendarKey"].as_str().unwrap_or("");
    let zone = batch["timeZone"].as_str().and_then(|z| z.parse::<chrono_tz::Tz>().ok());
    let observed = batch["observedAt"].as_str().and_then(instant);
    let (start, end) = (batch["windowStart"].as_str().unwrap_or(""), batch["windowEnd"].as_str().unwrap_or(""));
    let (Some(zone), Some(observed), Some(from), Some(to)) = (zone, observed, day(start), day(end)) else {
        return Err(bad("Invalid calendar mirror batch"));
    };
    let events = batch["events"].as_array();
    if key.is_empty() || key.len() > 200 || to <= from || (to - from).num_days() > MAX_DAYS
        || events.is_none_or(|e| e.len() > MAX_EVENTS) || !batch["complete"].is_boolean()
    {
        return Err(bad("Invalid calendar mirror batch"));
    }
    let window = Window { start: start.into(), end: end.into(), zone };
    let (lo, hi) = window.range();
    let mut seen = HashSet::new();
    for e in events.into_iter().flatten() {
        let key = e["occurrenceKey"].as_str().unwrap_or("");
        let (Some(s), Some(f), Some(all_day)) = (
            e["startsAt"].as_str().and_then(instant),
            e["endsAt"].as_str().and_then(instant),
            e["allDay"].as_bool(),
        ) else {
            return Err(bad("Invalid calendar mirror event"));
        };
        let title = e["title"].as_str().unwrap_or("");
        let (sd, fd) = (&e["startsAt"].as_str().unwrap_or("")[..10], &e["endsAt"].as_str().unwrap_or("")[..10]);
        let outside = if all_day { fd <= start || sd >= end } else { f <= lo || s >= hi };
        let midnights = !all_day || (s.time() == NaiveTime::MIN && f.time() == NaiveTime::MIN);
        if key.is_empty() || key.len() > 512 || !seen.insert(key.to_string()) || title.trim().is_empty()
            || title.len() > 1000 || e["timeZone"] != batch["timeZone"] || f <= s || outside || !midnights
        {
            return Err(bad("Invalid calendar mirror event"));
        }
    }
    Ok((window, observed))
}

fn latest(meta: &Value) -> Option<&str> {
    ["observedAt", "mirrorMissingObservedAt"].iter().filter_map(|k| meta[k].as_str()).max()
}

fn in_window(row: &Value, window: &Window) -> bool {
    let (Some(s), Some(e)) = (row["startsAt"].as_str(), row["endsAt"].as_str()) else { return false };
    if row["metadata"]["allDay"] == true {
        return e[..10] > *window.start && s[..10] < *window.end;
    }
    let (lo, hi) = window.range();
    matches!((instant(s), instant(e)), (Some(s), Some(e)) if e > lo && s < hi)
}

pub fn import(host: &impl Host, input: &Value) -> Result<Value> {
    let account = input["connectorAccountId"].as_str().filter(|a| !a.is_empty()).ok_or_else(|| bad("connectorAccountId is required"))?;
    let batch = &input["batch"];
    let (window, _) = check(batch)?;
    let calendar = batch["calendarKey"].as_str().unwrap_or("");
    let observed_at = batch["observedAt"].as_str().unwrap_or("");
    let complete = batch["complete"] == true;
    let range = json!([calendar, batch["timeZone"], window.start, window.end]).to_string();
    let rows = host.call("kv", "get", "calendar.cache-write", json!({
        "action":"mirror-rows","connectorAccountId":account,"prefix":format!("{},", json!([calendar]).to_string().trim_end_matches(']')),
    }))?;
    let rows: Vec<Value> = rows["rows"].as_array().cloned().unwrap_or_default();
    let mut observed = HashSet::new();
    let mut upserted = 0;
    let mut kept_uncertain = 0;
    for e in batch["events"].as_array().into_iter().flatten() {
        let id = external_id(calendar, e["occurrenceKey"].as_str().unwrap_or(""));
        observed.insert(id.clone());
        let prior = rows.iter().find(|r| r["externalId"] == id.as_str());
        if prior.and_then(|r| latest(&r["metadata"])).is_some_and(|t| t >= observed_at) {
            // A newer scan kept this row. Any uncertainty it recorded still counts.
            if prior.is_some_and(|r| r["metadata"]["mirrorUnconfirmed"] == true) {
                kept_uncertain += 1;
            }
            continue;
        }
        host.call("kv", "set", "calendar.cache-write", json!({
            "action":"upsert","connectorAccountId":account,"externalId":id,
            "event":{"title":e["title"],"startsAt":e["startsAt"],"endsAt":e["endsAt"],"externalMetadata":{
                "source":SOURCE,"readOnly":true,"allDay":e["allDay"],"sourceTimeZone":e["timeZone"],
                "observedAt":observed_at,"mirrorMissingCount":0,"mirrorMissingRange":null,
                "mirrorMissingObservedAt":null,"mirrorUnconfirmed":false,
                "mirrorState": if complete {"current"} else {"partial"},
            }},
        }))?;
        upserted += 1;
    }
    let mut unconfirmed = kept_uncertain;
    // A partial view cannot turn absence into a conclusion.
    if complete {
        for row in rows.iter().filter(|r| in_window(r, &window)) {
            let id = row["externalId"].as_str().unwrap_or("");
            let md = &row["metadata"];
            if observed.contains(id) || md["observedAt"].as_str().is_some_and(|t| t >= observed_at)
                || md["mirrorMissingObservedAt"].as_str().is_some_and(|t| t >= observed_at)
            {
                // A newer scan already judged this row. Its uncertainty still counts.
                if !observed.contains(id) && md["mirrorUnconfirmed"] == true {
                    unconfirmed += 1;
                }
                continue;
            }
            let misses = match (md["mirrorMissingRange"].as_str(), md["mirrorMissingCount"].as_i64()) {
                (Some(r), Some(n)) if r == range => n + 1,
                _ => 1,
            };
            let missing = misses.min(2);
            let uncertain = md["mirrorUnconfirmed"] == true || missing == 2;
            if uncertain {
                unconfirmed += 1;
            }
            host.call("kv", "set", "calendar.cache-write", json!({
                "action":"mirror-merge","connectorAccountId":account,"id":row["id"],
                "metadata":{"mirrorMissingRange":range,"mirrorMissingObservedAt":observed_at,
                            "mirrorMissingCount":missing,"mirrorUnconfirmed":uncertain},
            }))?;
        }
    }
    Ok(json!({"upserted":upserted,"unconfirmed":unconfirmed}))
}
