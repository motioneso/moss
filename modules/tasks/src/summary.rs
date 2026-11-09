//! Bounded summary read. It never advances recurrence.
//! Calendar days come from the public account-date contract.
use crate::{
    repository::{Error, Repository, Result},
    rows::Task,
};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub const SCOPES: [&str; 6] = [
    "today",
    "overdue",
    "upcoming",
    "undated",
    "completed",
    "all",
];
const LIMIT: usize = 12;

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn due_state(task: &Task, start: DateTime<Utc>, end: DateTime<Utc>) -> &'static str {
    if task.status != "todo" {
        return "inactive";
    }
    match task.due_at {
        None => "undated",
        Some(due) => {
            if due < start {
                "overdue"
            } else if due < end {
                "today"
            } else {
                "upcoming"
            }
        }
    }
}
fn label(scope: &str) -> &'static str {
    match scope {
        "overdue" => "Overdue open tasks",
        "upcoming" => "Open tasks due after today",
        "undated" => "Open tasks without a due date",
        "completed" => "Completed tasks",
        "all" => "All persisted task states",
        _ => "Open tasks due today or earlier, plus undated tasks",
    }
}

pub fn execute<H: Host + ?Sized>(repo: &Repository<'_, H>, input: &Value) -> Result<Value> {
    if input
        .as_object()
        .is_some_and(|o| o.keys().any(|k| k != "scope"))
    {
        return Err(Error::Http(400, "Invalid task summary scope"));
    }
    let scope = input
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("today");
    if !SCOPES.contains(&scope) {
        return Err(Error::Http(400, "Invalid task summary scope"));
    }
    let now: DateTime<Utc> = repo
        .now()?
        .parse()
        .map_err(|_| Error::Http(500, "Internal server error"))?;
    let day = repo.local_day(now, 0)?;
    let today = day.date;
    let start = day.start;
    let end = day.next_start;
    let cmp = |column: &str, op: moss_module_sdk::query::Compare, at: DateTime<Utc>| {
        moss_module_sdk::query::Filter::Compare {
            column: column.into(),
            op,
            value: json!(iso(at)),
        }
    };
    use moss_module_sdk::query::{Compare, Filter};
    let filter = match scope {
        "completed" => Filter::eq("status", "done"),
        "all" => Filter::All,
        "overdue" => crate::repository::and(vec![
            Filter::eq("status", "todo"),
            cmp("due_at", Compare::Lt, start),
        ]),
        "upcoming" => crate::repository::and(vec![
            Filter::eq("status", "todo"),
            cmp("due_at", Compare::Ge, end),
        ]),
        "undated" => crate::repository::and(vec![
            Filter::eq("status", "todo"),
            Filter::Null {
                column: "due_at".into(),
                not: false,
            },
        ]),
        _ => crate::repository::and(vec![
            Filter::eq("status", "todo"),
            Filter::Or {
                filters: vec![
                    Filter::Null {
                        column: "due_at".into(),
                        not: false,
                    },
                    cmp("due_at", Compare::Lt, end),
                ],
            },
        ]),
    };
    let mut query = moss_module_sdk::query::Query::select(filter);
    query.order = vec![
        crate::repository::order("due_at", false),
        crate::repository::order("id", false),
    ];
    query.limit = Some((LIMIT + 1) as u32);
    let rows: Vec<Task> = repo.query(crate::repository::TASKS, &query)?;
    let mut due_dates = std::collections::BTreeMap::new();
    for task in &rows {
        if let Some(due) = task.due_at {
            due_dates.insert(task.id.as_str(), repo.local_day(due, 0)?.date.to_string());
        }
    }
    // Match the legacy bound: at most twelve rows, then drop rows from the
    // end while the plain-text form runs over 4,000 UTF-16 code units.
    let coverage = |count: usize, truncated: bool| {
        format!(
            "{}. {} Includes owned and explicitly shared tasks visible to you. Recurring tasks show persisted occurrences only; future occurrences are not generated. Reminders are not included. Due labels use local calendar days; original date-only intent is not retained in task storage.",
            label(scope),
            if truncated {
                format!("Partial: first {count} matching tasks; more exist.")
            } else {
                format!("{count} matching persisted tasks in this scope.")
            }
        )
    };
    let item_text = |t: &Task| {
        let state = match t.status.as_str() {
            "done" => "Completed",
            "suggested" => "Suggested",
            "archived" => "Archived",
            _ => "Open",
        };
        let due = match t.due_at {
            None => "No due date".to_string(),
            Some(_) => {
                let state = due_state(t, start, end);
                format!(
                    "Due {}{}",
                    due_dates.get(t.id.as_str()).expect("resolved due date"),
                    match state {
                        "overdue" => " · Overdue",
                        "today" => " · Due today",
                        _ => "",
                    }
                )
            }
        };
        format!(
            "{} · {}{}{}{}",
            state,
            due,
            t.priority
                .map(|p| format!(" · Priority {p}/5"))
                .unwrap_or_default(),
            if t.recurrence.is_some() {
                " · Recurring (persisted occurrence)"
            } else {
                ""
            },
            t.completed_at
                .map(|at| format!(" · Completed at {}", iso(at)))
                .unwrap_or_default()
        )
    };
    let formatted = |rows: &[Task], truncated: bool| {
        let body = rows
            .iter()
            .map(|t| {
                format!(
                    "{} [{}]: {}; stored due timestamp {}; updated {}",
                    t.title,
                    t.id,
                    item_text(t),
                    t.due_at.map(iso).unwrap_or_else(|| "none".into()),
                    iso(t.updated_at)
                )
            })
            .collect::<Vec<_>>()
            .join(". ");
        format!(
            "{} · {} · {}. {}{}Tasks; retrieved {}. {}",
            label(scope),
            today,
            day.timezone,
            body,
            if rows.is_empty() { "" } else { ". " },
            iso(now),
            coverage(rows.len(), truncated)
        )
    };
    let mut bounded: Vec<Task> = rows.iter().take(LIMIT).cloned().collect();
    let mut truncated = rows.len() > LIMIT;
    while bounded.len() > 1 && formatted(&bounded, truncated).encode_utf16().count() > 4000 {
        bounded.pop();
        truncated = true;
    }
    let items: Vec<Value> = bounded
        .iter()
        .map(|t| {
            json!({"id":t.id,"title":t.title,"status":t.status,"priority":t.priority,
            "dueAt":t.due_at.map(iso),"dueState":due_state(t, start, end),
            "completedAt":t.completed_at.map(iso),"updatedAt":iso(t.updated_at),
            "recurring":t.recurrence.is_some()})
        })
        .collect();
    let coverage = coverage(items.len(), truncated);
    Ok(json!({"data":{
        "summary":{"scope":scope,"timeZone":day.timezone,"localDate":today.to_string(),
        "retrievedAt":iso(now),"truncated":truncated,"items":items},
        "coverage":coverage
    }}))
}
