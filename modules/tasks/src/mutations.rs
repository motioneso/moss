//! Assistant mutation results mirror the legacy tools. Only declared, typed
//! Tasks queries run here; the host owns actor selection, approval and commit.
use crate::{
    repository::{Repository, Result, TAGS},
    rows::{Tag, Task},
    tool_fields,
};
use moss_module_sdk::{query::Filter, Host};
use serde_json::{json, Value};

pub fn execute<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    tool: &str,
    input: &Value,
) -> Result<Value> {
    let text = |key: &str| input[key].as_str().unwrap();
    Ok(match tool {
        "tasks.create" => {
            let task = repo.create_task(&tool_fields::task_fields(input)?)?;
            task_result(repo, format!("Created task: {}", task.title), task)?
        }
        "tasks.update" | "tasks.updateStatus" => {
            if tool == "tasks.updateStatus"
                && !["todo", "done", "archived"].contains(&text("status"))
            {
                return Ok(json!({"data":{"error":"Invalid status"}}));
            }
            let Some(task) = repo.update_task(text("taskId"), &tool_fields::task_fields(input)?)?
            else {
                return Ok(json!({"data":{"error":"Task not found"}}));
            };
            let verb = if tool == "tasks.update" {
                "Updated"
            } else {
                match task.status.as_str() {
                    "done" => "Completed",
                    "archived" => "Archived",
                    _ => "Reopened",
                }
            };
            task_result(repo, format!("{verb} task: {}", task.title), task)?
        }
        "tasks.breakDown" => {
            let steps = input["steps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            let tasks = repo.break_down(text("taskId"), &steps)?;
            json!({"data":{"summary":format!("Added {} subtask{}.",tasks.len(),if tasks.len()==1 {""} else {"s"}),"tasks":tasks.iter().map(|t|t.dto(&[])).collect::<Vec<_>>()}})
        }
        "tasks.addActivity" => {
            let Some(task) = repo.task(text("taskId"))? else {
                return Ok(json!({"data":{"error":"Task not found"}}));
            };
            let activity = repo.add_activity(
                &task.id,
                input["activityType"].as_str().unwrap_or("comment"),
                input["body"].as_str(),
            )?;
            json!({"data":{"summary":format!("Added note/activity to {}.",task.title),"activity":activity.dto()}})
        }
        "tasks.assignTag" | "tasks.unassignTag" => {
            let id = text("taskId");
            let tag = text("tagId");
            let name = if tool == "tasks.assignTag" {
                repo.assign_tag(id, tag)?;
                repo.task_tags(id)?
                    .into_iter()
                    .find(|t| t.id == tag)
                    .map(|t| t.name)
            } else {
                let name = repo
                    .first::<Tag>(TAGS, Filter::eq("id", tag))?
                    .map(|t| t.name);
                repo.unassign_tag(id, tag)?;
                name
            };
            let Some(task) = repo.task(id)? else {
                return Ok(json!({"data":{"error":"Task not found"}}));
            };
            let verb = if tool == "tasks.assignTag" {
                "Assigned"
            } else {
                "Removed"
            };
            task_result(
                repo,
                format!("{verb} tag {}.", name.as_deref().unwrap_or(tag)),
                task,
            )?
        }
        "tasks.createList" => {
            let list = repo.get_or_create_list(text("name"))?;
            json!({"data":{"summary":format!("Created task list: {}",list.name),"list":list.dto()}})
        }
        "tasks.renameList" => {
            let list = repo.rename_list(text("listId"), text("name"))?;
            json!({"data":{"summary":format!("Renamed task list: {}",list.name),"list":list.dto()}})
        }
        "tasks.createTag" | "tasks.renameTag" => {
            let (tag, verb) = if tool == "tasks.createTag" {
                (repo.create_tag(text("listId"), text("name"))?, "Created")
            } else {
                (
                    repo.rename_tag(text("listId"), text("tagId"), text("name"))?,
                    "Renamed",
                )
            };
            json!({"data":{"summary":format!("{verb} tag {}.",tag.name),"tag":tag.dto()}})
        }
        "tasks.deleteTag" => {
            repo.delete_tag(text("listId"), text("tagId"))?;
            json!({"data":{"summary":"Deleted task tag.","deleted":true}})
        }
        _ => unreachable!("mutation tool schema already checked"),
    })
}
fn task_result<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    summary: String,
    task: Task,
) -> Result<Value> {
    Ok(json!({"data":{"summary":summary,"task":task.dto(&repo.task_tags(&task.id)?)}}))
}
