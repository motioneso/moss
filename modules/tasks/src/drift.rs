//! Focus, at-risk and overdue reads over persisted rows.
//! Matching stays in the database. Calendar boundaries come from the public
//! account-date contract; lazy recurrence remains a separate orchestration step.
use crate::{
    repository::{and, order, Repository, Result, TASKS},
    rows::Task,
};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Compare, Filter},
    Host,
};
use serde_json::json;

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn compare(column: &str, op: Compare, value: DateTime<Utc>) -> Filter {
    Filter::Compare {
        column: column.into(),
        op,
        value: json!(iso(value)),
    }
}

pub fn overdue<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    now: DateTime<Utc>,
) -> Result<Vec<Task>> {
    let start = repo.local_day(now, 0)?.start;
    repo.all(
        TASKS,
        and(vec![
            Filter::eq("status", "todo"),
            compare("due_at", Compare::Lt, start),
        ]),
        vec![order("due_at", false), order("id", false)],
    )
}

pub fn at_risk<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    now: DateTime<Utc>,
) -> Result<Vec<Task>> {
    let start = repo.local_day(now, 0)?.start;
    let end = repo.local_day(now, 3)?.start;
    let mut rows: Vec<Task> = repo.all(
        TASKS,
        and(vec![
            Filter::eq("status", "todo"),
            Filter::Compare {
                column: "priority".into(),
                op: Compare::Ge,
                value: json!(3),
            },
            Filter::Or {
                filters: vec![
                    compare("due_at", Compare::Lt, end),
                    compare("do_at", Compare::Lt, start),
                ],
            },
        ]),
        vec![
            order("priority", true),
            order("due_at", false),
            order("id", false),
        ],
    )?;
    // One batched call per thousand candidates, not one call per task.
    let mut done_parents = std::collections::HashSet::new();
    for chunk in rows.chunks(1000) {
        let children: Vec<Task> = repo.all(
            TASKS,
            and(vec![
                Filter::In {
                    column: "parent_task_id".into(),
                    values: chunk.iter().map(|t| json!(t.id)).collect(),
                },
                Filter::eq("status", "done"),
            ]),
            vec![order("id", false)],
        )?;
        done_parents.extend(children.into_iter().filter_map(|t| t.parent_task_id));
    }
    rows.retain(|task| !done_parents.contains(&task.id));
    Ok(rows)
}

pub fn focus<H: Host + ?Sized>(repo: &Repository<'_, H>, now: DateTime<Utc>) -> Result<Vec<Task>> {
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for task in overdue(repo, now)?.into_iter().chain(at_risk(repo, now)?) {
        if seen.insert(task.id.clone()) {
            rows.push(task);
        }
    }
    fn effort_rank(effort: &Option<String>) -> i64 {
        match effort.as_deref() {
            Some("quick") => 0,
            Some("medium") => 1,
            Some("large") => 2,
            _ => 3,
        }
    }
    rows.sort_by(|a, b| {
        let ap = a.priority.map(i64::from).unwrap_or(i64::MIN);
        let bp = b.priority.map(i64::from).unwrap_or(i64::MIN);
        bp.cmp(&ap)
            .then(
                a.due_at
                    .map(|d| d.timestamp_millis())
                    .unwrap_or(i64::MAX)
                    .cmp(&b.due_at.map(|d| d.timestamp_millis()).unwrap_or(i64::MAX)),
            )
            .then(effort_rank(&a.effort).cmp(&effort_rank(&b.effort)))
            .then(a.id.cmp(&b.id))
    });
    Ok(rows)
}
