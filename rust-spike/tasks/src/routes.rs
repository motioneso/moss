//! The Tasks HTTP routes, ported from `packages/tasks/src/routes.ts`.
//!
//! Each handler runs a request in Fastify's order. The body is parsed and checked against the
//! route schema first, then the handler resolves access, parses its input and opens one data
//! context. Fastify parses a body on every method except GET, HEAD and TRACE, so routes without
//! a body schema still read it.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, Method, Uri};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use platform::auth::resolve_access;
use platform::db::DataContext;
use platform::error::{json_reply, ApiError};
use platform::http::Platform;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::body::{parse_query, read_body, validated, BODY_LIMIT};
use crate::jobs;
use crate::model::{preferences_json, Task, TaskTag};
use crate::parse::{self, optional_string, require_object, required_string};
use crate::repo::{self, Quadrant};
use crate::schema::Schema;
use crate::schemas;

/// The platform's sign-in and runtime roles. Every handler signs the request in through the
/// platform and reads through a data context on the app role.
#[derive(Clone)]
pub struct AppState {
    pub platform: Arc<Platform>,
}

type Reply = Result<Response, ApiError>;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/preferences", get(get_preferences).patch(update_preferences))
        .route("/api/tasks/focus", get(focus))
        .route("/api/tasks/at-risk", get(at_risk))
        .route("/api/tasks/overdue", get(overdue))
        .route("/api/tasks/lists", get(list_lists).post(create_list))
        .route("/api/tasks/lists/{list_id}", axum::routing::patch(rename_list).delete(delete_list))
        .route("/api/tasks/lists/{list_id}/tags", get(list_tags).post(create_tag))
        .route(
            "/api/tasks/lists/{list_id}/tags/{tag_id}",
            axum::routing::patch(rename_tag).delete(delete_tag),
        )
        .route("/api/tasks/{id}", get(get_task).patch(update_task))
        .route("/api/tasks/{id}/subtasks", get(list_subtasks))
        .route("/api/tasks/{id}/tags", axum::routing::post(assign_tag))
        .route("/api/tasks/{id}/tags/{tag_id}", axum::routing::delete(unassign_tag))
        .route("/api/tasks/{id}/activity", get(list_activity).post(add_activity))
        .route("/api/tasks/{id}/deferred-status", axum::routing::post(deferred_status))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(DefaultBodyLimit::max(BODY_LIMIT * 2))
        .with_state(state)
}

/// Fastify's default reply for a request no route matches. It answers 404 for a known path
/// with an unknown method too.
async fn not_found(method: Method, uri: Uri) -> Response {
    let url = uri.path_and_query().map(|value| value.as_str()).unwrap_or("/");
    json_reply(
        404,
        &json!({
            "message": format!("Route {method}:{url} not found"),
            "error": "Not Found",
            "statusCode": 404,
        }),
    )
}

/// The body as the handler sees it after Fastify's parser and schema check.
fn request_body(
    method: &Method,
    headers: &HeaderMap,
    bytes: &[u8],
    schema: Option<Schema>,
) -> Result<Value, ApiError> {
    validated(read_body(method, headers, bytes)?, schema.as_ref())
}

fn ok(body: Value) -> Reply {
    Ok(json_reply(200, &body))
}

fn task_not_found() -> Reply {
    Ok(json_reply(404, &json!({ "error": "Task not found" })))
}

async fn tasks_json(cx: &DataContext, tasks: &[Task]) -> Result<Vec<Value>, ApiError> {
    let tags: HashMap<Uuid, Vec<TaskTag>> = repo::tags_for_tasks(cx, tasks).await?;
    Ok(tasks
        .iter()
        .map(|task| task.to_json(tags.get(&task.id).map(Vec::as_slice).unwrap_or(&[])))
        .collect())
}

/// One task and its tags, read in the same data context as the change before it.
async fn task_with_tags(cx: &DataContext, task: Option<Task>) -> Result<Option<Value>, ApiError> {
    match task {
        None => Ok(None),
        Some(task) => {
            let tags = repo::tags_for_task(cx, task.id).await?;
            Ok(Some(task.to_json(&tags)))
        }
    }
}

// --- Tasks ---

async fn list_tasks(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let query = parse_query(query.as_deref());
    let quadrant = optional_string(query.get("quadrant"), "quadrant")?;
    let tag_id = optional_string(query.get("tagId"), "tagId")?;
    let quadrant = match quadrant.as_deref() {
        None => None,
        Some(text) => Some(Quadrant::parse(text).ok_or_else(|| {
            ApiError::http(400, "quadrant must be do, schedule, delegate, or eliminate")
        })?),
    };
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tasks = repo::list_filtered(&cx, tag_id.as_deref(), quadrant).await?;
    let tasks = tasks_json(&cx, &tasks).await?;
    cx.commit().await?;
    ok(json!({ "tasks": tasks }))
}

async fn create_task(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::create_task()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let input = parse::parse_create_task(&body)?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let task = repo::create(&cx, &input).await?;
    let task = task_with_tags(&cx, Some(task)).await?;
    cx.commit().await?;
    Ok(json_reply(201, &json!({ "task": task })))
}

async fn get_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let task = repo::get_by_id(&cx, &id).await?;
    let task = task_with_tags(&cx, task).await?;
    cx.commit().await?;
    match task {
        None => task_not_found(),
        Some(task) => ok(json!({ "task": task })),
    }
}

async fn update_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::update_task()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let input = parse::parse_update_task(&body)?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let prior = repo::get_by_id(&cx, &id).await?;
    let task = match prior {
        Some(_) => repo::update(&cx, &id, &input).await?,
        None => None,
    };
    let task = task_with_tags(&cx, task).await?;
    cx.commit().await?;
    match task {
        None => task_not_found(),
        Some(task) => ok(json!({ "task": task })),
    }
}

async fn list_subtasks(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tasks = repo::list_by_parent(&cx, &id).await?;
    let tasks = tasks_json(&cx, &tasks).await?;
    cx.commit().await?;
    ok(json!({ "tasks": tasks }))
}

async fn assign_tag(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::assign_tag()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let tag_id = required_string(require_object(&body)?.get("tagId"), "tagId")?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    repo::assign_tag(&cx, &id, &tag_id).await?;
    let task = repo::get_by_id(&cx, &id).await?;
    let task = task_with_tags(&cx, task).await?;
    cx.commit().await?;
    match task {
        None => task_not_found(),
        Some(task) => ok(json!({ "task": task })),
    }
}

async fn unassign_tag(
    State(state): State<AppState>,
    Path((id, tag_id)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    repo::unassign_tag(&cx, &id, &tag_id).await?;
    let task = repo::get_by_id(&cx, &id).await?;
    let task = task_with_tags(&cx, task).await?;
    cx.commit().await?;
    match task {
        None => task_not_found(),
        Some(task) => ok(json!({ "task": task })),
    }
}

async fn list_activity(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let activity = repo::list_activity(&cx, &id).await?;
    cx.commit().await?;
    let activity: Vec<Value> = activity.iter().map(|entry| entry.to_json()).collect();
    ok(json!({ "activity": activity }))
}

async fn add_activity(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::add_activity()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let input = parse::parse_activity(&body)?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let activity =
        repo::add_activity(&cx, &id, &input.activity_type, input.body.as_deref()).await?;
    cx.commit().await?;
    Ok(json_reply(201, &json!({ "activity": activity.to_json() })))
}

/// Checks the task is visible to the actor, then queues the status change for the worker in
/// the same transaction, so the job exists only if the check commits.
async fn deferred_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::deferred_status()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let input = parse::parse_deferred_status(&body)?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let Some(task) = repo::get_by_id(&cx, &id).await? else {
        return task_not_found();
    };
    let request = jobs::DeferredStatus {
        task_id: task.id,
        status: input.status,
        idempotency_key: input.idempotency_key,
    };
    let job_id = jobs::send(&cx, &request).await?;
    cx.commit().await?;
    Ok(json_reply(202, &json!({ "jobId": job_id })))
}

// --- Preferences ---

async fn get_preferences(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let row = repo::get_or_create_preferences(&cx).await?;
    cx.commit().await?;
    ok(json!({ "preferences": preferences_json(&row) }))
}

async fn update_preferences(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::update_preferences()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let default_view = match require_object(&body)?.get("defaultView") {
        Some(Value::String(view)) if view == "priority" || view == "matrix" => view.clone(),
        _ => return Err(ApiError::http(400, "defaultView must be priority or matrix")),
    };
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let row = repo::update_preferences(&cx, &default_view).await?;
    cx.commit().await?;
    ok(json!({ "preferences": preferences_json(&row) }))
}

// --- Lists ---

/// The TypeScript route also probes for recurring series here to repair the recurrence
/// schedule. Recurrence is outside this spike, and the probe never changes the reply.
async fn list_lists(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let lists = repo::list_lists(&cx).await?;
    cx.commit().await?;
    let lists: Vec<Value> = lists.iter().map(|list| list.to_json()).collect();
    ok(json!({ "lists": lists }))
}

async fn create_list(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::name_only()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let name = required_string(require_object(&body)?.get("name"), "name")?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let list = repo::get_or_create_list(&cx, &name).await?;
    cx.commit().await?;
    Ok(json_reply(201, &json!({ "list": list.to_json() })))
}

async fn rename_list(
    State(state): State<AppState>,
    Path(list_id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::name_only()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let name = required_string(require_object(&body)?.get("name"), "name")?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let list = repo::rename_list(&cx, &list_id, &name).await?;
    cx.commit().await?;
    ok(json!({ "list": list.to_json() }))
}

async fn delete_list(
    State(state): State<AppState>,
    Path(list_id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::delete_list()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let reassign_to =
        optional_string(require_object(&body)?.get("reassignToListId"), "reassignToListId")?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    repo::delete_list(&cx, &list_id, reassign_to.as_deref()).await?;
    cx.commit().await?;
    ok(json!({ "deleted": true }))
}

// --- Tags ---

async fn list_tags(
    State(state): State<AppState>,
    Path(list_id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tags = repo::list_tags(&cx, &list_id).await?;
    cx.commit().await?;
    let tags: Vec<Value> = tags.iter().map(TaskTag::to_json).collect();
    ok(json!({ "tags": tags }))
}

async fn create_tag(
    State(state): State<AppState>,
    Path(list_id): Path<String>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::name_only()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let name = required_string(require_object(&body)?.get("name"), "name")?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tag = repo::create_tag(&cx, &list_id, &name).await?;
    cx.commit().await?;
    Ok(json_reply(201, &json!({ "tag": tag.to_json() })))
}

async fn rename_tag(
    State(state): State<AppState>,
    Path((list_id, tag_id)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    let body = request_body(&method, &headers, &bytes, Some(schemas::name_only()))?;
    let access = resolve_access(&state.platform, &headers).await?;
    let name = required_string(require_object(&body)?.get("name"), "name")?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tag = repo::rename_tag(&cx, &list_id, &tag_id, &name).await?;
    cx.commit().await?;
    ok(json!({ "tag": tag.to_json() }))
}

async fn delete_tag(
    State(state): State<AppState>,
    Path((list_id, tag_id)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    repo::delete_tag(&cx, &list_id, &tag_id).await?;
    cx.commit().await?;
    ok(json!({ "deleted": true }))
}

// --- Drift views ---

/// Focus signals come from other modules, which this spike does not run, so the list is empty.
async fn focus(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tasks = repo::focus(&cx).await?;
    let tasks = tasks_json(&cx, &tasks).await?;
    cx.commit().await?;
    ok(json!({ "tasks": tasks, "signals": [] }))
}

async fn at_risk(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tasks = repo::at_risk(&cx).await?;
    let tasks = tasks_json(&cx, &tasks).await?;
    cx.commit().await?;
    ok(json!({ "tasks": tasks }))
}

async fn overdue(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Reply {
    request_body(&method, &headers, &bytes, None)?;
    let access = resolve_access(&state.platform, &headers).await?;
    let cx = DataContext::open(&state.platform.app, &access).await?;
    let tasks = repo::overdue(&cx).await?;
    let tasks = tasks_json(&cx, &tasks).await?;
    cx.commit().await?;
    ok(json!({ "tasks": tasks }))
}
