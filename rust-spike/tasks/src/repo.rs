//! Tasks data access, ported from `repository.ts`, `lists.ts`, `preferences.ts` and `drift.ts`.
//!
//! Every function takes a [`DataContext`], so every statement runs under RLS as the actor.
//! Request ids stay text and are cast in SQL (`$n::text::uuid`), so a malformed id fails in
//! Postgres where the TypeScript query fails. Statement order follows the TypeScript code,
//! because it decides which error a request sees first.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use tokio_postgres::types::ToSql;
use tokio_postgres::Row;
use uuid::Uuid;

use crate::dates::js_now;
use crate::model::{Task, TaskActivity, TaskList, TaskStatus, TaskTag, TASK_COLUMNS};
use crate::parse::{Patch, TaskFields};
use safety_core::db::DataContext;
use safety_core::error::ApiError;

const URGENCY_WINDOW_HOURS: i64 = 48;
const IMPORTANT_PRIORITY_MIN: i16 = 4;
const AT_RISK_DUE_WINDOW_DAYS: i32 = 2;
const DEFAULT_TIMEZONE: &str = "America/Los_Angeles";

type Param = Box<dyn ToSql + Sync + Send>;

fn refs(params: &[Param]) -> Vec<&(dyn ToSql + Sync)> {
    params
        .iter()
        .map(|param| param.as_ref() as &(dyn ToSql + Sync))
        .collect()
}

fn tasks(rows: Vec<Row>) -> Vec<Task> {
    rows.iter().map(Task::from_row).collect()
}

// --- Tasks ---

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quadrant {
    Do,
    Schedule,
    Delegate,
    Eliminate,
}

impl Quadrant {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "do" => Some(Quadrant::Do),
            "schedule" => Some(Quadrant::Schedule),
            "delegate" => Some(Quadrant::Delegate),
            "eliminate" => Some(Quadrant::Eliminate),
            _ => None,
        }
    }

    /// `(important, urgent)`, from `TASK_QUADRANT_AXES`.
    fn axes(self) -> (bool, bool) {
        match self {
            Quadrant::Do => (true, true),
            Quadrant::Schedule => (true, false),
            Quadrant::Delegate => (false, true),
            Quadrant::Eliminate => (false, false),
        }
    }
}

pub async fn list_filtered(
    cx: &DataContext,
    tag_id: Option<&str>,
    quadrant: Option<Quadrant>,
) -> Result<Vec<Task>, ApiError> {
    let mut conditions = Vec::new();
    let mut params: Vec<Param> = Vec::new();
    if let Some(tag_id) = tag_id {
        params.push(Box::new(tag_id.to_owned()));
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM app.task_tag_assignments a \
             WHERE a.task_id = t.id AND a.tag_id = ${}::text::uuid)",
            params.len()
        ));
    }
    if let Some(quadrant) = quadrant {
        let (important, urgent) = quadrant.axes();
        conditions.push(if important {
            format!("t.priority IS NOT NULL AND t.priority >= {IMPORTANT_PRIORITY_MIN}")
        } else {
            format!("(t.priority IS NULL OR t.priority < {IMPORTANT_PRIORITY_MIN})")
        });
        params.push(Box::new(js_now() + Duration::hours(URGENCY_WINDOW_HOURS)));
        let n = params.len();
        conditions.push(if urgent {
            format!("t.due_at IS NOT NULL AND t.due_at <= ${n}")
        } else {
            format!("(t.due_at IS NULL OR t.due_at > ${n})")
        });
    }
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql =
        format!("SELECT {TASK_COLUMNS} FROM app.tasks t {filter} ORDER BY t.updated_at DESC, t.id");
    Ok(tasks(cx.db().query(sql.as_str(), &refs(&params)).await?))
}

pub async fn get_by_id(cx: &DataContext, task_id: &str) -> Result<Option<Task>, ApiError> {
    let sql = format!("SELECT {TASK_COLUMNS} FROM app.tasks t WHERE t.id = $1::text::uuid");
    let row = cx.db().query_opt(sql.as_str(), &[&task_id]).await?;
    Ok(row.as_ref().map(Task::from_row))
}

async fn owned_task_exists(cx: &DataContext, task_id: &str) -> Result<bool, ApiError> {
    let row = cx
        .db()
        .query_opt(
            "SELECT id FROM app.tasks \
             WHERE id = $1::text::uuid AND owner_user_id = app.current_actor_user_id()",
            &[&task_id],
        )
        .await?;
    Ok(row.is_some())
}

pub async fn create(cx: &DataContext, input: &TaskFields) -> Result<Task, ApiError> {
    if let Some(list_id) = &input.list_id {
        if !list_is_owned(cx, list_id).await? {
            return Err(ApiError::http(404, "List not found or not accessible"));
        }
    }
    if let Patch::Set(parent_id) = &input.parent_task_id {
        if !owned_task_exists(cx, parent_id).await? {
            return Err(ApiError::http(
                404,
                "Parent task not found or not accessible",
            ));
        }
    }
    let list_id = match &input.list_id {
        Some(list_id) => list_id.clone(),
        None => get_or_create_list(cx, "Personal").await?.id.to_string(),
    };
    let now = js_now();
    let status = input.status.unwrap_or(TaskStatus::Todo);
    let completed_at = (status == TaskStatus::Done).then_some(now);
    let (recurrence, series_id) = match &input.recurrence {
        Patch::Set(spec) => (Some(spec.to_json()), Some(Uuid::new_v4())),
        Patch::Keep | Patch::Clear => (None, None),
    };
    let parent_task_id = patch_value(&input.parent_task_id);
    let sql = format!(
        "INSERT INTO app.tasks AS t (id, owner_user_id, list_id, parent_task_id, title, \
             description, status, priority, position, due_at, do_at, effort, source, source_ref, \
             external_key, recurrence, recurrence_series_id, completed_at, created_at, updated_at) \
         VALUES ($1, app.current_actor_user_id(), $2::text::uuid, $3::text::uuid, $4, $5, \
             $6::text::app.task_status, $7, 0, $8, $9, $10, 'manual', NULL, NULL, $11, $12, $13, \
             $14, $14) \
         RETURNING {TASK_COLUMNS}"
    );
    let row = cx
        .db()
        .query_one(
            sql.as_str(),
            &[
                &Uuid::new_v4(),
                &list_id,
                &parent_task_id,
                &input.title.as_deref().unwrap_or_default(),
                &patch_value(&input.description),
                &status.as_str(),
                &patch_value(&input.priority),
                &patch_value(&input.due_at),
                &patch_value(&input.do_at),
                &patch_value(&input.effort),
                &recurrence,
                &series_id,
                &completed_at,
                &now,
            ],
        )
        .await?;
    Ok(Task::from_row(&row))
}

/// `value ?? null` for a field the request may leave out.
fn patch_value<T: Clone>(patch: &Patch<T>) -> Option<T> {
    match patch {
        Patch::Set(value) => Some(value.clone()),
        Patch::Keep | Patch::Clear => None,
    }
}

/// Collects `SET` assignments with numbered parameters.
struct Assignments {
    columns: Vec<String>,
    params: Vec<Param>,
}

impl Assignments {
    fn new() -> Self {
        Self {
            columns: Vec::new(),
            params: Vec::new(),
        }
    }

    fn set(&mut self, column: &str, value: impl ToSql + Sync + Send + 'static, cast: &str) {
        self.params.push(Box::new(value));
        self.columns
            .push(format!("{column} = ${}{cast}", self.params.len()));
    }

    fn set_patch<T>(&mut self, column: &str, patch: &Patch<T>, cast: &str)
    where
        T: ToSql + Sync + Send + Clone + 'static,
    {
        match patch {
            Patch::Keep => {}
            Patch::Clear => self.set(column, None::<T>, cast),
            Patch::Set(value) => self.set(column, Some(value.clone()), cast),
        }
    }
}

pub async fn update(
    cx: &DataContext,
    task_id: &str,
    input: &TaskFields,
) -> Result<Option<Task>, ApiError> {
    if let Some(list_id) = &input.list_id {
        if !list_is_owned(cx, list_id).await? {
            return Err(ApiError::http(404, "List not found or not accessible"));
        }
    }
    if let Patch::Set(parent_id) = &input.parent_task_id {
        if !owned_task_exists(cx, parent_id).await? {
            return Err(ApiError::http(
                404,
                "Parent task not found or not accessible",
            ));
        }
    }

    let updated_at = js_now();
    let mut set = Assignments::new();
    set.set("updated_at", updated_at, "");
    if let Some(title) = &input.title {
        set.set("title", title.clone(), "");
    }
    set.set_patch("description", &input.description, "");
    set.set_patch("priority", &input.priority, "");
    set.set_patch("due_at", &input.due_at, "");
    set.set_patch("do_at", &input.do_at, "");
    set.set_patch("effort", &input.effort, "");
    if let Some(list_id) = &input.list_id {
        set.set("list_id", list_id.clone(), "::text::uuid");
    }
    set.set_patch("parent_task_id", &input.parent_task_id, "::text::uuid");
    if let Some(status) = input.status {
        set.set(
            "status",
            status.as_str().to_owned(),
            "::text::app.task_status",
        );
        set.set(
            "completed_at",
            (status == TaskStatus::Done).then(js_now),
            "",
        );
    }
    match &input.recurrence {
        Patch::Keep => {}
        Patch::Clear => {
            set.set("recurrence", None::<Value>, "");
            set.set("recurrence_series_id", None::<Uuid>, "");
        }
        Patch::Set(spec) => {
            let current = cx
                .db()
                .query_opt(
                    "SELECT recurrence_series_id FROM app.tasks WHERE id = $1::text::uuid",
                    &[&task_id],
                )
                .await?;
            let series_id: Option<Uuid> = current.and_then(|row| row.get(0));
            set.set("recurrence", spec.to_json(), "");
            set.set(
                "recurrence_series_id",
                series_id.unwrap_or_else(Uuid::new_v4),
                "",
            );
        }
    }

    if let Some(list_id) = &input.list_id {
        cx.db()
            .execute(
                "DELETE FROM app.task_tag_assignments WHERE task_id = $1::text::uuid \
                 AND tag_id NOT IN (SELECT id FROM app.task_tags WHERE list_id = $2::text::uuid)",
                &[&task_id, list_id],
            )
            .await?;
        let stored = cx
            .db()
            .query_opt(
                "SELECT list_id FROM app.tasks WHERE id = $1::text::uuid",
                &[&task_id],
            )
            .await?;
        let moved = stored.is_some_and(|row| row.get::<_, Uuid>(0).to_string() != *list_id);
        let children: Vec<Uuid> = if moved {
            cx.db()
                .query(
                    "SELECT id FROM app.tasks WHERE parent_task_id = $1::text::uuid",
                    &[&task_id],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect()
        } else {
            Vec::new()
        };
        if !children.is_empty() {
            cx.db()
                .execute(
                    "DELETE FROM app.task_tag_assignments WHERE task_id = ANY($1) AND tag_id \
                     NOT IN (SELECT id FROM app.task_tags WHERE list_id = $2::text::uuid)",
                    &[&children, list_id],
                )
                .await?;
            cx.db()
                .execute(
                    "UPDATE app.tasks SET list_id = $1::text::uuid, updated_at = $2 \
                     WHERE id = ANY($3)",
                    &[list_id, &updated_at, &children],
                )
                .await?;
        }
    }

    set.params.push(Box::new(task_id.to_owned()));
    let sql = format!(
        "UPDATE app.tasks AS t SET {} WHERE t.id = ${}::text::uuid RETURNING {TASK_COLUMNS}",
        set.columns.join(", "),
        set.params.len()
    );
    let Some(row) = cx.db().query_opt(sql.as_str(), &refs(&set.params)).await? else {
        return Ok(None);
    };
    let updated = Task::from_row(&row);

    if let Some(status) = input.status {
        if matches!(status, TaskStatus::Done | TaskStatus::Archived)
            && updated.parent_task_id.is_none()
        {
            cascade_close_children(cx, task_id, status).await?;
        }
        if status == TaskStatus::Done {
            if let Some(parent_id) = updated.parent_task_id {
                maybe_auto_close_parent(cx, parent_id).await?;
            }
        }
    }
    Ok(Some(updated))
}

async fn cascade_close_children(
    cx: &DataContext,
    parent_id: &str,
    status: TaskStatus,
) -> Result<(), ApiError> {
    let open_children = cx
        .db()
        .query(
            "SELECT id FROM app.tasks WHERE parent_task_id = $1::text::uuid \
             AND status <> $2::text::app.task_status AND status <> 'suggested'",
            &[&parent_id, &status.as_str()],
        )
        .await?;
    if open_children.is_empty() {
        return Ok(());
    }
    let now = js_now();
    let completed_at = (status == TaskStatus::Done).then_some(now);
    let body = format!("Cascaded to {} when parent was closed", status.as_str());
    for child in &open_children {
        let child_id: Uuid = child.get(0);
        cx.db()
            .execute(
                "UPDATE app.tasks SET status = $1::text::app.task_status, completed_at = $2, \
                 updated_at = $3 WHERE id = $4",
                &[&status.as_str(), &completed_at, &now, &child_id],
            )
            .await?;
        add_activity(cx, &child_id.to_string(), "status_changed", Some(&body)).await?;
    }
    Ok(())
}

async fn maybe_auto_close_parent(cx: &DataContext, parent_id: Uuid) -> Result<(), ApiError> {
    let siblings = cx
        .db()
        .query(
            "SELECT id, status::text FROM app.tasks WHERE parent_task_id = $1",
            &[&parent_id],
        )
        .await?;
    if siblings.is_empty() || !siblings.iter().all(|row| row.get::<_, String>(1) == "done") {
        return Ok(());
    }
    let now = js_now();
    cx.db()
        .execute(
            "UPDATE app.tasks SET status = 'done', completed_at = $1, updated_at = $1 \
             WHERE id = $2 AND status <> 'done'",
            &[&now, &parent_id],
        )
        .await?;
    add_activity(
        cx,
        &parent_id.to_string(),
        "completed",
        Some("All subtasks completed \u{2014} parent auto-closed"),
    )
    .await?;
    Ok(())
}

pub async fn add_activity(
    cx: &DataContext,
    task_id: &str,
    activity_type: &str,
    body: Option<&str>,
) -> Result<TaskActivity, ApiError> {
    let row = cx
        .db()
        .query_one(
            "INSERT INTO app.task_activity \
                 (id, task_id, actor_user_id, actor_kind, activity_type, body, created_at) \
             VALUES ($1, $2::text::uuid, app.current_actor_user_id(), 'user', $3, $4, $5) \
             RETURNING *",
            &[&Uuid::new_v4(), &task_id, &activity_type, &body, &js_now()],
        )
        .await?;
    Ok(TaskActivity::from_row(&row))
}

pub async fn list_activity(cx: &DataContext, task_id: &str) -> Result<Vec<TaskActivity>, ApiError> {
    let rows = cx
        .db()
        .query(
            "SELECT * FROM app.task_activity WHERE task_id = $1::text::uuid ORDER BY created_at, id",
            &[&task_id],
        )
        .await?;
    Ok(rows.iter().map(TaskActivity::from_row).collect())
}

pub async fn list_by_parent(cx: &DataContext, parent_id: &str) -> Result<Vec<Task>, ApiError> {
    let sql = format!(
        "SELECT {TASK_COLUMNS} FROM app.tasks t WHERE t.parent_task_id = $1::text::uuid \
         ORDER BY t.position ASC, t.id"
    );
    Ok(tasks(cx.db().query(sql.as_str(), &[&parent_id]).await?))
}

pub async fn tags_for_task(cx: &DataContext, task_id: Uuid) -> Result<Vec<TaskTag>, ApiError> {
    let rows = cx
        .db()
        .query(
            "SELECT g.* FROM app.task_tag_assignments a JOIN app.task_tags g ON g.id = a.tag_id \
             WHERE a.task_id = $1 ORDER BY g.name",
            &[&task_id],
        )
        .await?;
    Ok(rows.iter().map(TaskTag::from_row).collect())
}

pub async fn tags_for_tasks(
    cx: &DataContext,
    tasks: &[Task],
) -> Result<HashMap<Uuid, Vec<TaskTag>>, ApiError> {
    let mut map: HashMap<Uuid, Vec<TaskTag>> = HashMap::new();
    if tasks.is_empty() {
        return Ok(map);
    }
    let ids: Vec<Uuid> = tasks.iter().map(|task| task.id).collect();
    let rows = cx
        .db()
        .query(
            "SELECT a.task_id, g.* FROM app.task_tag_assignments a \
             JOIN app.task_tags g ON g.id = a.tag_id WHERE a.task_id = ANY($1) ORDER BY g.name",
            &[&ids],
        )
        .await?;
    for row in &rows {
        map.entry(row.get("task_id"))
            .or_default()
            .push(TaskTag::from_row(row));
    }
    Ok(map)
}

// --- Lists and tags ---

pub async fn get_or_create_list(cx: &DataContext, name: &str) -> Result<TaskList, ApiError> {
    const SELECT: &str = "SELECT * FROM app.task_lists WHERE lower(name) = lower($1)";
    if let Some(row) = cx.db().query_opt(SELECT, &[&name]).await? {
        return Ok(TaskList::from_row(&row));
    }
    let inserted = cx
        .db()
        .query_opt(
            "INSERT INTO app.task_lists (id, owner_user_id, name, position) \
             VALUES ($1, app.current_actor_user_id(), $2, 0) ON CONFLICT DO NOTHING RETURNING *",
            &[&Uuid::new_v4(), &name],
        )
        .await?;
    if let Some(row) = inserted {
        return Ok(TaskList::from_row(&row));
    }
    let row = cx.db().query_one(SELECT, &[&name]).await?;
    Ok(TaskList::from_row(&row))
}

pub async fn list_lists(cx: &DataContext) -> Result<Vec<TaskList>, ApiError> {
    let rows = cx
        .db()
        .query("SELECT * FROM app.task_lists ORDER BY position, name", &[])
        .await?;
    Ok(rows.iter().map(TaskList::from_row).collect())
}

/// RLS on `task_lists` is owner-only, so a visible row is an owned row.
pub async fn list_is_owned(cx: &DataContext, list_id: &str) -> Result<bool, ApiError> {
    let row = cx
        .db()
        .query_opt(
            "SELECT id FROM app.task_lists WHERE id = $1::text::uuid",
            &[&list_id],
        )
        .await?;
    Ok(row.is_some())
}

pub async fn rename_list(
    cx: &DataContext,
    list_id: &str,
    name: &str,
) -> Result<TaskList, ApiError> {
    let result = cx
        .db()
        .query_opt(
            "UPDATE app.task_lists SET name = $1, updated_at = $2 WHERE id = $3::text::uuid \
             RETURNING *",
            &[&name, &js_now(), &list_id],
        )
        .await;
    match result {
        Ok(Some(row)) => Ok(TaskList::from_row(&row)),
        Ok(None) => Err(ApiError::http(404, "List not found or not accessible")),
        Err(error) => {
            let error = ApiError::from(error);
            if error.db_message_contains(&["task_lists_owner_name_idx", "unique"]) {
                return Err(ApiError::http(409, "A list with that name already exists"));
            }
            Err(error)
        }
    }
}

pub async fn delete_list(
    cx: &DataContext,
    list_id: &str,
    reassign_to: Option<&str>,
) -> Result<(), ApiError> {
    cx.db()
        .execute(
            "SELECT pg_advisory_xact_lock(hashtext('tasks:list-delete:' || app.current_actor_user_id()))",
            &[],
        )
        .await?;
    let all = cx.db().query("SELECT id FROM app.task_lists", &[]).await?;
    if !all
        .iter()
        .any(|row| row.get::<_, Uuid>(0).to_string() == list_id)
    {
        return Err(ApiError::http(404, "List not found or not accessible"));
    }
    if reassign_to == Some(list_id) {
        return Err(ApiError::http(
            400,
            "Cannot reassign a list's tasks to itself",
        ));
    }
    if all.len() <= 1 {
        return Err(ApiError::http(409, "Cannot delete your only list"));
    }
    if let Some(destination) = reassign_to {
        if !list_is_owned(cx, destination).await? {
            return Err(ApiError::http(
                404,
                "Destination list not found or not accessible",
            ));
        }
        cx.db()
            .execute(
                "DELETE FROM app.task_tag_assignments \
                 WHERE task_id IN (SELECT id FROM app.tasks WHERE list_id = $1::text::uuid) \
                 AND tag_id NOT IN (SELECT id FROM app.task_tags WHERE list_id = $2::text::uuid)",
                &[&list_id, &destination],
            )
            .await?;
        cx.db()
            .execute(
                "UPDATE app.tasks SET list_id = $1::text::uuid, updated_at = $2 \
                 WHERE list_id = $3::text::uuid",
                &[&destination, &js_now(), &list_id],
            )
            .await?;
    }
    let result = cx
        .db()
        .query_opt(
            "DELETE FROM app.task_lists WHERE id = $1::text::uuid RETURNING id",
            &[&list_id],
        )
        .await;
    match result {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(ApiError::http(404, "List not found or not accessible")),
        Err(error) => {
            let error = ApiError::from(error);
            if error.db_message_contains(&["foreign key", "violates"]) {
                return Err(ApiError::http(409, "List is not empty"));
            }
            Err(error)
        }
    }
}

pub async fn create_tag(cx: &DataContext, list_id: &str, name: &str) -> Result<TaskTag, ApiError> {
    let row = cx
        .db()
        .query_one(
            "INSERT INTO app.task_tags (id, owner_user_id, list_id, name) \
             VALUES ($1, app.current_actor_user_id(), $2::text::uuid, $3) RETURNING *",
            &[&Uuid::new_v4(), &list_id, &name],
        )
        .await?;
    Ok(TaskTag::from_row(&row))
}

pub async fn list_tags(cx: &DataContext, list_id: &str) -> Result<Vec<TaskTag>, ApiError> {
    let rows = cx
        .db()
        .query(
            "SELECT * FROM app.task_tags WHERE list_id = $1::text::uuid ORDER BY name",
            &[&list_id],
        )
        .await?;
    Ok(rows.iter().map(TaskTag::from_row).collect())
}

pub async fn rename_tag(
    cx: &DataContext,
    list_id: &str,
    tag_id: &str,
    name: &str,
) -> Result<TaskTag, ApiError> {
    let result = cx
        .db()
        .query_opt(
            "UPDATE app.task_tags SET name = $1 \
             WHERE id = $2::text::uuid AND list_id = $3::text::uuid RETURNING *",
            &[&name, &tag_id, &list_id],
        )
        .await;
    match result {
        Ok(Some(row)) => Ok(TaskTag::from_row(&row)),
        Ok(None) => Err(ApiError::http(404, "Tag not found or not accessible")),
        Err(error) => {
            let error = ApiError::from(error);
            if error.db_message_contains(&["task_tags_list_name_idx", "unique"]) {
                return Err(ApiError::http(
                    409,
                    "A tag with that name already exists in this list",
                ));
            }
            Err(error)
        }
    }
}

pub async fn delete_tag(cx: &DataContext, list_id: &str, tag_id: &str) -> Result<(), ApiError> {
    let row = cx
        .db()
        .query_opt(
            "DELETE FROM app.task_tags WHERE id = $1::text::uuid AND list_id = $2::text::uuid \
             RETURNING id",
            &[&tag_id, &list_id],
        )
        .await?;
    row.map(|_| ())
        .ok_or_else(|| ApiError::http(404, "Tag not found or not accessible"))
}

pub async fn assign_tag(cx: &DataContext, task_id: &str, tag_id: &str) -> Result<(), ApiError> {
    if !owned_task_exists(cx, task_id).await? {
        return Err(ApiError::http(404, "Task not found or not accessible"));
    }
    let tag = cx
        .db()
        .query_opt(
            "SELECT id FROM app.task_tags \
             WHERE id = $1::text::uuid AND owner_user_id = app.current_actor_user_id()",
            &[&tag_id],
        )
        .await?;
    if tag.is_none() {
        return Err(ApiError::http(404, "Tag not found or not accessible"));
    }
    let result = cx
        .db()
        .execute(
            "INSERT INTO app.task_tag_assignments (task_id, tag_id) \
             VALUES ($1::text::uuid, $2::text::uuid) ON CONFLICT DO NOTHING",
            &[&task_id, &tag_id],
        )
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(error) => {
            let error = ApiError::from(error);
            if error.db_message_contains(&["tag must belong to the task"]) {
                return Err(ApiError::http(400, "tag must belong to the task's list"));
            }
            Err(error)
        }
    }
}

pub async fn unassign_tag(cx: &DataContext, task_id: &str, tag_id: &str) -> Result<(), ApiError> {
    if !owned_task_exists(cx, task_id).await? {
        return Err(ApiError::http(404, "Task not found or not accessible"));
    }
    cx.db()
        .execute(
            "DELETE FROM app.task_tag_assignments \
             WHERE task_id = $1::text::uuid AND tag_id = $2::text::uuid",
            &[&task_id, &tag_id],
        )
        .await?;
    Ok(())
}

// --- Preferences ---

pub async fn get_or_create_preferences(cx: &DataContext) -> Result<Row, ApiError> {
    const SELECT: &str = "SELECT * FROM app.task_preferences";
    if let Some(row) = cx.db().query(SELECT, &[]).await?.into_iter().next() {
        return Ok(row);
    }
    let inserted = cx
        .db()
        .query_opt(
            "INSERT INTO app.task_preferences (owner_user_id, default_view) \
             VALUES (app.current_actor_user_id(), 'priority') ON CONFLICT DO NOTHING RETURNING *",
            &[],
        )
        .await?;
    if let Some(row) = inserted {
        return Ok(row);
    }
    let row = cx.db().query(SELECT, &[]).await?.into_iter().next();
    row.ok_or_else(|| ApiError::Internal("no result: task_preferences".into()))
}

pub async fn update_preferences(cx: &DataContext, default_view: &str) -> Result<Row, ApiError> {
    get_or_create_preferences(cx).await?;
    let rows = cx
        .db()
        .query(
            "UPDATE app.task_preferences SET default_view = $1, updated_at = $2 RETURNING *",
            &[&default_view, &js_now()],
        )
        .await?;
    rows.into_iter()
        .next()
        .ok_or_else(|| ApiError::Internal("no result: task_preferences".into()))
}

// --- Drift: overdue, at risk, focus ---

/// `readActorTimezone`: the `locale` preference's `timezone`, when the runtime knows it.
pub async fn actor_timezone(cx: &DataContext) -> Result<String, ApiError> {
    let row = cx
        .db()
        .query(
            "SELECT value_json FROM app.preferences WHERE key = 'locale'",
            &[],
        )
        .await?
        .into_iter()
        .next();
    let raw: Option<Value> = row.and_then(|row| row.get(0));
    let timezone = raw
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|record| record.get("timezone"))
        .and_then(Value::as_str)
        .filter(|tz| !crate::parse::js_trim(tz).is_empty())
        .filter(|tz| chrono_tz::Tz::from_str_insensitive(tz).is_ok());
    Ok(timezone.unwrap_or(DEFAULT_TIMEZONE).to_owned())
}

async fn query_overdue(cx: &DataContext, tz: &str) -> Result<Vec<Task>, ApiError> {
    let sql = format!(
        "SELECT {TASK_COLUMNS} FROM app.tasks t WHERE t.status = 'todo' AND t.due_at IS NOT NULL \
         AND (t.due_at AT TIME ZONE $1::text)::date < (now() AT TIME ZONE $1::text)::date \
         ORDER BY t.due_at ASC"
    );
    Ok(tasks(cx.db().query(sql.as_str(), &[&tz]).await?))
}

async fn query_at_risk(cx: &DataContext, tz: &str) -> Result<Vec<Task>, ApiError> {
    let sql = format!(
        "SELECT {TASK_COLUMNS} FROM app.tasks t WHERE t.status = 'todo' AND t.priority >= 3 \
         AND ((t.due_at IS NOT NULL AND (t.due_at AT TIME ZONE $1::text)::date \
                 <= (now() AT TIME ZONE $1::text)::date + $2::int) \
              OR (t.do_at IS NOT NULL AND (t.do_at AT TIME ZONE $1::text)::date \
                 < (now() AT TIME ZONE $1::text)::date)) \
         AND NOT EXISTS (SELECT 1 FROM app.tasks child \
                         WHERE child.parent_task_id = t.id AND child.status = 'done') \
         ORDER BY t.priority DESC, t.due_at ASC"
    );
    Ok(tasks(
        cx.db()
            .query(sql.as_str(), &[&tz, &AT_RISK_DUE_WINDOW_DAYS])
            .await?,
    ))
}

pub async fn overdue(cx: &DataContext) -> Result<Vec<Task>, ApiError> {
    let tz = actor_timezone(cx).await?;
    query_overdue(cx, &tz).await
}

pub async fn at_risk(cx: &DataContext) -> Result<Vec<Task>, ApiError> {
    let tz = actor_timezone(cx).await?;
    query_at_risk(cx, &tz).await
}

pub async fn focus(cx: &DataContext) -> Result<Vec<Task>, ApiError> {
    let tz = actor_timezone(cx).await?;
    let overdue = query_overdue(cx, &tz).await?;
    let at_risk = query_at_risk(cx, &tz).await?;
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<Task> = overdue
        .into_iter()
        .chain(at_risk)
        .filter(|task| seen.insert(task.id))
        .collect();
    merged.sort_by(|a, b| {
        focus_order(a)
            .partial_cmp(&focus_order(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(merged)
}

/// The focus sort key: priority descending (none last), due ascending at millisecond
/// precision (none last), then effort quick, medium, large, other.
fn focus_order(task: &Task) -> (f64, f64, u8) {
    let priority = task.priority.map_or(f64::NEG_INFINITY, f64::from);
    let due = task.due_at.map_or(f64::INFINITY, |due| millis(due) as f64);
    let effort = match task.effort.as_deref() {
        Some("quick") => 0,
        Some("medium") => 1,
        Some("large") => 2,
        _ => 3,
    };
    (-priority, due, effort)
}

fn millis(value: DateTime<Utc>) -> i64 {
    value.timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(priority: Option<i16>, due_ms: Option<i64>, effort: Option<&str>) -> Task {
        let at = |ms: i64| DateTime::from_timestamp_millis(ms).unwrap();
        Task {
            id: Uuid::new_v4(),
            owner_user_id: Uuid::nil(),
            list_id: Uuid::nil(),
            parent_task_id: None,
            title: String::new(),
            description: None,
            status: "todo".into(),
            priority,
            position: 0,
            due_at: due_ms.map(at),
            do_at: None,
            effort: effort.map(str::to_owned),
            source: "manual".into(),
            source_ref: None,
            completed_at: None,
            created_at: at(0),
            updated_at: at(0),
            suggestion_metadata: None,
            recurrence: None,
        }
    }

    #[test]
    fn focus_order_matches_the_typescript_comparator() {
        let mut list = vec![
            task(None, Some(5), Some("quick")),
            task(Some(3), None, None),
            task(Some(3), Some(10), Some("large")),
            task(Some(3), Some(10), Some("quick")),
            task(Some(5), Some(99), None),
        ];
        list.sort_by(|a, b| focus_order(a).partial_cmp(&focus_order(b)).unwrap());
        let summary: Vec<_> = list
            .iter()
            .map(|t| (t.priority, t.due_at.map(millis), t.effort.clone()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (Some(5), Some(99), None),
                (Some(3), Some(10), Some("quick".into())),
                (Some(3), Some(10), Some("large".into())),
                (Some(3), None, None),
                (None, Some(5), Some("quick".into())),
            ]
        );
    }
}
