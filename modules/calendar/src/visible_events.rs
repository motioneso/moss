//! `calendar.listVisibleEvents`. Reads through the public Connectors interface only, so the
//! module never touches provider accounts or their cache directly. A missing Connectors package
//! fails the call closed.
use crate::{
    context,
    draft_tool::{actor_zone, trim},
    Error, Result,
};

use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Map, Value};

const MAX_PREVIEW_TITLES: usize = 3;
const MAX_TITLE_UNITS: usize = 80;

pub(crate) fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Start of the local civil day, skipping a midnight that a clock change removed.
fn local_midnight<Z: TimeZone>(date: NaiveDate, zone: &Z) -> DateTime<Utc> {
    let mut at = date.and_hms_opt(0, 0, 0).expect("midnight exists");
    loop {
        if let Some(local) = zone.from_local_datetime(&at).earliest() {
            return local.with_timezone(&Utc);
        }
        at += Duration::hours(1);
    }
}

fn day_bounds<Z: TimeZone>(
    zone: &Z,
    now: DateTime<Utc>,
    name: &str,
) -> Option<(DateTime<Utc>, DateTime<Utc>, &'static str)> {
    let today = now.with_timezone(zone).date_naive();
    let (day, label) = match name {
        "today" => (today, "today"),
        "tomorrow" => (today.succ_opt()?, "tomorrow"),
        _ => return None,
    };
    Some((
        local_midnight(day, zone),
        local_midnight(day.succ_opt()?, zone),
        label,
    ))
}

/// A saved zone may be an IANA name or a fixed offset such as `+05:30`. An empty value uses the
/// product default; any other value this build cannot read yields `None` rather than a wrong day.
fn fixed_offset(text: &str) -> Option<chrono::FixedOffset> {
    let sign = match text.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let (h, m) = text[1..].split_once(':').unwrap_or((&text[1..], "0"));
    let (h, m): (i32, i32) = (h.parse().ok()?, m.parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    chrono::FixedOffset::east_opt(sign * (h * 3600 + m * 60))
}

/// A saved zone resolved to something dates can be computed in.
pub enum Zone {
    Named(chrono_tz::Tz),
    Fixed(chrono::FixedOffset),
}

/// Resolves a saved zone. An empty or oversized value uses the product default; a value this
/// build cannot read yields `None` rather than a wrong day.
pub fn resolve_zone(saved_zone: &str) -> Option<Zone> {
    if saved_zone.is_empty() || saved_zone.len() > 100 {
        return Some(Zone::Named(actor_zone("")));
    }
    if let Ok(zone) = saved_zone.parse::<chrono_tz::Tz>() {
        return Some(Zone::Named(zone));
    }
    if let Some(zone) = chrono_tz::TZ_VARIANTS
        .iter()
        .copied()
        .find(|zone| zone.name().eq_ignore_ascii_case(saved_zone))
    {
        return Some(Zone::Named(zone));
    }
    fixed_offset(saved_zone).map(Zone::Fixed)
}

/// The `[start, end)` instants of a named local day plus its label.
pub fn window_range(
    name: &str,
    now: DateTime<Utc>,
    saved_zone: &str,
) -> Option<(DateTime<Utc>, DateTime<Utc>, &'static str)> {
    match resolve_zone(saved_zone)? {
        Zone::Named(zone) => day_bounds(&zone, now, name),
        Zone::Fixed(zone) => day_bounds(&zone, now, name),
    }
}

/// The current instant and saved zone name for the signed-in account.
pub(crate) fn clock_and_zone(host: &impl Host) -> Result<(DateTime<Utc>, String)> {
    let now =
        DateTime::parse_from_rfc3339(context(host, "read", "call")?["now"].as_str().unwrap_or(""))
            .map_err(|_| Error::new(503, "Calendar clock is unavailable"))?
            .with_timezone(&Utc);
    let locale = host.call("kv", "get", "calendar.chat-context", json!({}))?;
    Ok((now, locale["timezone"].as_str().unwrap_or("").to_string()))
}

fn bounded_titles(events: &[Value]) -> Vec<String> {
    let mut titles = vec![];
    for event in events {
        if titles.len() == MAX_PREVIEW_TITLES {
            break;
        }
        let title = trim(event["title"].as_str().unwrap_or(""));
        if title.is_empty() {
            continue;
        }
        if title.encode_utf16().count() > MAX_TITLE_UNITS {
            let mut cut = String::new();
            let mut units = 0;
            for c in title.chars() {
                units += c.len_utf16();
                if units > MAX_TITLE_UNITS - 3 {
                    break;
                }
                cut.push(c);
            }
            titles.push(format!("{cut}..."));
        } else {
            titles.push(title.to_string());
        }
    }
    titles
}

/// One sentence about a day's events, or `None` unless the answer is complete and live.
pub fn summarize(events: &[Value], label: &str, degraded: bool, truncated: bool) -> Option<String> {
    if truncated || degraded {
        return None;
    }
    let head = match events.len() {
        0 => format!("No events {label}."),
        1 => format!("1 event {label}."),
        n => format!("{n} events {label}."),
    };
    let titles = bounded_titles(events);
    let preview = if titles.is_empty() {
        String::new()
    } else {
        format!(" Next: {}.", titles.join("; "))
    };
    Some(format!("{head}{preview}"))
}

fn serialize_item(item: &Value) -> Value {
    json!({
        "id":item["eventKey"],
        "connectorAccountId":item["account"]["connectorAccountId"],
        "providerLabel":item["account"]["providerLabel"],
        "title":item["title"],"startsAt":item["startsAt"],"endsAt":item["endsAt"],
        "allDay":item["allDay"],"location":item["location"],
        "attendeeCount":item["attendeeCount"],"flags":item["flags"],
        "source":item["source"],"degradedReason":item["degradedReason"]
    })
}

/// Projects the Connectors reply into the tool result. `label` is set for a named window.
pub fn project(reply: &Value, label: Option<&str>) -> Result<Value> {
    let unavailable = || Error::new(503, "Calendar sources are unavailable");
    let items = reply["items"].as_array().ok_or_else(unavailable)?;
    let accounts = reply["accounts"].as_array().ok_or_else(unavailable)?;
    let gaps = reply["gaps"].as_array().ok_or_else(unavailable)?;
    let events: Vec<Value> = items.iter().map(serialize_item).collect();
    let degraded = !gaps.is_empty()
        || accounts
            .iter()
            .any(|a| a["source"] == "cache" || !a["degradedReason"].is_null());
    let mut data = Map::new();
    data.insert("events".into(), json!(events));
    data.insert("accounts".into(), json!(accounts));
    data.insert("gaps".into(), json!(gaps));
    if let Some(label) = label {
        if let Some(summary) = summarize(&events, label, degraded, reply["truncated"] == true) {
            data.insert("summary".into(), json!(summary));
        }
    }
    Ok(json!({"data":data}))
}

pub fn read(host: &impl Host, input: &Value) -> Result<Value> {
    let invalid = || Error::new(400, "Invalid calendar event request");
    let fields = input.as_object().ok_or_else(invalid)?;
    let named = fields
        .get("window")
        .and_then(Value::as_str)
        .filter(|w| matches!(*w, "today" | "tomorrow"));
    let mut request = Map::new();
    let mut label = None;
    if let Some(name) = named {
        let (now, zone) = clock_and_zone(host)?;
        let (start, end, day) = window_range(name, now, &zone)
            .ok_or_else(|| Error::new(503, "Calendar timezone is unavailable"))?;
        request.insert("windowStart".into(), json!(iso(start)));
        request.insert("windowEnd".into(), json!(iso(end)));
        label = Some(day);
    } else {
        for (from, to) in [
            ("startsAfter", "windowStart"),
            ("startsBefore", "windowEnd"),
        ] {
            if let Some(value) = fields.get(from).and_then(Value::as_str) {
                request.insert(to.into(), json!(value));
            }
        }
    }
    if let Some(limit) = fields.get("limit").and_then(Value::as_f64) {
        if limit > 0.0 {
            request.insert("limit".into(), json!(limit));
        }
    }
    let reply = Client(host).api("connectors", "listCalendarContext", Value::Object(request))?;
    project(&reply, label)
}
