//! Public calls for Briefings: read task facts, change a suggested task's status, add a follow-up.
//! Every read and write is limited to tasks the caller owns.
use crate::{
    list,
    repository::{and, order, values, Repository, TASKS},
    rows::Task,
};
use moss_module_sdk::{
    query::{Filter, Query},
    Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_IDS: usize = 200;
const MAX_TITLE: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefingTasks {
    status: Option<BriefingStatus>,
    completed_after: Option<String>,
    ids: Option<Vec<String>>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum BriefingStatus {
    Todo,
    Done,
    Suggested,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetStatus {
    task_id: String,
    status: TargetStatus,
}

#[derive(Deserialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum TargetStatus {
    Todo,
    Archived,
}

impl TargetStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Archived => "archived",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowUp {
    title: String,
    description: Option<String>,
}

fn fail(message: &'static str) -> Error {
    Error::new(message)
}

fn caller<H: Host + ?Sized>(host: &H) -> Result<Value> {
    host.call("context", "read", "call", json!({}))
}

/// Only these fields leave. Notes, tags and ownership stay behind, except for action rows.
fn item(t: &Value, rich: bool) -> Value {
    if rich {
        json!({
            "id":t["id"],"title":t["title"],"status":t["status"],
            "dueAt":t["dueAt"],"priority":t["priority"],
            "description":t["description"],"source":t["source"],
            "sourceRef":t["sourceRef"],"updatedAt":t["updatedAt"],
            "suggestionMetadata":t["suggestionMetadata"]})
    } else {
        json!({
            "id":t["id"],"title":t["title"],"status":t["status"],
            "dueAt":t["dueAt"],"priority":t["priority"]})
    }
}

pub fn list_tasks<H: Host + ?Sized>(host: &H, b: BriefingTasks) -> Result<Value> {
    let repo = Repository::new(host);
    let unavailable = |_| fail("Briefing tasks unavailable");
    let (listed, rich) = if let Some(ids) = b.ids {
        // Named tasks come back in any status, archived included, so a dismissed row can say so.
        if b.status.is_some() || b.completed_after.is_some() || ids.len() > MAX_IDS {
            return Err(fail("Briefing tasks unavailable"));
        }
        let tasks: Vec<Task> = if ids.is_empty() {
            Vec::new()
        } else {
            repo.all(
                TASKS,
                and(vec![
                    Filter::In {
                        column: "id".into(),
                        values: ids.iter().map(|i| json!(i)).collect(),
                    },
                    Filter::Owned,
                ]),
                vec![order("updated_at", true), order("id", false)],
            )
            .map_err(unavailable)?
        };
        let items: Vec<Value> = tasks.iter().map(|t| t.dto(&[])).collect();
        (json!({"data":{"items":items}}), true)
    } else {
        let status = b.status.ok_or_else(|| fail("Briefing tasks unavailable"))?;
        let mut input = json!({"status": match status {
            BriefingStatus::Todo => "todo",
            BriefingStatus::Done => "done",
            BriefingStatus::Suggested => "suggested",
        }});
        if let Some(after) = b.completed_after {
            input["completedAfter"] = after.into();
        }
        (
            list::execute(&repo, &input).map_err(unavailable)?,
            matches!(status, BriefingStatus::Suggested),
        )
    };
    // A task someone shared with the caller is readable but is not the caller's own,
    // so it must not enter their briefing.
    let me = caller(host)?;
    let items: Vec<_> = listed["data"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| !me["actorUserId"].is_null() && t["ownerUserId"] == me["actorUserId"])
        .map(|t| item(t, rich))
        .collect();
    Ok(json!({"items":items}))
}

/// suggested to todo, suggested to archived, todo to archived. A repeat is a no-op.
fn allowed(from: &str, to: TargetStatus) -> bool {
    from == to.as_str()
        || matches!(
            (from, to),
            ("suggested", _) | ("todo", TargetStatus::Archived)
        )
}

pub fn set_status<H: Host + ?Sized>(host: &H, r: SetStatus) -> Result<Value> {
    let repo = Repository::new(host);
    let failed = |_| fail("Briefing task status unavailable");
    let mine = and(vec![Filter::Owned, Filter::eq("id", r.task_id.as_str())]);
    let Some(task) = repo.first::<Task>(TASKS, mine.clone()).map_err(failed)? else {
        return Ok(json!({"task":null}));
    };
    if !allowed(&task.status, r.status) {
        return Err(fail("Task status change not allowed"));
    }
    if task.status == r.status.as_str() {
        return Ok(json!({"task":{"id":task.id,"status":task.status}}));
    }
    let now = repo.now().map_err(failed)?;
    let updated: Vec<Task> = repo
        .query(
            TASKS,
            &Query::update(
                mine,
                values(json!({"status":r.status.as_str(),"completed_at":null,"updated_at":now})),
            ),
        )
        .map_err(failed)?;
    let Some(task) = updated.into_iter().next() else {
        return Ok(json!({"task":null}));
    };
    Ok(json!({"task":{"id":task.id,"status":task.status}}))
}

pub fn follow_up<H: Host + ?Sized>(host: &H, r: FollowUp) -> Result<Value> {
    let title = r.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE {
        return Err(fail("Follow-up title is invalid"));
    }
    let failed = |_| fail("Follow-up task unavailable");
    let repo = Repository::new(host);
    let list = repo.get_or_create_list("Personal").map_err(failed)?.id;
    let now = repo.now().map_err(failed)?;
    let task: Task = repo
        .one(
            TASKS,
            Query::insert(values(json!({
                "title":title,"description":r.description,"list_id":list,"status":"todo",
                "source":"manual","position":0,"created_at":now,"updated_at":now,
            }))),
        )
        .map_err(failed)?;
    Ok(json!({"task":{"id":task.id,"status":task.status}}))
}
