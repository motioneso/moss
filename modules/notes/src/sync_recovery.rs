//! Bounded publication recovery. The fifteen-minute sync tick runs `maintain`;
//! the experimental `recoverNotesSync` API stays for explicit retries. No indexing
//! runs here.
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

const PAGE_SIZE: u32 = 25;
/// Saved checkpoints older than this are deleted, finished or not.
const RETENTION_SECONDS: i64 = 24 * 60 * 60;
/// Pages scanned per tick (1000 rows). A day holds about 100 ordinary requests,
/// plus one row per continuation page of a very large folder.
const MAX_PAGES: usize = 40;

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

/// Tick maintenance for the caller's account. Deletes checkpoints past retention,
/// then re-requests publication for unfinished ones. Queue identities make a
/// repeat request safe. Failures never fail the tick.
pub(crate) fn maintain(host: &impl Host) {
    let _ = try_maintain(host);
}

fn try_maintain(host: &impl Host) -> Result<()> {
    let context = host.call("context", "read", "call", json!({}))?;
    let now = context["now"].as_str().ok_or_else(unavailable)?;
    let cutoff = shift_seconds(now, -RETENTION_SECONDS).ok_or_else(unavailable)?;
    Client(host).query(
        crate::sync_worker::TABLE,
        &Query::delete(Filter::Compare {
            column: "created_at".into(),
            op: Compare::Lt,
            value: json!(cutoff),
        }),
    )?;
    let mut after = None;
    for _ in 0..MAX_PAGES {
        let out = recover(host, Recovery { after })?;
        match out["nextCursor"].as_str() {
            Some(next) => after = Some(next.to_owned()),
            None => break,
        }
    }
    Ok(())
}

/// Shift an RFC 3339 UTC time (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) by whole seconds.
fn shift_seconds(time: &str, delta: i64) -> Option<String> {
    let (date, clock) = time.split_once('T')?;
    let mut d = date.split('-').map(|n| n.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut c = clock.get(..8)?.split(':').map(|n| n.parse::<i64>().ok());
    let secs = c.next()?? * 3600 + c.next()?? * 60 + c.next()??;
    // Days from civil date (Howard Hinnant).
    let (yy, mm) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let total = (era * 146097 + doe - 719468) * 86400 + secs + delta;
    let (days, rem) = (total.div_euclid(86400), total.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    ))
}

#[cfg(test)]
mod tests {
    use super::shift_seconds;
    #[test]
    fn shifts_across_day_month_and_year() {
        assert_eq!(
            shift_seconds("2026-11-10T00:30:00.123Z", -86400).unwrap(),
            "2026-11-09T00:30:00Z"
        );
        assert_eq!(
            shift_seconds("2026-03-01T00:00:00Z", -86400).unwrap(),
            "2026-02-28T00:00:00Z"
        );
        assert_eq!(
            shift_seconds("2027-01-01T00:00:10Z", -86400).unwrap(),
            "2026-12-31T00:00:10Z"
        );
        assert_eq!(
            shift_seconds("2028-03-01T12:00:00Z", -86400).unwrap(),
            "2028-02-29T12:00:00Z"
        );
        assert!(shift_seconds("nonsense", -1).is_none());
    }
}
