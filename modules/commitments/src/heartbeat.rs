//! Heartbeat source: accepted commitments with a due date that no task or resolution has
//! closed yet. Reads the signed-in person's rows only and never calls the model.
use crate::candidates::{compare, CANDIDATES};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

/// Accepted commitments overdue by more than this many days stop surfacing.
const OVERDUE_LOOKBACK_DAYS: i64 = 7;

/// FNV-1a over UTF-16 units with an 0x1f separator, matching the old revision helper.
pub fn revision(parts: &[String]) -> String {
    let mut hash = 0x811c9dc5u32;
    for part in parts {
        for unit in part.encode_utf16().chain(std::iter::once(0x1f)) {
            hash = (hash ^ u32::from(unit)).wrapping_mul(0x01000193);
        }
    }
    format!("{}-{hash:08x}", parts.len())
}

fn bounded(input: &Value, name: &str, default: u64, max: u64) -> Result<u64> {
    match input.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=max).contains(n))
            .ok_or_else(|| Error::new("Invalid heartbeat read input")),
    }
}

fn local_day<H: Host + ?Sized>(host: &H, instant: &str, offset_days: i64) -> Result<Value> {
    host.call("context", "local-date", "account", json!({"instant":instant,"offsetDays":offset_days}))
}

pub fn open<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    if input.as_object().is_none_or(|m| m.keys().any(|k| k != "horizonHours" && k != "limit")) {
        return Err(Error::new("Invalid heartbeat read input"));
    }
    let horizon = bounded(input, "horizonHours", 24, 48)?;
    let limit = bounded(input, "limit", 20, 20)? as usize;
    let clock = host.call("context", "read", "call", json!({}))?;
    let now = clock["now"].as_str().ok_or_else(|| Error::new("Host clock unavailable"))?;
    let at = chrono::DateTime::parse_from_rfc3339(now).map_err(|_| Error::new("Host clock unavailable"))?;
    let later = (at + chrono::Duration::hours(horizon as i64)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let today = local_day(host, now, 0)?;
    let first = local_day(host, now, -OVERDUE_LOOKBACK_DAYS)?;
    let last = local_day(host, &later, 0)?;
    let text = |v: &Value, k: &str| v[k].as_str().map(str::to_owned).ok_or_else(|| Error::new("Host date unavailable"));
    let (today_day, first_day, last_day) = (text(&today, "date")?, text(&first, "date")?, text(&last, "date")?);

    let mut query = Query::select(Filter::And {
        filters: vec![
            compare("status", Compare::Eq, "accepted"),
            Filter::Null { column: "resolution_ref".into(), not: false },
            compare("due_local_date", Compare::Ge, first_day.as_str()),
            compare("due_local_date", Compare::Le, last_day.as_str()),
        ],
    });
    query.order = vec![
        Order { column: "due_local_date".into(), descending: false },
        Order { column: "id".into(), descending: false },
    ];
    query.limit = Some(limit as u32 + 1);
    let rows = Client(host).query(CANDIDATES, &query)?;
    let day = |row: &Value| row["due_local_date"].as_str().unwrap_or("").to_owned();
    let revision = revision(
        &rows
            .iter()
            .map(|r| {
                [r["id"].as_str().unwrap_or(""), r["title"].as_str().unwrap_or(""), &day(r), r["confidence"].as_str().unwrap_or("")]
                    .join("|")
            })
            .collect::<Vec<_>>(),
    );
    let items: Vec<Value> = rows
        .iter()
        .take(limit)
        .map(|r| {
            let (id, due) = (r["id"].as_str().unwrap_or(""), day(r));
            json!({
                "entityKey": format!("commitment:{id}"), "episodeKey": format!("commitment:{id}:{due}"),
                "title": r["title"], "at": due, "kind": "commitment_due",
                "facts": {"commitmentKind": r["kind"], "confidence": r["confidence"],
                          "counterparty": r["counterparty_label"], "overdue": due < today_day},
            })
        })
        .collect();
    Ok(json!({"data":{
        "source":"memory", "revision":revision, "nextBoundaryAt": today["nextStart"],
        "freshness":"fresh", "truncated": rows.len() > limit, "items": items,
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_matches_the_old_helper() {
        assert_eq!(revision(&[]), "0-811c9dc5");
        assert_eq!(revision(&["a".into()]), "1-3224db49");
        assert_eq!(revision(&["🪴 café".into()]), "1-0e166da1");
    }
}
