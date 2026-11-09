//! Declared module routes. The signed-in host supplies decoded path parameters.
use crate::{
    parse,
    repository::{Error, Repository, Result},
    rows::Task,
};
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

pub fn handle<H: Host + ?Sized>(host: &H, mut request: RouteRequest) -> Response {
    if let Err(error) = crate::validation::validate(&mut request) {
        return error.response();
    }
    match dispatch(host, &Repository::new(host), &request) {
        Ok(response) => response,
        Err(error) => error.response(),
    }
}
fn task_json<H: Host + ?Sized>(repo: &Repository<'_, H>, task: Task) -> Result<Value> {
    Ok(task.dto(&repo.task_tags(&task.id)?))
}
fn tasks_json<H: Host + ?Sized>(repo: &Repository<'_, H>, tasks: Vec<Task>) -> Result<Vec<Value>> {
    tasks.into_iter().map(|t| task_json(repo, t)).collect()
}
fn drift_json<H: Host + ?Sized>(repo: &Repository<'_, H>, tasks: &[Task]) -> Result<Vec<Value>> {
    let tags = crate::list::tags_for_tasks(repo, tasks)?;
    Ok(tasks
        .iter()
        .map(|t| t.dto(tags.get(&t.id).map(Vec::as_slice).unwrap_or_default()))
        .collect())
}
fn param<'a>(request: &'a RouteRequest, name: &str) -> Result<&'a str> {
    request
        .params
        .get(name)
        .map(String::as_str)
        .ok_or(Error::Http(400, "Missing route parameter"))
}
fn name(request: &RouteRequest) -> Result<String> {
    parse::required_string(parse::require_object(&request.body)?.get("name"), "name")
}
fn dispatch<H: Host + ?Sized>(
    host: &H,
    repo: &Repository<'_, H>,
    r: &RouteRequest,
) -> Result<Response> {
    let mut status = 200;
    let body = match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/tasks") => {
            let quadrant = parse::optional_string(r.query.get("quadrant"), "quadrant")?;
            if quadrant
                .as_ref()
                .is_some_and(|v| !["do", "schedule", "delegate", "eliminate"].contains(&v.as_str()))
            {
                return Err(Error::Http(
                    400,
                    "quadrant must be do, schedule, delegate, or eliminate",
                ));
            }
            let tag = parse::optional_string(r.query.get("tagId"), "tagId")?;
            let now: chrono::DateTime<chrono::Utc> = repo
                .now()?
                .parse()
                .map_err(|_| Error::Http(500, "Internal server error"))?;
            let mut rows = vec![];
            for task in repo.persisted_tasks()? {
                if let Some(q) = &quadrant {
                    let actual = crate::list::quadrant(&task, now);
                    if q != actual {
                        continue;
                    }
                }
                let tags = repo.task_tags(&task.id)?;
                if tag
                    .as_ref()
                    .is_some_and(|id| !tags.iter().any(|t| &t.id == id))
                {
                    continue;
                }
                rows.push(task.dto(&tags));
            }
            json!({"tasks":rows})
        }
        ("POST", "/tasks") => {
            let input = parse::parse_create_task(&r.body)?;
            status = 201;
            json!({"task":task_json(repo,repo.create_task(&input)?)?})
        }
        ("GET", "/tasks/focus") => {
            let now = repo
                .now()?
                .parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| Error::Http(500, "Internal server error"))?;
            json!({"tasks":drift_json(repo,&crate::drift::focus(repo,now)?)?,"signals":[]})
        }
        ("GET", "/tasks/at-risk") => {
            let now = repo
                .now()?
                .parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| Error::Http(500, "Internal server error"))?;
            json!({"tasks":drift_json(repo,&crate::drift::at_risk(repo,now)?)?})
        }
        ("GET", "/tasks/overdue") => {
            let now = repo
                .now()?
                .parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| Error::Http(500, "Internal server error"))?;
            json!({"tasks":drift_json(repo,&crate::drift::overdue(repo,now)?)?})
        }
        ("POST", "/tasks/search/interpret") => {
            crate::search_interpret::interpret(repo, host, &r.body)?
        }
        ("GET", "/tasks/:id") => {
            let task = repo
                .task(param(r, "id")?)?
                .ok_or(Error::Http(404, "Task not found"))?;
            json!({"task":task_json(repo,task)?})
        }
        ("PATCH", "/tasks/:id") => {
            let input = parse::parse_update_task(&r.body)?;
            let task = repo
                .update_task(param(r, "id")?, &input)?
                .ok_or(Error::Http(404, "Task not found"))?;
            json!({"task":task_json(repo,task)?})
        }
        ("GET", "/tasks/:id/subtasks") => {
            json!({"tasks":tasks_json(repo,repo.subtasks(param(r,"id")?)?)?})
        }
        ("POST", "/tasks/:id/breakdown") => {
            let steps = r.body["steps"].as_array().expect("validated steps");
            let steps = steps
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let text = parse::js_trim(value.as_str().expect("validated step"));
                    if text.is_empty() {
                        Err(Error::http(
                            400,
                            format!("steps[{index}] must be a non-empty string"),
                        ))
                    } else {
                        Ok(text.to_owned())
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            status = 201;
            json!({"tasks":tasks_json(repo,repo.break_down(param(r,"id")?, &steps)?)?})
        }
        ("POST", "/tasks/:id/deferred-status") => {
            status = 202;
            crate::jobs::enqueue(repo, param(r, "id")?, &r.body)?
        }
        ("GET", "/tasks/preferences") => json!({"preferences":repo.preferences()?.dto()}),
        ("PATCH", "/tasks/preferences") => {
            let body = parse::require_object(&r.body)?;
            let view = body
                .get("defaultView")
                .and_then(Value::as_str)
                .unwrap_or_default();
            json!({"preferences":repo.set_default_view(view)?.dto()})
        }
        ("GET", "/tasks/lists") => {
            json!({"lists":repo.lists()?.iter().map(|t| t.dto()).collect::<Vec<_>>()})
        }
        ("POST", "/tasks/lists") => {
            status = 201;
            json!({"list":repo.get_or_create_list(&name(r)?)?.dto()})
        }
        ("PATCH", "/tasks/lists/:list_id") => {
            json!({"list":repo.rename_list(param(r,"list_id")?,&name(r)?)?.dto()})
        }
        ("DELETE", "/tasks/lists/:list_id") => {
            let body = parse::require_object(&r.body)?;
            let destination =
                parse::optional_string(body.get("reassignToListId"), "reassignToListId")?;
            repo.delete_list(param(r, "list_id")?, destination.as_deref())?;
            json!({"deleted":true})
        }
        ("GET", "/tasks/lists/:list_id/tags") => {
            json!({"tags":repo.tags(param(r,"list_id")?)?.iter().map(|t| t.dto()).collect::<Vec<_>>()})
        }
        ("POST", "/tasks/lists/:list_id/tags") => {
            status = 201;
            json!({"tag":repo.create_tag(param(r,"list_id")?,&name(r)?)?.dto()})
        }
        ("PATCH", "/tasks/lists/:list_id/tags/:tag_id") => {
            json!({"tag":repo.rename_tag(param(r,"list_id")?,param(r,"tag_id")?,&name(r)?)?.dto()})
        }
        ("DELETE", "/tasks/lists/:list_id/tags/:tag_id") => {
            repo.delete_tag(param(r, "list_id")?, param(r, "tag_id")?)?;
            json!({"deleted":true})
        }
        ("POST", "/tasks/:id/tags") => {
            let body = parse::require_object(&r.body)?;
            let tag = parse::required_string(body.get("tagId"), "tagId")?;
            repo.assign_tag(param(r, "id")?, &tag)?;
            let task = repo
                .task(param(r, "id")?)?
                .ok_or(Error::Http(404, "Task not found"))?;
            json!({"task":task_json(repo,task)?})
        }
        ("DELETE", "/tasks/:id/tags/:tag_id") => {
            repo.unassign_tag(param(r, "id")?, param(r, "tag_id")?)?;
            let task = repo
                .task(param(r, "id")?)?
                .ok_or(Error::Http(404, "Task not found"))?;
            json!({"task":task_json(repo,task)?})
        }
        ("GET", "/tasks/:id/activity") => {
            json!({"activity":repo.activity(param(r,"id")?)?.iter().map(|t| t.dto()).collect::<Vec<_>>()})
        }
        ("POST", "/tasks/:id/activity") => {
            let input = parse::parse_activity(&r.body)?;
            let row =
                repo.add_activity(param(r, "id")?, &input.activity_type, input.body.as_deref())?;
            status = 201;
            json!({"activity":row.dto()})
        }
        _ => return Err(Error::Http(404, "Route not found")),
    };
    Ok(Response::new(status, body))
}
