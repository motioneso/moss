//! Day-plan review choices. Saving replaces every draft row; applying selects changes.
use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub placement: String,
    pub starts_at: Option<String>,
}
pub type Choices = BTreeMap<String, Choice>;
pub fn blocks(plan: &Value) -> &[Value] {
    plan["blocks"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn on_calendar(block: &Value) -> bool {
    block["actualPlacement"]["startsAt"].is_string()
}
pub fn duration(block: &Value) -> Option<i64> {
    block["pendingChange"]["durationMinutes"]
        .as_i64()
        .or_else(|| block["actualPlacement"]["durationMinutes"].as_i64())
}
pub fn start(block: &Value) -> Option<String> {
    block["pendingChange"]["startsAt"]
        .as_str()
        .or_else(|| block["actualPlacement"]["startsAt"].as_str())
        .map(str::to_owned)
}
pub fn choice(block: &Value, choices: &Choices) -> Choice {
    choices
        .get(block["id"].as_str().unwrap_or_default())
        .cloned()
        .unwrap_or_else(|| Choice {
            placement: if on_calendar(block) {
                "keep"
            } else if !block["taskId"].is_null() {
                "keep-proposed"
            } else if !block["pendingChange"].is_null() || on_calendar(block) {
                "keep"
            } else {
                "leave"
            }
            .into(),
            starts_at: None,
        })
}
pub fn pending(block: &Value, choices: &Choices) -> Value {
    let c = choice(block, choices);
    match c.placement.as_str() {
        "add" | "move" => match (c.starts_at, duration(block)) {
            (Some(at), Some(minutes)) => {
                json!({"kind":c.placement,"startsAt":at,"durationMinutes":minutes})
            }
            _ => block["pendingChange"].clone(),
        },
        "remove" => json!({"kind":"remove"}),
        "leave" => Value::Null,
        _ => block["pendingChange"].clone(),
    }
}
pub fn draft(plan: &Value, choices: &Choices) -> Value {
    json!({"date":plan["localDay"],"timeZone":plan["timeZone"],"expectedRevision":plan["revision"],
        "blocks":blocks(plan).iter().map(|b|json!({"id":b["id"],"kind":b["kind"],"taskId":b["taskId"],"title":b["title"],"pendingChange":pending(b,choices)})).collect::<Vec<_>>()})
}
pub fn selection(plan: &Value, choices: &Choices, all: bool) -> Vec<String> {
    blocks(plan)
        .iter()
        .filter(|b| {
            let p = pending(b, choices);
            if all {
                !b["taskId"].is_null() && !on_calendar(b) && p["kind"] == "add"
            } else {
                choices.contains_key(b["id"].as_str().unwrap_or_default()) && !p.is_null()
            }
        })
        .filter_map(|b| b["id"].as_str().map(str::to_owned))
        .collect()
}
pub fn other_edits(plan: &Value, choices: &Choices) -> bool {
    blocks(plan).iter().any(|b| {
        matches!(b["pendingChange"]["kind"].as_str(), Some("move" | "remove"))
            || matches!(
                pending(b, choices)["kind"].as_str(),
                Some("move" | "remove")
            )
    })
}
pub fn local_time(iso: &str, zone: Tz) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|d| d.with_timezone(&zone).format("%H:%M").to_string())
        .unwrap_or_default()
}
/// Match wall-time input: choose the earlier occurrence in a fall-back fold, reject a spring gap.
pub fn instant(day: &str, time: &str, zone: Tz) -> Option<String> {
    let at = NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()?
        .and_time(NaiveTime::parse_from_str(time, "%H:%M").ok()?);
    Some(
        zone.from_local_datetime(&at)
            .earliest()?
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}
pub fn key(plan: &Value, ids: &[String]) -> String {
    let mut sorted = ids.to_vec();
    sorted.sort();
    let input = format!(
        "{}|{}|{}",
        plan["id"].as_str().unwrap_or_default(),
        plan["revision"],
        sorted.join(",")
    );
    let hash = input.encode_utf16().fold(0x811c9dc5u32, |h, c| {
        (h ^ u32::from(c)).wrapping_mul(0x01000193)
    });
    format!("review-{hash:08x}")
}
pub fn eligible(preview: &Value, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| {
            preview["eligibleBlockIds"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == id.as_str()))
                && !preview["conflicts"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v["blockId"] == id.as_str()))
        })
        .cloned()
        .collect()
}
pub fn retry_ids(report: &Value) -> Vec<String> {
    report["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| matches!(i["outcome"].as_str(), Some("failed" | "unknown")))
        .filter_map(|i| i["itemId"].as_str().map(str::to_owned))
        .collect()
}
pub fn report_text(report: &Value) -> String {
    let items = report["items"].as_array().cloned().unwrap_or_default();
    let count = |kind: &str| items.iter().filter(|i| i["outcome"] == kind).count();
    let mut text = format!("Applied {}", count("applied"));
    for (kind, label) in [
        ("failed", "failed"),
        ("pending", "pending"),
        ("unknown", "need checking"),
    ] {
        let n = count(kind);
        if n > 0 {
            text.push_str(&format!("; {n} {label}"));
        }
    }
    if report["status"] == "denied" {
        text.push_str(". Calendar changes weren't allowed. Review the plan and try again.");
    }
    text
}

/// A failed request may already have placed some additions. Refresh the local
/// choices against those saved facts before another save can propose them again.
pub fn reconcile_choices(plan: &Value, choices: &mut Choices) {
    choices.retain(|id, choice| {
        let Some(block) = blocks(plan).iter().find(|block| block["id"] == id.as_str()) else {
            return true;
        };
        if choice.placement != "add" || !on_calendar(block) {
            return true;
        }
        let wanted = choice
            .starts_at
            .as_deref()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok());
        let placed = block["actualPlacement"]["startsAt"]
            .as_str()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok());
        if (choice.starts_at.is_none() || (wanted.is_some() && wanted == placed))
            && block["pendingChange"].is_null()
        {
            return false;
        }
        choice.placement = "move".into();
        true
    });
}
