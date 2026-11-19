//! Saved-record presentation matching the TypeScript day-plan view model.
use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub task_id: Option<String>,
    pub state: &'static str,
    pub label: &'static str,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub minutes: Option<i64>,
    pub unavailable: bool,
    pub first_proposal: bool,
    pub flexible: bool,
    pub kind_label: &'static str,
    pub reason: Option<String>,
    pub location: Option<String>,
}
fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
fn instant(value: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}
pub fn clock(at: i64, zone: Tz, twelve: bool) -> String {
    DateTime::<Utc>::from_timestamp_millis(at)
        .map(|d| {
            d.with_timezone(&zone)
                .format(if twelve { "%-I:%M%P" } else { "%H:%M" })
                .to_string()
        })
        .unwrap_or_default()
}
pub fn length(minutes: Option<i64>) -> String {
    match minutes {
        Some(60) => "1 hour".into(),
        Some(m) if m > 0 && m % 60 == 0 => format!("{} hours", m / 60),
        Some(m) if m > 0 => format!("{m} min"),
        _ => String::new(),
    }
}
fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn items(saved: &Value, events: &Value, day: NaiveDate, zone: Tz, twelve: bool) -> Vec<Item> {
    let mut calendar = vec![];
    for event in array(&events["events"]) {
        let Some(start) = instant(&event["startsAt"]) else {
            continue;
        };
        if DateTime::<Utc>::from_timestamp_millis(start)
            .unwrap()
            .with_timezone(&zone)
            .date_naive()
            != day
        {
            continue;
        }
        let end = instant(&event["endsAt"]);
        calendar.push(Item {
            id: format!("event:{}", event["id"].as_str().unwrap_or_default()),
            title: text(&event["title"]).unwrap_or_default(),
            task_id: None,
            state: "event",
            label: "",
            start: Some(start),
            end,
            minutes: end.map(|e| ((e - start) / 60000).max(0)),
            unavailable: false,
            first_proposal: false,
            flexible: false,
            kind_label: "",
            reason: None,
            location: text(&event["location"]),
        });
    }
    let blocks = array(&saved["plan"]["blocks"]);
    let committed = blocks.iter().any(|b| {
        b["pendingChange"].is_null() && instant(&b["actualPlacement"]["startsAt"]).is_some()
    });
    let mut ordered = blocks.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|b| b["position"].as_i64().unwrap_or_default());
    let mut out = vec![];
    for block in ordered {
        let task_id = text(&block["taskId"]);
        let summary = array(&saved["tasks"])
            .iter()
            .find(|t| task_id.as_deref().is_some_and(|id| t["id"] == id));
        let actual = instant(&block["actualPlacement"]["startsAt"]);
        let pending = &block["pendingChange"];
        let placement = if !pending.is_null() && pending["kind"] != "remove" {
            pending
        } else {
            &block["actualPlacement"]
        };
        let start = instant(&placement["startsAt"]);
        let minutes = placement["durationMinutes"].as_i64();
        let (state, label) = if summary.is_some_and(|t| t["status"] == "done") {
            ("completed", "Done")
        } else if !pending.is_null() {
            ("pending", "Change pending")
        } else if start.is_some() {
            ("committed", "On the calendar")
        } else if task_id.is_some() && (!saved["plan"]["eveningIntent"].is_null() || committed) {
            ("proposed", "Proposed, not on the calendar yet")
        } else {
            ("unscheduled", "Unscheduled")
        };
        let end = start
            .zip(minutes.filter(|m| *m > 0))
            .map(|(s, m)| s + m * 60000);
        let kind = block["kind"].as_str().unwrap_or_default();
        let reason = if kind == "prep" {
            end.and_then(|end| {
                calendar
                    .iter()
                    .find(|e| {
                        let moss = array(&events["events"]).iter().any(|raw| {
                            format!("event:{}", raw["id"].as_str().unwrap_or_default()) == e.id
                                && raw["isMossBlock"] == true
                        });
                        !moss
                            && e.start
                                .is_some_and(|start| (0..=300000).contains(&(start - end)))
                    })
                    .map(|e| {
                        format!(
                            "For {} at {}",
                            e.title,
                            clock(e.start.unwrap(), zone, twelve)
                        )
                    })
            })
        } else {
            None
        };
        out.push(Item {
            id: format!("block:{}", block["id"].as_str().unwrap_or_default()),
            title: summary
                .and_then(|t| text(&t["title"]))
                .or_else(|| text(&block["title"]))
                .unwrap_or_else(|| "Untitled block".into()),
            unavailable: task_id
                .as_ref()
                .is_some_and(|id| array(&saved["unavailableTaskIds"]).iter().any(|v| v == id)),
            task_id,
            state,
            label,
            start,
            end,
            minutes,
            first_proposal: state == "pending" && actual.is_none() && start.is_some(),
            flexible: state == "committed" && !block["taskId"].is_null(),
            kind_label: match kind {
                "prep" => "Preparation",
                "travel" => "Travel",
                _ => "",
            },
            reason,
            location: None,
        });
    }
    out.extend(calendar);
    // Stable order preserves saved block positions and puts untimed blocks last.
    out.sort_by_key(|item| item.start.unwrap_or(i64::MAX));
    out
}

#[derive(Debug, PartialEq)]
pub struct Gap {
    pub after: String,
    pub start: i64,
    pub end: i64,
    pub label: &'static str,
}
pub fn gaps(items: &[Item]) -> (Vec<Gap>, Option<i64>) {
    let timed = items
        .iter()
        .filter(|i| i.start.is_some())
        .collect::<Vec<_>>();
    let Some(first) = timed.first() else {
        return (vec![], None);
    };
    let resolve = |i: usize| {
        timed[i]
            .end
            .or_else(|| {
                timed[i + 1..]
                    .iter()
                    .filter_map(|t| t.start)
                    .find(|s| *s > timed[i].start.unwrap())
            })
            .unwrap_or(i64::MAX)
    };
    let mut end = resolve(0);
    let mut out = vec![];
    for i in 1..timed.len() {
        let start = timed[i].start.unwrap();
        if start.saturating_sub(end) >= 60000 {
            out.push(Gap {
                after: timed[i - 1].id.clone(),
                start: end,
                end: start,
                label: if start - end <= 1800000 {
                    "A break before the next block"
                } else {
                    "Open time"
                },
            });
        }
        end = end.max(resolve(i));
    }
    let _ = first;
    (out, (end != i64::MAX).then_some(end))
}
