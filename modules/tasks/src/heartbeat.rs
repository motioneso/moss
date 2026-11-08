//! Bounded owner-only reads. Unlike interactive list views these never roll recurrence.
use crate::{
    repository::{and, order, Repository, Result, TASKS},
    rows::Task,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Compare, Filter, Query},
    Host,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    horizon_hours: Option<u32>,
    limit: Option<u32>,
}

fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn execute<H: Host + ?Sized>(repo: &Repository<'_, H>, input: &Value) -> Result<Value> {
    let input: Input = serde_json::from_value(input.clone())?;
    let horizon = input.horizon_hours.unwrap_or(24);
    let limit = input.limit.unwrap_or(20);
    if !(1..=48).contains(&horizon) || !(1..=20).contains(&limit) {
        return Err(crate::repository::Error::Http(
            400,
            "Invalid heartbeat read input",
        ));
    }
    let now: DateTime<Utc> = repo
        .now()?
        .parse()
        .map_err(|_| crate::repository::Error::Http(500, "Internal server error"))?;
    let until = now + Duration::hours(horizon.into());
    let query = |op, boundary: DateTime<Utc>, count| {
        let mut query = Query::select(and(vec![
            Filter::Owned,
            Filter::eq("status", "todo"),
            Filter::Compare {
                column: "due_at".into(),
                op,
                value: json!(iso(boundary)),
            },
        ]));
        query.order = vec![order("due_at", false), order("id", false)];
        query.limit = Some(count);
        query
    };
    let rows: Vec<Task> = repo.query(TASKS, &query(Compare::Le, until, limit + 1))?;
    let later: Vec<Task> = repo.query(TASKS, &query(Compare::Gt, until, 1))?;
    let bounded = &rows[..rows.len().min(limit as usize)];
    let revision = revision(
        &rows
            .iter()
            .map(|task| {
                format!(
                    "{}|{}|{}|{}",
                    task.id,
                    task.title,
                    iso(task.due_at.expect("query requires due date")),
                    task.priority.map(|p| p.to_string()).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>(),
    );
    let next_due = bounded
        .iter()
        .filter_map(|task| task.due_at)
        .find(|due| due > &now);
    let enters = later
        .first()
        .and_then(|task| task.due_at)
        .map(|due| due - Duration::hours(horizon.into()));
    let boundary = next_due.into_iter().chain(enters).min();
    Ok(json!({"data": {
        "source":"tasks", "revision": revision, "nextBoundaryAt": boundary.map(iso),
        "freshness":"fresh", "truncated":rows.len() > limit as usize,
        "items":bounded.iter().map(|task| {
            let due = task.due_at.expect("query requires due date");
            let at = iso(due);
            json!({"entityKey":format!("task:{}",task.id), "episodeKey":format!("task:{}:{at}", task.id),
                "title": task.title, "at":at, "kind":if due < now {"task_overdue"} else {"task_due"},
                "facts":{"priority":task.priority}})
        }).collect::<Vec<_>>()
    }}))
}

// Match JavaScript charCodeAt rather than UTF-8 bytes, including surrogate pairs.
fn revision(parts: &[String]) -> String {
    let mut hash = 0x811c9dc5u32;
    for part in parts {
        for unit in part.encode_utf16().chain(std::iter::once(0x1f)) {
            hash = (hash ^ u32::from(unit)).wrapping_mul(0x01000193);
        }
    }
    format!("{}-{hash:08x}", parts.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_uses_utf16_and_includes_the_lookahead_row() {
        assert_eq!(revision(&[]), "0-811c9dc5");
        // Values obtained from the existing TypeScript heartbeatRevision helper.
        assert_eq!(revision(&["a".into()]), "1-3224db49");
        assert_ne!(revision(&["a".into()]), revision(&["a".into(), "b".into()]));
    }
}
