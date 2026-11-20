//! The Needs you section on Today. Rows come from the caller's latest morning run, or from
//! suggested tasks when no run exists. Each row's status is read live from Tasks, which also
//! owns every change and every ownership check.
use crate::action_rows::project_action_rows;
use crate::gather::{api, items};
use crate::runs::{is_uuid, payload_of, run_rows};
use crate::util::{bad_request, call};
use crate::definitions;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

const NOT_FOUND: &str = "Task not found";

/// What a task's status means for the row that names it.
fn live_status(task: &str) -> Option<&'static str> {
    match task {
        "suggested" => Some("suggested"),
        "todo" | "done" => Some("accepted"),
        "archived" => Some("dismissed"),
        _ => None,
    }
}

/// The caller's newest succeeded morning run, if there is one.
fn latest_run<H: Host + ?Sized>(host: &H, actor: &str) -> Result<Option<Value>> {
    let Some(definition) = definitions::owned_of_type(host, actor, "morning")? else { return Ok(None) };
    let id = definition["id"].as_str().unwrap_or_default();
    Ok(run_rows(host, id)?
        .into_iter()
        .find(|r| r["status"] == "succeeded" && r["owner_user_id"].as_str() == Some(actor)))
}

fn reply(state: &str, rows: Vec<Value>, run: Option<&Value>, tasks: bool) -> Response {
    let run = run.map(|r| json!({"id": r["id"], "createdAt": r["created_at"]}));
    Response::new(200, json!({"state": state, "rows": rows, "run": run, "tasks": tasks}))
}

/// Rows with a live status. With no Tasks answer the rows still show, without a status.
pub fn get<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let actor = call(host)?.actor;
    let Some(run) = latest_run(host, &actor)? else {
        let suggested = api(host, "tasks", "listBriefingTasks", json!({"status": "suggested"}));
        return Ok(match suggested {
            Ok(r) => {
                let tasks: Vec<Value> = items(&r).into_iter().filter(|t| t["status"] == "suggested").collect();
                let rows = project_action_rows(&tasks).rows;
                reply(if rows.is_empty() { "none" } else { "rows" }, rows, None, true)
            }
            Err(_) => reply("none", vec![], None, false),
        });
    };
    let stored = payload_of(&run["source_metadata"])["actionRows"].as_array().cloned().unwrap_or_default();
    let ids: Vec<&str> = stored.iter().filter_map(|r| r["taskId"].as_str()).collect();
    let live = api(host, "tasks", "listBriefingTasks", json!({"ids": ids}));
    let Ok(live) = live else {
        let rows = stored.into_iter().map(|mut r| { r["status"] = Value::Null; r }).collect();
        return Ok(reply("rows", rows, Some(&run), false));
    };
    let live = items(&live);
    // A row whose task is gone, or is not the caller's, is dropped. Tasks answers for the caller only.
    let rows: Vec<Value> = stored
        .into_iter()
        .filter_map(|mut row| {
            let task = live.iter().find(|t| t["id"] == row["taskId"])?;
            row["status"] = json!(live_status(task["status"].as_str()?)?);
            Some(row)
        })
        .collect();
    Ok(reply("rows", rows, Some(&run), true))
}

/// Accept or dismiss one task. Tasks decides whether the caller owns it and whether the move is
/// allowed; nothing here trusts the run's stored copy.
pub fn act<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let task = request.params.get("task_id").cloned().unwrap_or_default();
    let action = match request.body.as_object() {
        Some(b) if b.len() == 1 => b.get("action").and_then(Value::as_str),
        _ => None,
    };
    let status = match action {
        Some("accept") => "todo",
        Some("dismiss") => "archived",
        _ => return Ok(bad_request("action must be accept or dismiss")),
    };
    if !is_uuid(&task) {
        return Ok(Response::new(404, json!({"error": NOT_FOUND})));
    }
    let changed = api(host, "tasks", "setBriefingTaskStatus", json!({"taskId": task, "status": status}));
    Ok(match changed {
        Err(_) => Response::new(409, json!({"error": "That task can't be changed from here."})),
        Ok(r) if r["task"].is_null() => Response::new(404, json!({"error": NOT_FOUND})),
        Ok(r) => {
            let live = r["task"]["status"].as_str().and_then(live_status);
            Response::new(200, json!({"taskId": task, "status": live}))
        }
    })
}
