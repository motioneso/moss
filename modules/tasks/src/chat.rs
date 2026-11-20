//! Adapters for the chat host. The legacy API and route policy keep their own contracts.
use crate::repository::{Repository, Result, LISTS, TAGS};
use moss_module_sdk::{
    query::{Filter, Query},
    Host,
};
use serde_json::{json, Value};

pub fn prepare<H: Host + ?Sized>(host: &H, input: &Value) -> Value {
    let Some(tool) = input["tool"].as_str() else {
        return Value::Null;
    };
    let mut wrapped = crate::approval::prepare(host, tool, &input["parameters"].to_string());
    let mut card = wrapped["ok"].take();
    if card.is_object() {
        // Task actions are unpinned; the approved record binds the exact proposed inputs.
        card.as_object_mut().unwrap().remove("version");
        card.as_object_mut().unwrap().remove("content");
    }
    card
}

pub fn before<H: Host + ?Sized>(repo: &Repository<'_, H>, tool: &str, p: &Value) -> Result<Value> {
    if let Some(id) = p["taskId"].as_str() {
        return Ok(repo.task(id)?.map(|t| t.dto(&[])).unwrap_or(Value::Null));
    }
    let table = if tool.ends_with("Tag") { TAGS } else { LISTS };
    let id = if table == TAGS {
        &p["tagId"]
    } else {
        &p["listId"]
    };
    let Some(id) = id.as_str() else {
        return Ok(Value::Null);
    };
    Ok(repo
        .query::<Value>(table, &Query::select(Filter::eq("id", id)))?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

fn shown(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::String(s) => s.clone(),
        _ => value.to_string(),
    }
}

pub fn completed(tool: &str, p: &Value, before: &Value, result: &mut Value) {
    if result["data"].get("error").is_some() {
        return;
    }
    let after = result["data"]
        .get("task")
        .or_else(|| result["data"].get("list"))
        .or_else(|| result["data"].get("tag"))
        .unwrap_or(&Value::Null)
        .clone();
    let mut fields = Vec::new();
    for (key, label) in [
        ("title", "Title"),
        ("description", "Description"),
        ("status", "Status"),
        ("priority", "Priority"),
        ("dueAt", "Due at"),
        ("doAt", "Do at"),
        ("effort", "Effort"),
        ("recurrence", "Recurrence"),
        ("name", "Name"),
        ("listId", "List"),
        ("parentTaskId", "Parent task"),
    ] {
        if let Some(value) = p.get(key) {
            fields.push(json!({"label":label,"before":shown(&before[key]),"after":shown(after.get(key).unwrap_or(value))}));
        }
    }
    for (key, label) in [
        ("steps", "Subtasks"),
        ("body", "Activity"),
        ("activityType", "Activity type"),
    ] {
        if let Some(value) = p.get(key) {
            fields.push(json!({"label":label,"before":"None","after":shown(value)}));
        }
    }
    if tool.ends_with("assignTag") {
        fields.push(json!({"label":"Tag","before":if tool=="tasks.assignTag" {"Unassigned"} else {"Assigned"},"after":if tool=="tasks.assignTag" {"Assigned"} else {"Unassigned"}}));
    }
    if tool == "tasks.deleteTag" || tool == "tasks.deleteList" {
        fields.push(json!({"label":"Name","before":shown(&before["name"]),"after":"Deleted"}));
        if let Some(to) = p.get("reassignToListId") {
            fields.push(json!({"label":"Move tasks to list","before":shown(&p["listId"]),"after":shown(to)}));
        }
    }
    if fields.is_empty() {
        if tool == "tasks.addActivity" {
            fields.push(json!({"label":"Activity type","before":"None","after":result["data"]["activity"]["activityType"].as_str().unwrap_or("comment")}));
        } else {
            fields.push(json!({"label":"Updated at","before":shown(&before["updatedAt"]),"after":shown(&after["updatedAt"])}));
        }
    }
    result["data"]["changed"] = json!(fields);
}
