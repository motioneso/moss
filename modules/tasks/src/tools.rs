//! Read tools that do not advance recurrence or call other modules. The host
//! selects the actor and enforces the account's tool approval policy.
use crate::{
    repository::{Error, Repository, Result},
    rows::Task,
    schema::{self, Schema},
};
use moss_module_sdk::Host;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolRequest {
    pub tool: String,
    pub parameters: Value,
}

pub fn handle<H: Host + ?Sized>(host: &H, request: ToolRequest) -> Result<Value> {
    let mut input = request.parameters;
    let required: &'static [&'static str] = match request.tool.as_str() {
        "tasks.get" | "tasks.activity" => &["taskId"],
        "tasks.listTags" => &["listId"],
        "tasks.listLists" => &[],
        _ => return Err(Error::Http(400, "Unknown Tasks tool")),
    };
    let properties = required
        .iter()
        .map(|key| (*key, Schema::string()))
        .collect();
    schema::validate(&Schema::object(required, properties), &mut input, "input")
        .map_err(|e| Error::http(400, e.message))?;
    let repo = Repository::new(host);
    Ok(match request.tool.as_str() {
        "tasks.listLists" => {
            json!({"data":{"items":repo.lists()?.iter().map(|v|v.dto()).collect::<Vec<_>>()}})
        }
        "tasks.listTags" => {
            json!({"data":{"items":repo.tags(input["listId"].as_str().unwrap())?.iter().map(|v|v.dto()).collect::<Vec<_>>()}})
        }
        "tasks.activity" => {
            json!({"data":{"items":repo.activity(input["taskId"].as_str().unwrap())?.iter().map(|v|v.dto()).collect::<Vec<_>>()}})
        }
        "tasks.get" => {
            let id = input["taskId"].as_str().unwrap();
            let Some(task) = repo.task(id)? else {
                return Ok(json!({"data":{"error":"Task not found"}}));
            };
            let subtasks = repo
                .subtasks(id)?
                .into_iter()
                .map(|task| task_json(&repo, task))
                .collect::<Result<Vec<_>>>()?;
            let activity = repo.activity(id)?;
            let activity = activity[activity.len().saturating_sub(10)..]
                .iter()
                .map(|v| v.dto())
                .collect::<Vec<_>>();
            json!({"data":{"task":task_json(&repo,task)?,"subtasks":subtasks,"activity":activity}})
        }
        _ => unreachable!("tool name validated above"),
    })
}

fn task_json<H: Host + ?Sized>(repo: &Repository<'_, H>, task: Task) -> Result<Value> {
    Ok(task.dto(&repo.task_tags(&task.id)?))
}
