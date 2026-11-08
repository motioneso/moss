//! Rows read from the Tasks tables, and their JSON shape (`packages/tasks/src/serialize.ts`).

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::Row;
use uuid::Uuid;

use crate::dates::to_iso_string;
use crate::parse::parse_recurrence;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Todo,
    Done,
    Archived,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::Done => "done",
            TaskStatus::Archived => "archived",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recurrence {
    pub freq: String,
    pub interval: i64,
    pub occurrence_date: String,
}

impl Recurrence {
    pub fn to_json(&self) -> Value {
        json!({ "freq": self.freq, "interval": self.interval, "occurrence_date": self.occurrence_date })
    }
}

/// Column list every task query selects; `status` is an enum, read as text.
pub const TASK_COLUMNS: &str = "t.id, t.owner_user_id, t.list_id, t.parent_task_id, t.title, \
    t.description, t.status::text AS status, t.priority, t.position, t.due_at, t.do_at, t.effort, \
    t.source, t.source_ref, t.completed_at, t.created_at, t.updated_at, t.suggestion_metadata, \
    t.recurrence";

#[derive(Clone, Debug)]
pub struct Task {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub list_id: Uuid,
    pub parent_task_id: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: Option<i16>,
    pub position: i32,
    pub due_at: Option<DateTime<Utc>>,
    pub do_at: Option<DateTime<Utc>>,
    pub effort: Option<String>,
    pub source: String,
    pub source_ref: Option<String>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub suggestion_metadata: Option<Value>,
    pub recurrence: Option<Value>,
}

impl Task {
    pub fn from_row(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            owner_user_id: row.get("owner_user_id"),
            list_id: row.get("list_id"),
            parent_task_id: row.get("parent_task_id"),
            title: row.get("title"),
            description: row.get("description"),
            status: row.get("status"),
            priority: row.get("priority"),
            position: row.get("position"),
            due_at: row.get("due_at"),
            do_at: row.get("do_at"),
            effort: row.get("effort"),
            source: row.get("source"),
            source_ref: row.get("source_ref"),
            completed_at: row.get("completed_at"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            suggestion_metadata: row.get("suggestion_metadata"),
            recurrence: row.get("recurrence"),
        }
    }

    pub fn to_json(&self, tags: &[TaskTag]) -> Value {
        json!({
            "id": self.id,
            "ownerUserId": self.owner_user_id,
            "listId": self.list_id,
            "parentTaskId": self.parent_task_id,
            "title": self.title,
            "description": self.description,
            "status": self.status,
            "priority": self.priority,
            "position": self.position,
            "dueAt": self.due_at.map(to_iso_string),
            "doAt": self.do_at.map(to_iso_string),
            "effort": self.effort,
            "source": self.source,
            "sourceRef": self.source_ref,
            "completedAt": self.completed_at.map(to_iso_string),
            "createdAt": to_iso_string(self.created_at),
            "updatedAt": to_iso_string(self.updated_at),
            "tags": tags.iter().map(TaskTag::to_json).collect::<Vec<_>>(),
            "suggestionMetadata": self.suggestion_metadata,
            "recurrence": self
                .recurrence
                .as_ref()
                .and_then(parse_recurrence)
                .map(|spec| spec.to_json()),
        })
    }
}

#[derive(Clone, Debug)]
pub struct TaskList {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub name: String,
    pub position: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TaskList {
    pub fn from_row(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            owner_user_id: row.get("owner_user_id"),
            name: row.get("name"),
            position: row.get("position"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "ownerUserId": self.owner_user_id,
            "name": self.name,
            "position": self.position,
            "createdAt": to_iso_string(self.created_at),
            "updatedAt": to_iso_string(self.updated_at),
        })
    }
}

#[derive(Clone, Debug)]
pub struct TaskTag {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub list_id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

impl TaskTag {
    pub fn from_row(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            owner_user_id: row.get("owner_user_id"),
            list_id: row.get("list_id"),
            name: row.get("name"),
            created_at: row.get("created_at"),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "ownerUserId": self.owner_user_id,
            "listId": self.list_id,
            "name": self.name,
            "createdAt": to_iso_string(self.created_at),
        })
    }
}

pub struct TaskActivity {
    pub id: Uuid,
    pub task_id: Uuid,
    pub actor_user_id: Uuid,
    pub activity_type: String,
    pub body: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl TaskActivity {
    pub fn from_row(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            task_id: row.get("task_id"),
            actor_user_id: row.get("actor_user_id"),
            activity_type: row.get("activity_type"),
            body: row.get("body"),
            created_at: row.get("created_at"),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "taskId": self.task_id,
            "actorUserId": self.actor_user_id,
            "activityType": self.activity_type,
            "body": self.body,
            "createdAt": to_iso_string(self.created_at),
        })
    }
}

pub fn preferences_json(row: &Row) -> Value {
    let updated_at: Option<DateTime<Utc>> = row.get("updated_at");
    json!({
        "defaultView": row.get::<_, String>("default_view"),
        "updatedAt": updated_at.map(to_iso_string),
    })
}
