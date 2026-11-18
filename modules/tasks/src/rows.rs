//! Existing Tasks JSON shapes; database-only columns never enter response DTOs.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn optional_iso(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(iso)
}

#[derive(Clone, Debug, Deserialize)]
pub struct Task {
    pub id: String,
    pub owner_user_id: String,
    pub list_id: String,
    pub parent_task_id: Option<String>,
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
    pub recurrence_series_id: Option<String>,
}
impl Task {
    pub fn dto(&self, tags: &[Tag]) -> Value {
        json!({
            "id":self.id,"ownerUserId":self.owner_user_id,"listId":self.list_id,
            "parentTaskId":self.parent_task_id,"title":self.title,
            "description":self.description,"status":self.status,"priority":self.priority,
            "position":self.position,"dueAt":optional_iso(self.due_at),
            "doAt":optional_iso(self.do_at),"effort":self.effort,"source":self.source,
            "sourceRef":self.source_ref,"completedAt":optional_iso(self.completed_at),
            "createdAt":iso(self.created_at),"updatedAt":iso(self.updated_at),
            "tags":tags.iter().map(Tag::dto).collect::<Vec<_>>(),
            "suggestionMetadata":self.suggestion_metadata,
            "recurrence":self.recurrence.as_ref().and_then(crate::recurrence::parse)
                .map(|r| r.dto())
        })
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct List {
    pub id: String,
    pub owner_user_id: String,
    pub name: String,
    pub position: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
impl List {
    pub fn dto(&self) -> Value {
        json!({"id":self.id,"ownerUserId":self.owner_user_id,"name":self.name,
            "position":self.position,"createdAt":iso(self.created_at),"updatedAt":iso(self.updated_at)})
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Tag {
    pub id: String,
    pub owner_user_id: String,
    pub list_id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
}
impl Tag {
    pub fn dto(&self) -> Value {
        json!({"id":self.id,"ownerUserId":self.owner_user_id,"listId":self.list_id,
            "name":self.name,"createdAt":iso(self.created_at)})
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Activity {
    pub id: String,
    pub task_id: String,
    pub actor_user_id: String,
    pub activity_type: String,
    pub body: Option<String>,
    pub created_at: DateTime<Utc>,
}
impl Activity {
    pub fn dto(&self) -> Value {
        json!({"id":self.id,"taskId":self.task_id,"actorUserId":self.actor_user_id,
            "activityType":self.activity_type,"body":self.body,"createdAt":iso(self.created_at)})
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Preferences {
    pub default_view: String,
    pub updated_at: Option<DateTime<Utc>>,
}
impl Preferences {
    pub fn dto(&self) -> Value {
        json!({"defaultView":self.default_view,"updatedAt":optional_iso(self.updated_at)})
    }
}
