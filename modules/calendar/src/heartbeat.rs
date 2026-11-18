//! Cache-only, owner-filtered heartbeat source. Shared event grants are not heartbeat grants.
use crate::{context, events, query, Error, Result};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Host,
};
use serde_json::{json, Value};

pub fn parse(input: &Value) -> Result<(u32, u32)> {
    let invalid = || Error::new(400, "Invalid heartbeat read input");
    let fields = input.as_object().ok_or_else(invalid)?;
    if fields.keys().any(|k| k != "horizonHours" && k != "limit") {
        return Err(invalid());
    }
    let number = |key: &str, default: u32, max: u32| -> Result<u32> {
        let value = &input[key];
        if value.is_null() {
            return Ok(default);
        }
        let n = value.as_f64().ok_or_else(invalid)?;
        if n.fract() != 0.0 || n < 1.0 || n > f64::from(max) {
            return Err(invalid());
        }
        Ok(n as u32)
    };
    Ok((number("horizonHours", 24, 48)?, number("limit", 20, 20)?))
}

fn instant(value: &Value) -> Result<DateTime<Utc>> {
    value
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .ok_or_else(|| Error::new(503, "Calendar timestamp is unavailable"))
}
fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The existing revision hashes JavaScript UTF-16 code units, not UTF-8 bytes.
pub fn revision(parts: &[String]) -> String {
    let mut hash = 0x811c9dc5u32;
    for part in parts {
        for unit in part.encode_utf16() {
            hash = (hash ^ u32::from(unit)).wrapping_mul(0x01000193);
        }
        hash = (hash ^ 0x1f).wrapping_mul(0x01000193);
    }
    format!("{}-{hash:08x}", parts.len())
}

pub fn read(host: &impl Host, input: &Value) -> Result<Value> {
    let (hours, limit) = parse(input)?;
    let now = instant(&context(host, "read", "call")?["now"])?;
    let until = now + Duration::hours(i64::from(hours));
    let rows = query(
        host,
        events::TABLE,
        &Query {
            filter: Filter::And {
                filters: vec![
                    Filter::Owned,
                    Filter::Compare {
                        column: "ends_at".into(),
                        op: Compare::Gt,
                        value: json!(iso(now)),
                    },
                    Filter::Compare {
                        column: "starts_at".into(),
                        op: Compare::Lt,
                        value: json!(iso(until)),
                    },
                ],
            },
            order: vec![
                Order {
                    column: "starts_at".into(),
                    descending: false,
                },
                Order {
                    column: "id".into(),
                    descending: false,
                },
            ],
            limit: Some(limit + 1),
            ..Query::default()
        },
    )?;
    // Equivalent to max(updated_at), including events outside the short window.
    let sync = query(
        host,
        events::TABLE,
        &Query {
            order: vec![Order {
                column: "updated_at".into(),
                descending: true,
            }],
            limit: Some(1),
            ..Query::select(Filter::Owned)
        },
    )?;
    project(&rows, sync.first().map(|v| &v["updated_at"]), now, limit)
}

pub fn project(
    rows: &[Value],
    synced: Option<&Value>,
    now: DateTime<Utc>,
    limit: u32,
) -> Result<Value> {
    let mut parts = vec![];
    let mut items = vec![];
    let mut boundary = None;
    for (i, event) in rows.iter().enumerate() {
        let start = instant(&event["starts_at"])?;
        let end = instant(&event["ends_at"])?;
        let id = event["id"]
            .as_str()
            .ok_or_else(|| Error::new(503, "Calendar event is unavailable"))?;
        let title = event["title"].as_str().unwrap_or("");
        let location = event["location"].as_str().unwrap_or("");
        parts.push(format!(
            "{id}|{title}|{}|{}|{location}",
            iso(start),
            iso(end)
        ));
        if i >= limit as usize {
            continue;
        }
        let next = if start > now { start } else { end };
        boundary = Some(boundary.map_or(next, |old: DateTime<Utc>| old.min(next)));
        items.push(json!({
            "entityKey":format!("event:{id}"),
            "episodeKey":format!("event:{id}:{}",iso(start)),
            "title":title,"at":iso(start),"kind":"event",
            "facts":{"endsAt":iso(end),"location":event["location"],"inProgress":start<=now}
        }));
    }
    let freshness = match synced.filter(|s| !s.is_null()) {
        None => "unknown",
        Some(value) if now.signed_duration_since(instant(value)?) <= Duration::hours(3) => "fresh",
        Some(_) => "stale",
    };
    Ok(json!({"data":{
        "source":"calendar","revision":revision(&parts),
        "nextBoundaryAt":boundary.map(iso),"freshness":freshness,
        "truncated":rows.len()>limit as usize,"items":items
    }}))
}
