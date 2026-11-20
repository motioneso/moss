//! Catch-up Add task, Dismiss and Undo for the Today section. Every route names the run and
//! the entry. The run is read from the caller's own rows and the entry id is checked against
//! that run's stored catch-up entries, before anything is written. A rating is always stored
//! through the feedback port, which fills in the caller.
use crate::feedback::owned_run;
use crate::gather::api;
use crate::util::call;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

/// Matches the copy the TypeScript Today screen shows for a failed save.
pub const ACTION_FAILED: &str = "That did not save. Try again.";
const NOT_FOUND_CODE: &str = "catch_up_entry_not_found";

struct Target {
    run_id: String,
    item_id: String,
    entry: Value,
}

fn not_found() -> Response {
    Response::new(404, json!({"error": "Catch-up entry is missing or owned by someone else", "code": NOT_FOUND_CODE}))
}

fn failed(extra: Value) -> Response {
    let mut body = json!({"error": ACTION_FAILED});
    if let Some(task_id) = extra.as_str() {
        body["taskId"] = json!(task_id);
    }
    Response::new(500, body)
}

/// Loads the caller's own stored run and finds the entry in it. The stored list is used, not
/// the reader's view, so an entry the caller already handled can still be undone.
fn target<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<std::result::Result<Target, Response>> {
    let param = |key: &str| request.params.get(key).cloned().unwrap_or_default();
    let (run_id, item_id) = (param("run_id"), param("item_id"));
    let actor = call(host)?.actor;
    let Some(run) = owned_run(host, &actor, &run_id)? else { return Ok(Err(not_found())) };
    let entry = run["source_metadata"]["structuredPayload"]["catchUp"]["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["id"].as_str() == Some(item_id.as_str()))
        .cloned();
    Ok(match entry {
        Some(entry) => Ok(Target { run_id, item_id, entry }),
        None => Err(not_found()),
    })
}

fn rate<H: Host + ?Sized>(host: &H, target: &Target, kind: &str) -> Result<String> {
    let reply = host.call(
        "feedback",
        "record",
        "briefing_item",
        json!({
            "targetRef": target.item_id,
            "surface": "briefing",
            "kind": kind,
            "sourceKind": "email",
            "sourceLabel": "Catch-up",
            "metadata": {"briefingRunId": target.run_id},
        }),
    )?;
    reply["id"].as_str().map(str::to_owned).ok_or_else(|| moss_module_sdk::Error::new("The rating has no id"))
}

/// Archives one of the caller's own tasks. `None` means no such task for this caller.
fn archive<H: Host + ?Sized>(host: &H, task_id: &str) -> Result<Option<()>> {
    let reply = api(host, "tasks", "setBriefingTaskStatus", json!({"taskId": task_id, "status": "archived"}))?;
    Ok((!reply["task"].is_null()).then_some(()))
}

/// True when the task is one of the caller's own open tasks.
fn own_open_task<H: Host + ?Sized>(host: &H, task_id: &str) -> Result<bool> {
    let reply = api(host, "tasks", "listBriefingTasks", json!({"status": "todo", "ids": [task_id]}))?;
    Ok(reply["items"].as_array().is_some_and(|items| items.iter().any(|t| t["id"].as_str() == Some(task_id) && t["status"] == "todo")))
}

fn body_text(request: &RouteRequest, key: &str) -> Option<String> {
    request.body[key].as_str().map(str::to_owned).filter(|s| !s.is_empty())
}

pub fn add<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let target = match target(host, request)? {
        Ok(target) => target,
        Err(response) => return Ok(response),
    };
    // A task left over from an earlier failed try is reused when it is still the caller's.
    let stray = match body_text(request, "strayTaskId") {
        Some(id) if own_open_task(host, &id).unwrap_or(false) => Some(id),
        _ => None,
    };
    let task_id = match stray {
        Some(id) => id,
        None => {
            let sender = target.entry["senderName"].as_str().map(str::trim).unwrap_or("");
            let title = if sender.is_empty() { "Follow up".to_owned() } else { format!("Follow up with {sender}") };
            let created = api(
                host,
                "tasks",
                "createFollowUpTask",
                json!({"title": title, "description": target.entry["summary"]}),
            );
            match created.ok().and_then(|r| r["task"]["id"].as_str().map(str::to_owned)) {
                Some(id) => id,
                None => return Ok(failed(Value::Null)),
            }
        }
    };
    match rate(host, &target, "more_like_this") {
        Ok(feedback_id) => Ok(Response::new(200, json!({"status": "added", "feedbackId": feedback_id, "taskId": task_id}))),
        Err(_) => {
            // The task is kept only if archiving it also fails, so a retry can archive it.
            let archived = matches!(archive(host, &task_id), Ok(Some(())));
            Ok(failed(if archived { Value::Null } else { json!(task_id) }))
        }
    }
}

pub fn dismiss<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let target = match target(host, request)? {
        Ok(target) => target,
        Err(response) => return Ok(response),
    };
    // A leftover task is archived only while it is still the caller's open task; a task that was
    // already closed or removed elsewhere is ignored so the dismissal still goes through.
    if let Some(stray) = body_text(request, "strayTaskId") {
        match own_open_task(host, &stray) {
            Ok(true) => match archive(host, &stray) {
                Ok(_) => {}
                Err(_) => return Ok(failed(json!(stray))),
            },
            Ok(false) => {}
            Err(_) => return Ok(failed(json!(stray))),
        }
    }
    match rate(host, &target, "dismiss") {
        Ok(feedback_id) => Ok(Response::new(200, json!({"status": "dismissed", "feedbackId": feedback_id}))),
        Err(_) => Ok(failed(Value::Null)),
    }
}

pub fn undo<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    if let Err(response) = target(host, request)? {
        return Ok(response);
    }
    let (feedback_id, task_id) = (body_text(request, "feedbackId"), body_text(request, "taskId"));
    if feedback_id.is_none() && task_id.is_none() {
        return Ok(Response::new(400, json!({"error": "Nothing to undo"})));
    }
    // The task is checked first so a foreign or closed task id changes nothing.
    if let Some(task) = &task_id {
        match own_open_task(host, task) {
            Ok(true) => {}
            Ok(false) => return Ok(not_found()),
            Err(_) => return Ok(failed(Value::Null)),
        }
    }
    if let Some(id) = &feedback_id {
        if host.call("feedback", "undo", "briefing_item", json!({"id": id})).is_err() {
            return Ok(failed(Value::Null));
        }
    }
    if let Some(task) = &task_id {
        match archive(host, task) {
            Ok(Some(())) => {}
            Ok(None) => return Ok(not_found()),
            Err(_) => return Ok(failed(Value::Null)),
        }
    }
    Ok(Response::new(200, json!({"status": "open"})))
}
