//! Bounded publication recovery and checkpoint retention. The scheduled tick runs
//! `sweep`; no indexing runs here. The experimental `recoverNotesSync` API runs
//! one page of the same scan.
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_PAGES: usize = 8;
// A queue retry waits at most a day, so two days after completion is safe.
const RETENTION_DAYS: i64 = 2;

const PAGE_SIZE: u32 = 25;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Recovery {
    after: Option<String>,
}

/// Scan the caller's private checkpoints in stable UUID order, with no OFFSET.
/// Retry a failed page with the same cursor; only advance after finalization
/// succeeds. Restart from no cursor periodically to notice new lower UUIDs.
/// Queue idempotency and saved worker results make duplicate requests safe.
pub(crate) fn recover(host: &impl Host, input: Recovery) -> Result<Value> {
    let filter = match input.after {
        Some(after) => Filter::Compare {
            column: "id".into(),
            op: Compare::Gt,
            value: json!(uuid::Uuid::parse_str(&after)
                .map_err(|_| unavailable())?
                .to_string()),
        },
        None => Filter::All,
    };
    let mut query = Query::select(filter);
    query.limit = Some(PAGE_SIZE);
    query.order = vec![Order {
        column: "id".into(),
        descending: false,
    }];
    let rows = Client(host).query(crate::sync_worker::TABLE, &query)?;
    let context = host.call("context", "read", "call", json!({}))?;
    let now = context["now"].as_str().ok_or_else(unavailable)?;
    let mut requested = 0;
    for row in &rows {
        let id = row["id"].as_str().ok_or_else(unavailable)?;
        uuid::Uuid::parse_str(id).map_err(|_| unavailable())?;
        let checkpoint = row["checkpoint"].as_object().ok_or_else(unavailable)?;
        // Successful parents have already committed their child row in the same
        // transaction. That unfinished child is independently discoverable here.
        if !checkpoint.contains_key("workerResult") {
            crate::sync_worker::publish(host, id, now)?;
            requested += 1;
        }
    }
    Ok(json!({
        "scanned":rows.len(), "requested":requested,
        "nextCursor":if rows.len() == PAGE_SIZE as usize {
            rows.last().map(|row| row["id"].clone())
        } else { None }
    }))
}
fn unavailable() -> Error {
    Error::new("Notes sync recovery is unavailable")
}

/// Runs from the fifteen-minute tick. One scan over the account's saved
/// requests republishes unfinished ones and deletes finished ones whose
/// completion is older than the retention window. The scan starts at a random
/// id and wraps, so a large backlog is still reached across ticks. Failures
/// are ignored so maintenance never blocks the sync itself.
pub(crate) fn sweep(host: &impl Host) {
    let _ = scan(host);
}

fn scan(host: &impl Host) -> Result<()> {
    let context = host.call("context", "read", "call", json!({}))?;
    let now = context["now"].as_str().ok_or_else(unavailable)?;
    let cutoff = cutoff(now)?;
    let start = host.call("context", "uuid", "new", json!({}))?;
    let start = start["id"].as_str().ok_or_else(unavailable)?.to_owned();
    uuid::Uuid::parse_str(&start).map_err(|_| unavailable())?;
    let mut budget = MAX_PAGES;
    // First from the random start to the end, then from the beginning up to it.
    for (from, until) in [(Some(start.clone()), None), (None, Some(start))] {
        let mut after = from;
        while budget > 0 {
            budget -= 1;
            let (rows, last) = page(host, after.as_deref(), now, &cutoff, until.as_deref())?;
            match last {
                Some(id) if rows == PAGE_SIZE as usize => after = Some(id),
                _ => break,
            }
        }
    }
    Ok(())
}

/// Handles one page. Returns how many rows were read and the last id read.
fn page(
    host: &impl Host,
    after: Option<&str>,
    now: &str,
    cutoff: &str,
    until: Option<&str>,
) -> Result<(usize, Option<String>)> {
    let mut filters = vec![];
    if let Some(after) = after {
        filters.push(Filter::Compare {
            column: "id".into(),
            op: Compare::Gt,
            value: json!(after),
        });
    }
    if let Some(until) = until {
        filters.push(Filter::Compare {
            column: "id".into(),
            op: Compare::Le,
            value: json!(until),
        });
    }
    let mut query = Query::select(match filters.len() {
        0 => Filter::All,
        _ => Filter::And { filters },
    });
    query.limit = Some(PAGE_SIZE);
    query.order = vec![Order {
        column: "id".into(),
        descending: false,
    }];
    let rows = Client(host).query(crate::sync_worker::TABLE, &query)?;
    for row in &rows {
        let id = row["id"].as_str().ok_or_else(unavailable)?;
        uuid::Uuid::parse_str(id).map_err(|_| unavailable())?;
        let checkpoint = row["checkpoint"].as_object().ok_or_else(unavailable)?;
        if !checkpoint.contains_key("workerResult") {
            crate::sync_worker::publish(host, id, now)?;
            continue;
        }
        // Age counts from completion, so a late-finishing request is kept long
        // enough for a queue retry to replay its saved result. A result saved
        // before completion times existed is stamped now and kept for the window.
        match checkpoint.get("completedAt").and_then(Value::as_str) {
            Some(at) if at < cutoff => {
                Client(host).query(
                    crate::sync_worker::TABLE,
                    &Query::delete(Filter::eq("id", json!(id))),
                )?;
            }
            Some(_) => {}
            None => {
                let mut stamped = checkpoint.clone();
                stamped.insert("completedAt".into(), json!(now));
                Client(host).query(
                    crate::sync_worker::TABLE,
                    &Query::update(
                        Filter::eq("id", json!(id)),
                        [("checkpoint".into(), Value::Object(stamped))].into(),
                    ),
                )?;
            }
        }
    }
    Ok((rows.len(), rows.last().and_then(|r| r["id"].as_str().map(str::to_owned))))
}

/// The UTC midnight `RETENTION_DAYS` before the given RFC 3339 timestamp, so a
/// finished request is kept between two and three days.
fn cutoff(now: &str) -> Result<String> {
    let date = now.get(..10).ok_or_else(unavailable)?;
    let mut parts = date.split('-').map(|p| p.parse::<i64>());
    let (Some(Ok(y)), Some(Ok(m)), Some(Ok(d))) = (parts.next(), parts.next(), parts.next()) else {
        return Err(unavailable());
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(unavailable());
    }
    // Days since 1970-01-01 and back (proleptic Gregorian civil calendar).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468 - RETENTION_DAYS;
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Ok(format!("{year:04}-{month:02}-{day:02}T00:00:00Z"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn cutoff_is_two_days_back_across_month_and_leap_year() {
        assert_eq!(super::cutoff("2026-11-10T08:00:00Z").unwrap(), "2026-11-08T00:00:00Z");
        assert_eq!(super::cutoff("2027-03-01T00:00:00Z").unwrap(), "2027-02-27T00:00:00Z");
        assert_eq!(super::cutoff("2028-03-01T00:00:00Z").unwrap(), "2028-02-28T00:00:00Z");
        assert_eq!(super::cutoff("2027-01-01T23:59:59Z").unwrap(), "2026-12-30T00:00:00Z");
        assert!(super::cutoff("garbage").is_err());
    }
}
