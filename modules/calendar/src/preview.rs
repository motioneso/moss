//! Day-plan preview. Pure computation over the saved plan, matching the
//! production preview: before/after timing, task eligibility, deadline risk
//! and overlaps between selected changes. Busy intervals come from the
//! provider-backed source context in the production composition; no such
//! adapter exists in this host yet, so availability reports "unavailable"
//! and no calendar-busy conflicts are claimed, exactly as the production
//! route behaves when its source context dependency is absent.
use crate::{context, plans, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

struct TaskFact {
    status: String,
    due_at: Option<String>,
}

fn task_fact(host: &impl Host, actor: &Value, id: &str) -> Option<TaskFact> {
    // A missing task and another account's task look identical, and a missing
    // public adapter degrades to the same answer. Never distinguish them.
    let task = host
        .call("kv", "get", "calendar.task-reference", json!({"id":id}))
        .ok()?;
    let task = &task["task"];
    if task["id"] != id || task["ownerUserId"] != *actor {
        return None;
    }
    Some(TaskFact {
        status: match task["status"].as_str() {
            Some("done") => "done".into(),
            Some("archived") => "archived".into(),
            _ => "other".into(),
        },
        due_at: task["dueAt"].as_str().map(str::to_owned),
    })
}

fn is_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.chars().all(|c| c.is_ascii_hexdigit()))
}

fn invalid(message: impl Into<String>) -> Error {
    Error::coded(400, "day_plan_invalid", message)
}

fn ends_at(starts_at: &str, duration_minutes: i64) -> Result<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(starts_at)
        .map_err(|_| Error::new(503, "Invalid stored plan timing"))?;
    let end = parsed + chrono::Duration::minutes(duration_minutes);
    Ok(end
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace("+00:00", "Z"))
}

fn overlaps(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> bool {
    a_start < b_end && b_start < a_end
}

pub fn preview(host: &impl Host, plan_id: &str, body: Value) -> Result<Value> {
    let object = body
        .as_object()
        .ok_or_else(|| invalid("request must be an object"))?;
    for key in object.keys() {
        if !matches!(key.as_str(), "expectedRevision" | "selectedChangeBlockIds") {
            return Err(invalid(format!("unknown field: {key}")));
        }
    }
    if !is_uuid(plan_id) {
        return Err(invalid("id must be a uuid"));
    }
    let expected = body["expectedRevision"].as_u64().filter(|v| *v >= 1);
    let Some(expected) = expected.filter(|_| body["expectedRevision"].is_u64()) else {
        return Err(Error::new(
            400,
            "expectedRevision must be a positive integer",
        ));
    };
    let selected = body["selectedChangeBlockIds"]
        .as_array()
        .ok_or_else(|| Error::new(400, "selectedChangeBlockIds must be a list"))?;
    let mut selected_ids: Vec<String> = vec![];
    for id in selected {
        let id = id
            .as_str()
            .ok_or_else(|| Error::new(400, "selectedChangeBlockIds must be a list"))?;
        if !is_uuid(id) {
            return Err(Error::new(400, "selectedChangeBlockIds must contain uuids"));
        }
        if !selected_ids.iter().any(|seen| seen == id) {
            selected_ids.push(id.to_owned());
        }
    }
    let plan = plans::get_by_id(host, plan_id)?;
    if plan["revision"].as_u64() != Some(expected) {
        return Err(Error::new(409, "day plan changed since it was read"));
    }
    let blocks = plan["blocks"].as_array().cloned().unwrap_or_default();
    let find = |id: &str| blocks.iter().find(|b| b["id"] == id);
    for id in &selected_ids {
        let block = find(id).ok_or_else(|| {
            invalid(format!("selected change {id} is not part of this plan"))
        })?;
        if block["pendingChange"].is_null() {
            return Err(invalid(format!(
                "selected change {id} has no pending change"
            )));
        }
    }
    let actor = context(host, "read", "call")?["actorUserId"].clone();
    let mut facts = std::collections::BTreeMap::new();
    for block in &blocks {
        if let Some(task_id) = block["taskId"].as_str() {
            if !facts.contains_key(task_id) {
                let fact = task_fact(host, &actor, task_id);
                facts.insert(task_id.to_owned(), fact);
            }
        }
    }
    let fact_of = |task_id: &Option<String>| -> Option<&TaskFact> {
        task_id
            .as_ref()
            .and_then(|id| facts.get(id))
            .and_then(|fact| fact.as_ref())
    };
    let mut out_blocks = vec![];
    let mut eligible_ids = vec![];
    let mut with_timing: Vec<(String, String, i64, Option<String>)> = vec![];
    for id in &selected_ids {
        let block = find(id).unwrap();
        let task_id = block["taskId"].as_str().map(str::to_owned);
        let change = &block["pendingChange"];
        let after = if change["kind"] == "remove" {
            None
        } else {
            Some((
                change["startsAt"].as_str().unwrap_or_default().to_owned(),
                change["durationMinutes"].as_i64().unwrap_or_default(),
            ))
        };
        let before = {
            let placement = &block["actualPlacement"];
            if placement.is_null()
                || placement["startsAt"].is_null()
                || placement["durationMinutes"].is_null()
            {
                None
            } else {
                Some(json!({
                    "startsAt": placement["startsAt"],
                    "durationMinutes": placement["durationMinutes"],
                }))
            }
        };
        let (eligible, reason) = match &task_id {
            None => (true, None),
            Some(_) => match fact_of(&task_id) {
                None => (false, Some("task_unavailable")),
                Some(fact) if fact.status == "done" => (false, Some("task_done")),
                Some(fact) if fact.status == "archived" => (false, Some("task_archived")),
                Some(_) => (true, None),
            },
        };
        let deadline_risk = match (&task_id, &after) {
            (Some(_), Some((start, minutes))) => match fact_of(&task_id)
                .and_then(|fact| fact.due_at.as_deref())
            {
                Some(due) => ends_at(start, *minutes)?.as_str() > due,
                None => false,
            },
            _ => false,
        };
        if eligible {
            eligible_ids.push(json!(id));
        }
        if let Some((start, minutes)) = &after {
            with_timing.push((
                id.clone(),
                start.clone(),
                *minutes,
                block["actualPlacement"]["calendarEventRef"]
                    .as_str()
                    .map(str::to_owned),
            ));
        }
        out_blocks.push(json!({
            "blockId": id,
            "taskId": task_id,
            "changeKind": change["kind"],
            "before": before,
            "after": after.as_ref().map(|(start, minutes)| json!({"startsAt": start, "durationMinutes": minutes})),
            "eligible": eligible,
            "ineligibleReason": reason,
            "deadlineRisk": deadline_risk,
        }));
    }
    let mut conflicts = vec![];
    for i in 0..with_timing.len() {
        for j in (i + 1)..with_timing.len() {
            let (a_id, a_start, a_minutes, _) = &with_timing[i];
            let (b_id, b_start, b_minutes, _) = &with_timing[j];
            if overlaps(
                a_start,
                &ends_at(a_start, *a_minutes)?,
                b_start,
                &ends_at(b_start, *b_minutes)?,
            ) {
                for (block_id, other) in [(a_id, b_id), (b_id, a_id)] {
                    conflicts.push(json!({
                        "blockId": block_id,
                        "kind": "selected_overlap",
                        "withBlockId": other,
                        "detail": "Overlaps another selected change in this preview",
                        "calendarEvent": null,
                    }));
                }
            }
        }
    }
    Ok(json!({
        "revision": plan["revision"],
        "calendarAvailability": "unavailable",
        "calendarAsOf": null,
        "blocks": out_blocks,
        "eligibleBlockIds": eligible_ids,
        "conflicts": conflicts,
    }))
}
