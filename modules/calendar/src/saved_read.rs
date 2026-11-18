//! Live public-reference summaries beside the unchanged saved plan.
use crate::{plans, Result};
use moss_module_sdk::Host;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskSummary {
    id: String,
    title: String,
    status: String,
    due_at: Option<String>,
    do_at: Option<String>,
    effort: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    id: String,
    briefing_type: String,
    status: String,
    created_at: String,
}

pub fn read(host: &impl Host, day: plans::Day) -> Result<Value> {
    let plan = plans::get_for_day(host, day)?["plan"].clone();
    let mut ids = Vec::<String>::new();
    let mut remember = |id: &Value| {
        if let Some(id) = id.as_str() {
            if !ids.iter().any(|seen| seen == id) {
                ids.push(id.into());
            }
        }
    };
    if let Some(priorities) = plan["eveningIntent"]["priorityTaskIds"].as_array() {
        for id in priorities {
            remember(id);
        }
    }
    for items in [
        &plan["eveningIntent"]["corrections"],
        &plan["eveningIntent"]["commitments"],
        &plan["blocks"],
    ] {
        if let Some(items) = items.as_array() {
            for item in items {
                remember(&item["taskId"]);
            }
        }
    }
    let mut tasks = Vec::new();
    let mut unavailable = Vec::new();
    for id in ids {
        // Visibility (including explicit shares) belongs to the public adapter's
        // authenticated scope. Do not query another module's tables here.
        let task = host
            .call("kv", "get", "calendar.task-reference", json!({"id":id}))
            .ok()
            .and_then(|value| serde_json::from_value::<TaskSummary>(value["task"].clone()).ok())
            .filter(|task| task.id == id);
        match task {
            Some(task) => tasks.push(task),
            None => unavailable.push(id),
        }
    }
    let source_id = plan["sourceRunId"].as_str();
    let source = source_id.and_then(|id| {
        host.call("kv", "get", "calendar.briefing-reference", json!({"id":id}))
            .ok()
            .and_then(|value| serde_json::from_value::<RunSummary>(value["run"].clone()).ok())
            .filter(|run| run.id == id)
    });
    Ok(json!({
        "plan":plan,"tasks":tasks,"unavailableTaskIds":unavailable,
        "sourceRunUnavailable":source_id.is_some() && source.is_none(),"sourceRun":source
    }))
}
