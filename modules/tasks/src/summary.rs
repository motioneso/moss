//! Bounded summary read. It never advances recurrence.
//! Days are UTC until the public actor-timezone seam exists.
use crate::{
    repository::{Error, Repository, Result},
    rows::Task,
};
use chrono::{DateTime, NaiveDate, SecondsFormat, TimeZone, Utc};
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
fn due_state(task: &Task, today: NaiveDate) -> &'static str {
    if task.status != "todo" {
        return "inactive";
    }
    match task.due_at {
        None => "undated",
        Some(due) => {
            let day = due.date_naive();
            if day < today {
                "overdue"
            } else if day == today {
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
    let today = now.date_naive();
    let start = Utc.from_utc_datetime(&today.and_hms_opt(0, 0, 0).expect("midnight"));
    let end = start + chrono::Duration::days(1);
    let mut rows: Vec<Task> = repo
        .persisted_tasks()?
        .into_iter()
        .filter(|t| match scope {
            "completed" => t.status == "done",
            "all" => true,
            "overdue" => t.status == "todo" && t.due_at.is_some_and(|d| d < start),
            "upcoming" => t.status == "todo" && t.due_at.is_some_and(|d| d >= end),
            "undated" => t.status == "todo" && t.due_at.is_none(),
            _ => t.status == "todo" && (t.due_at.is_none() || t.due_at.is_some_and(|d| d < end)),
        })
        .collect();
    rows.sort_by(|a, b| {
        a.due_at
            .map(|d| d.timestamp())
            .unwrap_or(i64::MAX)
            .cmp(&b.due_at.map(|d| d.timestamp()).unwrap_or(i64::MAX))
            .then(a.id.cmp(&b.id))
    });
    let truncated = rows.len() > LIMIT;
    let items: Vec<Value> = rows
        .iter()
        .take(LIMIT)
        .map(|t| {
            json!({"id":t.id,"title":t.title,"status":t.status,"priority":t.priority,
            "dueAt":t.due_at.map(iso),"dueState":due_state(t, today),
            "completedAt":t.completed_at.map(iso),"updatedAt":iso(t.updated_at),
            "recurring":t.recurrence.is_some()})
        })
        .collect();
    let count = items.len();
    let coverage = format!(
        "{}. {} Includes owned and explicitly shared tasks visible to you. Recurring tasks show persisted occurrences only; future occurrences are not generated. Reminders are not included. Due labels use local calendar days; original date-only intent is not retained in task storage.",
        label(scope),
        if truncated {
            format!("Partial: first {count} matching tasks; more exist.")
        } else {
            format!("{count} matching persisted tasks in this scope.")
        }
    );
    Ok(json!({"data":{
        "summary":{"scope":scope,"timeZone":"UTC","localDate":today.to_string(),
        "retrievedAt":iso(now),"truncated":truncated,"items":items},
        "coverage":coverage
    }}))
}
