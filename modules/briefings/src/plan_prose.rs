//! The saved day plan as one outside-text section. Every free string is cleaned and the list is
//! capped. No plan gives an empty section, which the prompt shows as "(none today)".
use crate::gather::stamp;
use crate::gather_types::{cap_lines, Section};
use crate::plan_reconcile::{name_of, overnight_changes};
use crate::trust::sanitize_external;
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

pub const KEY: &str = "day_plan";
pub const LABEL: &str = "SAVED DAY PLAN";
const NO_BLOCKS_LINE: &str = "No task blocks were planned for today.";

fn committed(block: &Value, zone: chrono_tz::Tz) -> String {
    let place = &block["actualPlacement"];
    let start = place["startsAt"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc));
    match (start, place["durationMinutes"].as_i64().filter(|m| *m > 0)) {
        (Some(start), Some(mins)) => {
            let end = (start + Duration::minutes(mins)).with_timezone(&zone).format("%H:%M");
            format!("committed {}-{end}", stamp(&place["startsAt"], zone))
        }
        _ => "committed".to_owned(),
    }
}

fn block_line(block: &Value, zone: chrono_tz::Tz) -> String {
    let title = block["title"].as_str().filter(|t| !t.is_empty()).or_else(|| block["id"].as_str()).unwrap_or_default();
    let name = format!("{} \"{title}\" (position {})", block["kind"].as_str().unwrap_or("block"), block["position"]);
    if let Some(change) = block["pendingChange"].as_str() {
        return format!("{name}: pending change: {change}");
    }
    if !block["actualPlacement"].is_object() {
        return format!("{name}: proposed, not on the calendar yet");
    }
    format!("{name}: {}", committed(block, zone))
}

/// `calendar` is `None` when the calendar was not read.
pub fn section(plan: &Value, tasks: &[Value], calendar: Option<&[Value]>, zone: chrono_tz::Tz) -> Section {
    if !plan.is_object() {
        return Section::empty(KEY, LABEL);
    }
    let mut lines: Vec<String> = vec![];
    let intent = &plan["eveningIntent"];
    let list = |value: &Value| value.as_array().cloned().unwrap_or_default();
    if intent.is_object() {
        for id in list(&intent["priorityTaskIds"]) {
            let id = id.as_str().unwrap_or_default();
            lines.push(format!("Priority (saved last evening): {}", name_of(tasks, Some(id), id)));
        }
        if let Some(capacity) = intent["capacity"].as_str().filter(|c| !c.is_empty()) {
            lines.push(format!("Capacity (saved last evening): {capacity}"));
        }
        if let Some(note) = intent["notes"].as_str().filter(|n| !n.is_empty()) {
            lines.push(format!("Note (saved last evening): {note}"));
        }
        for c in list(&intent["corrections"]) {
            lines.push(format!("Correction ({}): {}", c["source"].as_str().unwrap_or("user"), c["note"].as_str().unwrap_or_default()));
        }
        for c in list(&intent["commitments"]) {
            lines.push(format!("Commitment: {} {}", c["taskId"].as_str().unwrap_or_default(), c["decision"].as_str().unwrap_or_default()));
        }
    }
    let blocks = list(&plan["blocks"]);
    lines.extend(blocks.iter().map(|b| block_line(b, zone)));
    lines.extend(overnight_changes(plan, calendar, tasks));
    if intent.is_object() && blocks.is_empty() {
        lines.push(NO_BLOCKS_LINE.to_owned());
    }
    let cleaned: Vec<String> = lines.into_iter().map(|l| sanitize_external(&Value::from(l))).filter(|l| !l.is_empty()).collect();
    let count = cleaned.len();
    let (lines, _) = cap_lines(cleaned);
    Section { key: KEY, label: LABEL, lines, count, raw: vec![] }
}
