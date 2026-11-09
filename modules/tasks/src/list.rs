//! Interactive list filtering over persisted rows. Actor-local recurrence
//! reconciliation awaits the public timezone contract, as on the HTTP list route.
use crate::{
    dates::{parse_js_date, to_iso_string},
    repository::{and, order, Error, Repository, Result, ASSIGNMENTS, TAGS, TASKS},
    rows::{Tag, Task},
};
use chrono::{DateTime, Duration, Utc};
use moss_module_sdk::{
    query::{Compare, Filter},
    Host,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const IMPORTANT_PRIORITY: i16 = 4;
const URGENCY_HOURS: i64 = 48;

pub fn execute<H: Host + ?Sized>(repo: &Repository<'_, H>, input: &Value) -> Result<Value> {
    let mut filters = Vec::new();
    for (key, column) in [
        ("listId", "list_id"),
        ("status", "status"),
        ("priority", "priority"),
    ] {
        if let Some(value) = input.get(key) {
            filters.push(Filter::eq(column, value.clone()));
        }
    }
    for (key, column, op) in [
        ("dueBefore", "due_at", Compare::Lt),
        ("dueAfter", "due_at", Compare::Gt),
        ("completedAfter", "completed_at", Compare::Gt),
    ] {
        if let Some(text) = input[key].as_str().filter(|s| !s.is_empty()) {
            let date = parse_js_date(text).ok_or(Error::Http(400, "Invalid task filter date"))?;
            filters.push(Filter::Compare {
                column: column.into(),
                op,
                value: json!(to_iso_string(date)),
            });
        }
    }
    if let Some(selected) = input["quadrant"].as_str() {
        let now = repo
            .now()?
            .parse()
            .map_err(|_| Error::Http(500, "Invalid host time"))?;
        filters.push(quadrant_filter(selected, now));
    }
    let tasks: Vec<Task> = if let Some(tag) = input["tagId"].as_str() {
        let assignments: Vec<Value> = repo.all(
            ASSIGNMENTS,
            Filter::eq("tag_id", tag),
            vec![order("task_id", false)],
        )?;
        let ids = assignments
            .iter()
            .map(|row| row["task_id"].clone())
            .collect::<Vec<_>>();
        let mut rows: Vec<Task> = Vec::new();
        for chunk in ids.chunks(1000) {
            let mut selected = filters.clone();
            selected.push(Filter::In {
                column: "id".into(),
                values: chunk.to_vec(),
            });
            rows.extend(repo.all(
                TASKS,
                and(selected),
                vec![order("updated_at", true), order("id", false)],
            )?);
        }
        // Membership chunks are disjoint; merge in the same order as PostgreSQL.
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        rows
    } else {
        repo.all(
            TASKS,
            if filters.is_empty() {
                Filter::All
            } else {
                and(filters)
            },
            vec![order("updated_at", true), order("id", false)],
        )?
    };
    let tags = tags_for_tasks(repo, &tasks)?;
    let items = tasks
        .iter()
        .map(|task| {
            let assigned = tags.get(&task.id).map(Vec::as_slice).unwrap_or_default();
            task.dto(assigned)
        })
        .collect::<Vec<_>>();
    Ok(json!({"data":{"items":items},"columnOrder":["id","title","status","dueAt","priority"]}))
}

/// Same priority/48-hour matrix as the legacy HTTP and tool contracts.
pub(crate) fn quadrant(task: &Task, now: DateTime<Utc>) -> &'static str {
    match (
        task.priority.is_some_and(|p| p >= IMPORTANT_PRIORITY),
        task.due_at
            .is_some_and(|d| d <= now + Duration::hours(URGENCY_HOURS)),
    ) {
        (true, true) => "do",
        (true, false) => "schedule",
        (false, true) => "delegate",
        (false, false) => "eliminate",
    }
}

fn quadrant_filter(selected: &str, now: DateTime<Utc>) -> Filter {
    let axis = |column: &str, op, value, positive| {
        let comparison = Filter::Compare {
            column: column.into(),
            op,
            value,
        };
        if positive {
            comparison
        } else {
            Filter::Or {
                filters: vec![
                    Filter::Null {
                        column: column.into(),
                        not: false,
                    },
                    comparison,
                ],
            }
        }
    };
    let important = matches!(selected, "do" | "schedule");
    let urgent = matches!(selected, "do" | "delegate");
    and(vec![
        axis(
            "priority",
            if important { Compare::Ge } else { Compare::Lt },
            json!(IMPORTANT_PRIORITY),
            important,
        ),
        axis(
            "due_at",
            if urgent { Compare::Le } else { Compare::Gt },
            json!(to_iso_string(now + Duration::hours(URGENCY_HOURS))),
            urgent,
        ),
    ])
}

// Chunk membership filters to the public query limit. Fetch tags in database
// collation order rather than doing two host calls per returned task.
pub(crate) fn tags_for_tasks<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    tasks: &[Task],
) -> Result<BTreeMap<String, Vec<Tag>>> {
    let mut links: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for chunk in tasks.chunks(1000) {
        let rows: Vec<Value> = repo.all(
            ASSIGNMENTS,
            Filter::In {
                column: "task_id".into(),
                values: chunk.iter().map(|t| json!(t.id)).collect(),
            },
            vec![order("task_id", false), order("tag_id", false)],
        )?;
        for row in rows {
            let task = row["task_id"]
                .as_str()
                .ok_or(Error::Http(500, "Invalid assignment"))?;
            let tag = row["tag_id"]
                .as_str()
                .ok_or(Error::Http(500, "Invalid assignment"))?;
            links.entry(task.into()).or_default().insert(tag.into());
        }
    }
    if links.is_empty() {
        return Ok(BTreeMap::new());
    }
    let ids = links
        .values()
        .flat_map(|ids| ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    let tags: Vec<Tag> = repo.all(
        TAGS,
        if ids.len() <= 1000 {
            Filter::In {
                column: "id".into(),
                values: ids.into_iter().map(Value::String).collect(),
            }
        } else {
            Filter::All
        },
        vec![order("name", false), order("id", false)],
    )?;
    Ok(links
        .into_iter()
        .map(|(task, ids)| {
            (
                task,
                tags.iter()
                    .filter(|tag| ids.contains(&tag.id))
                    .cloned()
                    .collect(),
            )
        })
        .collect())
}
