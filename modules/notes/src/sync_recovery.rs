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
const RETENTION_DAYS: i64 = 7;

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

/// Runs from the fifteen-minute tick. Republishes unfinished requests, then
/// deletes finished checkpoints older than the retention window. Failures are
/// ignored so maintenance never blocks the sync itself.
pub(crate) fn sweep(host: &impl Host) {
    let mut after = None;
    for _ in 0..MAX_PAGES {
        let Ok(page) = recover(host, Recovery { after }) else {
            break;
        };
        after = page["nextCursor"].as_str().map(str::to_owned);
        if after.is_none() {
            break;
        }
    }
    let _ = expire_finished(host);
}

fn expire_finished(host: &impl Host) -> Result<()> {
    let context = host.call("context", "read", "call", json!({}))?;
    let cutoff = cutoff(context["now"].as_str().ok_or_else(unavailable)?)?;
    let mut query = Query::select(Filter::Compare {
        column: "created_at".into(),
        op: Compare::Lt,
        value: json!(cutoff),
    });
    query.limit = Some(PAGE_SIZE);
    query.order = vec![Order {
        column: "created_at".into(),
        descending: false,
    }];
    for row in Client(host).query(crate::sync_worker::TABLE, &query)? {
        let finished = row["checkpoint"]
            .as_object()
            .is_some_and(|c| c.contains_key("workerResult"));
        let id = row["id"].as_str().ok_or_else(unavailable)?;
        if finished {
            uuid::Uuid::parse_str(id).map_err(|_| unavailable())?;
            Client(host).query(
                crate::sync_worker::TABLE,
                &Query::delete(Filter::eq("id", json!(id))),
            )?;
        }
    }
    Ok(())
}

/// The UTC midnight `RETENTION_DAYS` before the given RFC 3339 timestamp.
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
    fn cutoff_is_seven_days_back_across_month_and_leap_year() {
        assert_eq!(super::cutoff("2026-11-10T08:00:00Z").unwrap(), "2026-11-03T00:00:00Z");
        assert_eq!(super::cutoff("2026-03-03T00:00:00Z").unwrap(), "2026-02-24T00:00:00Z");
        assert_eq!(super::cutoff("2028-03-03T00:00:00Z").unwrap(), "2028-02-25T00:00:00Z");
        assert_eq!(super::cutoff("2027-01-02T23:59:59Z").unwrap(), "2026-12-26T00:00:00Z");
        assert!(super::cutoff("garbage").is_err());
    }
}
