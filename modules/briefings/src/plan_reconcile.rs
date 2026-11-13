//! Overnight differences for a saved day plan, shown as bounded lines. A committed block whose
//! calendar event is gone or moved, a timed block overlapping another event, and a priority or
//! committed task finished since the save. A calendar that was not read says nothing about events.
use crate::trust::sanitize_external;
use chrono::{DateTime, Utc};
use serde_json::Value;

const OVERNIGHT_LINE_CAP: usize = 8;
const RECOMMENDATION: &str = "review before accepting";

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|t| !t.is_empty())
}

fn instant(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text(value)?).ok().map(|t| t.with_timezone(&Utc))
}

fn minutes(value: &Value) -> Option<i64> {
    value.as_i64().filter(|m| *m > 0)
}

/// A task's title by id, else the fallback.
pub fn name_of(tasks: &[Value], task_id: Option<&str>, fallback: &str) -> String {
    task_id
        .and_then(|id| tasks.iter().find(|t| t["id"] == id))
        .and_then(|t| text(&t["title"]))
        .unwrap_or(fallback)
        .to_owned()
}

/// The proposed window first, the placed window otherwise.
fn window(block: &Value) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let span = |start: &Value, mins: &Value| Some((instant(start)?, instant(start)? + chrono::Duration::minutes(minutes(mins)?)));
    span(&block["pendingStartsAt"], &block["pendingDurationMinutes"])
        .or_else(|| span(&block["actualPlacement"]["startsAt"], &block["actualPlacement"]["durationMinutes"]))
}

/// When the block's placed event ends. A proposed move does not change where the event is.
fn placed_end(block: &Value) -> Option<DateTime<Utc>> {
    let start = instant(&block["actualPlacement"]["startsAt"])?;
    Some(start + chrono::Duration::minutes(minutes(&block["actualPlacement"]["durationMinutes"])?))
}

fn overlaps(start: DateTime<Utc>, end: DateTime<Utc>, event: &Value) -> bool {
    if event["allDay"] == true {
        return false;
    }
    match (instant(&event["startsAt"]), instant(&event["endsAt"])) {
        (Some(from), Some(to)) => start < to && from < end,
        _ => false,
    }
}

fn is_ref(event: &Value, reference: &str) -> bool {
    event["id"] == reference || event["eventKey"] == reference
}

/// `calendar` is `None` when the calendar was not read, which is different from no events.
/// Calendar leaves out events that have already ended, so a missing event counts as lost only
/// while its block is still ahead of `now`.
pub fn overnight_changes(plan: &Value, calendar: Option<&[Value]>, tasks: &[Value], now: DateTime<Utc>) -> Vec<String> {
    let mut lines: Vec<String> = vec![];
    let blocks = plan["blocks"].as_array().cloned().unwrap_or_default();
    if let Some(events) = calendar {
        for block in &blocks {
            let fallback = text(&block["title"]).or_else(|| text(&block["id"])).unwrap_or_default();
            let name = name_of(tasks, text(&block["taskId"]), fallback);
            let reference = text(&block["actualPlacement"]["calendarEventRef"]);
            if let Some(reference) = reference {
                match events.iter().find(|e| is_ref(e, reference)) {
                    None if placed_end(block).is_none_or(|end| end <= now) => {}
                    None => {
                        lines.push(format!("Overnight change: \"{name}\" lost its calendar event; {RECOMMENDATION}."));
                        continue;
                    }
                    Some(event) => {
                        if text(&event["startsAt"]).is_some_and(|moved| Some(moved) != block["actualPlacement"]["startsAt"].as_str()) {
                            lines.push(format!("Overnight change: the event under \"{name}\" moved; {RECOMMENDATION}."));
                        }
                    }
                }
            }
            if let Some((start, end)) = window(block) {
                let clash = events.iter().find(|e| !reference.is_some_and(|r| is_ref(e, r)) && overlaps(start, end, e));
                if let Some(clash) = clash {
                    let title = text(&clash["title"]).unwrap_or("an event");
                    lines.push(format!("Overnight change: \"{name}\" now overlaps \"{title}\"; {RECOMMENDATION}."));
                }
            }
        }
    }
    let mut watched: Vec<String> = vec![];
    let mut watch = |id: Option<&str>| {
        if let Some(id) = id.filter(|i| !watched.iter().any(|w| w == i)) {
            watched.push(id.to_owned());
        }
    };
    plan["eveningIntent"]["priorityTaskIds"].as_array().into_iter().flatten().for_each(|id| watch(id.as_str()));
    blocks.iter().filter(|b| b["actualPlacement"].is_object()).for_each(|b| watch(b["taskId"].as_str()));
    plan["eveningIntent"]["commitments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["decision"] == "commit")
        .for_each(|c| watch(c["taskId"].as_str()));
    for id in &watched {
        let status = tasks.iter().find(|t| t["id"] == id.as_str()).and_then(|t| text(&t["status"]));
        if let Some(status @ ("done" | "archived")) = status {
            lines.push(format!("Overnight change: \"{}\" is {status}; {RECOMMENDATION}.", name_of(tasks, Some(id), id)));
        }
    }
    lines.into_iter().map(|l| sanitize_external(&Value::from(l))).filter(|l| !l.is_empty()).take(OVERNIGHT_LINE_CAP).collect()
}
