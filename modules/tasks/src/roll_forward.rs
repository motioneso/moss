//! Lazy recurrence advancement before reads, on the account's local calendar day.
//!
//! Each owned series keeps one live instance. When its occurrence date is before
//! today it moves in place to the first occurrence on or after today, shifting
//! due and do times by the same number of days. Rows owned by others, finished
//! rows and series whose target date is already taken are left alone.
use crate::{
    recurrence::{parse, Recurrence},
    repository::{and, Repository, Result, TASKS},
    rows::Task,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use moss_module_sdk::{query::Filter, query::Query, Host};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn day(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}
fn shifted(value: Option<DateTime<Utc>>, delta: Duration) -> Value {
    json!(value.map(|v| crate::dates::to_iso_string(v + delta)))
}
fn occurrence(task: &Task) -> Option<&str> {
    task.recurrence.as_ref()?.get("occurrence_date")?.as_str()
}

/// Advances every stale owned series; returns how many moved.
pub fn roll_forward_owned<H: Host + ?Sized>(repo: &Repository<'_, H>) -> Result<usize> {
    let now = repo
        .now()?
        .parse::<DateTime<Utc>>()
        .map_err(|_| crate::repository::Error::Http(500, "Internal server error"))?;
    let today = repo.local_day(now, 0)?.date.format("%Y-%m-%d").to_string();
    let live: Vec<Task> = repo.all(
        TASKS,
        and(vec![
            Filter::Owned,
            Filter::eq("status", "todo"),
            Filter::Null {
                column: "recurrence_series_id".into(),
                not: true,
            },
        ]),
        vec![crate::repository::order("id", false)],
    )?;
    // The canonical live row of a series is its oldest occurrence.
    let mut series: BTreeMap<String, Vec<Task>> = BTreeMap::new();
    for task in live {
        if let Some(id) = task.recurrence_series_id.clone() {
            series.entry(id).or_default().push(task);
        }
    }
    if !series.is_empty() {
        crate::jobs::reconcile_recurrence_schedule(repo);
    }
    let mut rolled = 0;
    for (series_id, mut rows) in series {
        // A stale scan only looks at parseable dates; no stale row, no work.
        if !rows
            .iter()
            .any(|t| occurrence(t).is_some_and(|d| d < today.as_str()))
        {
            continue;
        }
        rows.sort_by(|a, b| match (occurrence(a), occurrence(b)) {
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
        let task = &rows[0];
        let Some(spec) = task.recurrence.as_ref().and_then(parse) else {
            continue;
        };
        if spec.occurrence_date.as_str() >= today.as_str() {
            continue;
        }
        if roll_series(repo, &series_id, task, &spec, &today)? {
            rolled += 1;
        }
    }
    Ok(rolled)
}

fn roll_series<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    series_id: &str,
    task: &Task,
    spec: &Recurrence,
    today: &str,
) -> Result<bool> {
    let Some(target) = spec.at_or_after(today) else {
        return Ok(false);
    };
    if target == spec.occurrence_date {
        return Ok(false);
    }
    // A sibling already on the target date (for example a finished instance)
    // means the series has converged elsewhere; the unique index forbids a move.
    let siblings: Vec<Task> = repo.all(
        TASKS,
        Filter::eq("recurrence_series_id", series_id),
        vec![crate::repository::order("id", false)],
    )?;
    if siblings
        .iter()
        .any(|t| t.id != task.id && occurrence(t) == Some(target.as_str()))
    {
        return Ok(false);
    }
    let (Some(old), Some(new)) = (day(&spec.occurrence_date), day(&target)) else {
        return Ok(false);
    };
    let delta = new - old;
    let mut next = spec.clone();
    next.occurrence_date = target;
    let updated: Vec<Task> = repo.query(
        TASKS,
        &Query::update(
            and(vec![
                Filter::Owned,
                Filter::eq("id", task.id.as_str()),
                Filter::eq("status", "todo"),
                // Skip the move when a concurrent edit changed or cleared the series.
                Filter::eq("recurrence_series_id", series_id),
                Filter::eq(
                    "updated_at",
                    task.updated_at
                        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
                ),
            ]),
            crate::repository::values(json!({
                "recurrence":next.dto(),
                "due_at":shifted(task.due_at, delta),
                "do_at":shifted(task.do_at, delta),
                "updated_at":repo.now()?,
            })),
        ),
    )?;
    Ok(!updated.is_empty())
}
