//! The saved day plan as briefing context. The plan is read through Calendar's public API, never
//! its tables. Only bounded, cleaned fields are kept. No task body, mail or calendar text rides
//! along, and every free string is treated as outside text.
use crate::gather::api;
use crate::gather_types::{Gap, Reason};
use crate::trust::sanitize_external;
use chrono::{DateTime, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const BLOCK_CAP: usize = 24;
const PRIORITY_TASK_ID_CAP: usize = 8;
const CORRECTION_CAP: usize = 8;
const COMMITMENT_CAP: usize = 16;
const NOTES_CAP: usize = 400;
const CORRECTION_NOTE_CAP: usize = 200;
const BLOCK_TITLE_CAP: usize = 120;

fn cut(text: String, max: usize) -> String {
    if text.chars().count() > max { text.chars().take(max).collect() } else { text }
}

fn block(raw: &Value) -> Value {
    let kind = raw["pendingChange"]["kind"].as_str().filter(|k| matches!(*k, "add" | "move" | "remove"));
    let title = match raw["title"].as_str() {
        Some(_) => json!(cut(sanitize_external(&raw["title"]), BLOCK_TITLE_CAP)),
        None => Value::Null,
    };
    let placement = &raw["actualPlacement"];
    let mut out = json!({
        "id": raw["id"], "kind": raw["kind"], "taskId": raw["taskId"], "title": title,
        "position": raw["position"],
        "actualPlacement": if placement.is_object() {
            json!({"startsAt": placement["startsAt"], "durationMinutes": placement["durationMinutes"], "calendarEventRef": placement["calendarEventRef"]})
        } else { Value::Null },
        "pendingChange": kind,
    });
    if matches!(kind, Some("add" | "move")) {
        out["pendingStartsAt"] = raw["pendingChange"]["startsAt"].clone();
        out["pendingDurationMinutes"] = raw["pendingChange"]["durationMinutes"].clone();
    }
    out
}

fn array(value: &Value, cap: usize) -> Vec<Value> {
    value.as_array().into_iter().flatten().take(cap).cloned().collect()
}

fn intent(raw: &Value) -> Value {
    let corrections: Vec<Value> = array(&raw["corrections"], CORRECTION_CAP)
        .iter()
        .map(|c| json!({"taskId": c["taskId"], "note": cut(sanitize_external(&c["note"]), CORRECTION_NOTE_CAP), "source": c["source"]}))
        .collect();
    let commitments: Vec<Value> =
        array(&raw["commitments"], COMMITMENT_CAP).iter().map(|c| json!({"taskId": c["taskId"], "decision": c["decision"]})).collect();
    json!({
        "priorityTaskIds": array(&raw["priorityTaskIds"], PRIORITY_TASK_ID_CAP),
        "capacity": raw["capacity"],
        "notes": if raw["notes"].is_null() { Value::Null } else { json!(cut(sanitize_external(&raw["notes"]), NOTES_CAP)) },
        "corrections": corrections,
        "commitments": commitments,
    })
}

fn has_intent(raw: &Value) -> bool {
    raw.is_object()
        && (!raw["capacity"].is_null()
            || !raw["notes"].is_null()
            || ["priorityTaskIds", "corrections", "commitments"].iter().any(|k| raw[*k].as_array().is_some_and(|a| !a.is_empty())))
}

/// A saved plan reduced to what a briefing may carry.
pub fn project(plan: &Value) -> Value {
    json!({
        "version": 1,
        "planId": plan["id"], "revision": plan["revision"], "localDay": plan["localDay"],
        "timeZone": plan["timeZone"], "sourceRunId": plan["sourceRunId"],
        "eveningIntent": if has_intent(&plan["eveningIntent"]) { intent(&plan["eveningIntent"]) } else { Value::Null },
        "blocks": array(&plan["blocks"], BLOCK_CAP).iter().map(block).collect::<Vec<_>>(),
    })
}

/// The owner's saved plan for the run's local day, or null. No plan gives null and no gap. A
/// failed read gives null and one `day_plan` gap, and the run still succeeds. Nothing is written.
pub fn resolve<H: Host + ?Sized>(host: &H, now: DateTime<Utc>, zone: chrono_tz::Tz, gaps: &mut Vec<Gap>) -> Value {
    let day = now.with_timezone(&zone).date_naive().to_string();
    match api(host, "calendar", "getPlan", json!({"localDay": day, "timeZone": zone.name()})) {
        Ok(reply) if reply["plan"].is_object() => project(&reply["plan"]),
        Ok(_) => Value::Null,
        Err(_) => {
            gaps.push(Gap { source: "day_plan", reason: Reason::ToolFailed });
            Value::Null
        }
    }
}
