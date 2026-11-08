//! Typed data primitives. The route/tool/job orchestration layer is a separate porting step.
//! Calls must share a host invocation; it owns their transaction and final outcome.
use crate::rows::{Activity, List, Preferences, Tag, Task};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Host,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const TASKS: &str = "app.tasks";
pub const LISTS: &str = "app.task_lists";
pub const TAGS: &str = "app.task_tags";
pub const ASSIGNMENTS: &str = "app.task_tag_assignments";
pub const ACTIVITY: &str = "app.task_activity";
pub const PREFERENCES: &str = "app.task_preferences";
pub const TABLES: &[&str] = &[TASKS, LISTS, TAGS, ASSIGNMENTS, ACTIVITY, PREFERENCES];

#[derive(Debug)]
pub enum Error {
    Http(u16, &'static str),
    Host(moss_module_sdk::Error),
}
impl Error {
    pub fn response(&self) -> moss_module_sdk::Response {
        match self {
            Self::Http(status, message) => {
                moss_module_sdk::Response::new(*status, json!({"error":message}))
            }
            Self::Host(_) => {
                moss_module_sdk::Response::new(500, json!({"error":"Internal server error"}))
            }
        }
    }
}
impl From<moss_module_sdk::Error> for Error {
    fn from(value: moss_module_sdk::Error) -> Self {
        Self::Host(value)
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::Host(moss_module_sdk::Error::new("Invalid Tasks row"))
    }
}
pub type Result<T> = std::result::Result<T, Error>;
fn values(value: Value) -> BTreeMap<String, Value> {
    value
        .as_object()
        .expect("internal object")
        .clone()
        .into_iter()
        .collect()
}
fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}
fn order(column: &str, descending: bool) -> Order {
    Order {
        column: column.into(),
        descending,
    }
}

pub struct Repository<'a, H: Host + ?Sized> {
    client: Client<'a, H>,
}
impl<'a, H: Host + ?Sized> Repository<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self {
            client: Client(host),
        }
    }
    fn query<T: DeserializeOwned>(&self, table: &str, q: &Query) -> Result<Vec<T>> {
        self.client
            .query(table, q)?
            .into_iter()
            .map(|v| serde_json::from_value(v).map_err(Into::into))
            .collect()
    }
    fn all<T: DeserializeOwned>(
        &self,
        table: &str,
        filter: Filter,
        order: Vec<Order>,
    ) -> Result<Vec<T>> {
        let mut query = Query::select(filter);
        query.order = order;
        query.limit = Some(1000);
        let mut result = Vec::new();
        loop {
            let page: Vec<T> = self.query(table, &query)?;
            let count = page.len();
            result.extend(page);
            if count < 1000 {
                return Ok(result);
            }
            query.offset += 1000;
            if query.offset > 1_000_000 {
                return Err(moss_module_sdk::Error::new("Tasks page limit exceeded").into());
            }
        }
    }
    fn first<T: DeserializeOwned>(&self, table: &str, filter: Filter) -> Result<Option<T>> {
        let mut q = Query::select(filter);
        q.limit = Some(1);
        Ok(self.query(table, &q)?.into_iter().next())
    }
    fn one<T: DeserializeOwned>(&self, table: &str, q: Query) -> Result<T> {
        self.query(table, &q)?
            .into_iter()
            .next()
            .ok_or_else(|| moss_module_sdk::Error::new("Expected Tasks row").into())
    }
    fn now(&self) -> Result<String> {
        let context = self.client.0.call("context", "read", "call", json!({}))?;
        let now: DateTime<Utc> = serde_json::from_value(context["now"].clone())?;
        Ok(now.to_rfc3339_opts(SecondsFormat::Millis, true))
    }
    pub fn task(&self, id: &str) -> Result<Option<Task>> {
        self.first(TASKS, Filter::eq("id", id))
    }
    /// Data primitive only: status, recurrence, list moves and activity are handled above this layer.
    pub fn set_task_title(&self, id: &str, title: &str) -> Result<Option<Task>> {
        Ok(self
            .query(
                TASKS,
                &Query::update(
                    Filter::eq("id", id),
                    values(json!({"title":title,"updated_at":self.now()?})),
                ),
            )?
            .into_iter()
            .next())
    }
    /// Reads visible persisted rows. Recurrence freshness belongs to the invocation service.
    pub fn persisted_tasks(&self) -> Result<Vec<Task>> {
        self.all(
            TASKS,
            Filter::All,
            vec![order("updated_at", true), order("id", false)],
        )
    }
    pub fn subtasks(&self, id: &str) -> Result<Vec<Task>> {
        self.all(
            TASKS,
            Filter::eq("parent_task_id", id),
            vec![order("position", false), order("id", false)],
        )
    }
    pub fn lists(&self) -> Result<Vec<List>> {
        self.all(
            LISTS,
            Filter::All,
            vec![
                order("position", false),
                order("name", false),
                order("id", false),
            ],
        )
    }
    /// Pattern characters must be literal: ILIKE supplies case-insensitive matching, not search.
    pub fn get_or_create_list(&self, name: &str) -> Result<List> {
        let pattern = name
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let filter = Filter::Compare {
            column: "name".into(),
            op: moss_module_sdk::query::Compare::ILike,
            value: json!(pattern),
        };
        if let Some(row) = self.first(LISTS, filter.clone())? {
            return Ok(row);
        }
        let mut q = Query::insert(values(json!({"name":name,"position":0})));
        q.conflict = Conflict::Ignore;
        if let Some(row) = self.query(LISTS, &q)?.into_iter().next() {
            return Ok(row);
        }
        self.first(LISTS, filter)?
            .ok_or_else(|| moss_module_sdk::Error::new("List creation lost its row").into())
    }
    pub fn rename_list(&self, id: &str, name: &str) -> Result<List> {
        self.query(
            LISTS,
            &Query::update(
                Filter::eq("id", id),
                values(json!({"name":name,"updated_at":self.now()?})),
            ),
        )?
        .into_iter()
        .next()
        .ok_or(Error::Http(404, "List not found or not accessible"))
    }
    pub fn tags(&self, list: &str) -> Result<Vec<Tag>> {
        self.all(
            TAGS,
            Filter::eq("list_id", list),
            vec![order("name", false), order("id", false)],
        )
    }
    pub fn create_tag(&self, list: &str, name: &str) -> Result<Tag> {
        if self.first::<List>(LISTS, Filter::eq("id", list))?.is_none() {
            return Err(Error::Http(404, "List not found or not accessible"));
        }
        self.one(
            TAGS,
            Query::insert(values(json!({"list_id":list,"name":name}))),
        )
    }
    pub fn rename_tag(&self, list: &str, id: &str, name: &str) -> Result<Tag> {
        self.query(
            TAGS,
            &Query::update(
                and(vec![Filter::eq("list_id", list), Filter::eq("id", id)]),
                values(json!({"name":name})),
            ),
        )?
        .into_iter()
        .next()
        .ok_or(Error::Http(404, "Tag not found or not accessible"))
    }
    pub fn delete_tag(&self, list: &str, id: &str) -> Result<()> {
        let rows: Vec<Value> = self.query(
            TAGS,
            &Query::delete(and(vec![Filter::eq("list_id", list), Filter::eq("id", id)])),
        )?;
        if rows.is_empty() {
            return Err(Error::Http(404, "Tag not found or not accessible"));
        }
        Ok(())
    }
    fn owned_task(&self, id: &str) -> Result<Task> {
        self.first(TASKS, and(vec![Filter::Owned, Filter::eq("id", id)]))?
            .ok_or(Error::Http(404, "Task not found or not accessible"))
    }
    pub fn assign_tag(&self, task: &str, tag: &str) -> Result<()> {
        let task = self.owned_task(task)?;
        let tag: Tag = self
            .first(TAGS, and(vec![Filter::Owned, Filter::eq("id", tag)]))?
            .ok_or(Error::Http(404, "Tag not found or not accessible"))?;
        if task.list_id != tag.list_id {
            return Err(Error::Http(400, "tag must belong to the task's list"));
        }
        let mut q = Query::insert(values(json!({"task_id":task.id,"tag_id":tag.id})));
        q.conflict = Conflict::Ignore;
        let _: Vec<Value> = self.query(ASSIGNMENTS, &q)?;
        Ok(())
    }
    pub fn unassign_tag(&self, task: &str, tag: &str) -> Result<()> {
        self.owned_task(task)?;
        let _: Vec<Value> = self.query(
            ASSIGNMENTS,
            &Query::delete(and(vec![
                Filter::eq("task_id", task),
                Filter::eq("tag_id", tag),
            ])),
        )?;
        Ok(())
    }
    pub fn task_tags(&self, task: &str) -> Result<Vec<Tag>> {
        let links: Vec<Value> = self.all(
            ASSIGNMENTS,
            Filter::eq("task_id", task),
            vec![order("tag_id", false)],
        )?;
        let ids = links
            .into_iter()
            .filter_map(|v| v["tag_id"].as_str().map(str::to_owned))
            .collect::<std::collections::BTreeSet<_>>();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        // Read owner-visible tags in database collation order; avoid an unbounded IN filter.
        let tags: Vec<Tag> = self.all(
            TAGS,
            Filter::All,
            vec![order("name", false), order("id", false)],
        )?;
        Ok(tags.into_iter().filter(|t| ids.contains(&t.id)).collect())
    }
    pub fn activity(&self, task: &str) -> Result<Vec<Activity>> {
        self.all(
            ACTIVITY,
            Filter::eq("task_id", task),
            vec![order("created_at", false), order("id", false)],
        )
    }
    pub fn add_activity(&self, task: &str, kind: &str, body: Option<&str>) -> Result<Activity> {
        // The actor column is not an owner column. Only the host's invocation context sets it.
        let context = self.client.0.call("context", "read", "call", json!({}))?;
        self.one(
            ACTIVITY,
            Query::insert(values(
                json!({"task_id":task,"actor_user_id":context["actorUserId"],
            "actor_kind":"user","activity_type":kind,"body":body,"created_at":context["now"]}),
            )),
        )
    }
    pub fn preferences(&self) -> Result<Preferences> {
        if let Some(row) = self.first(PREFERENCES, Filter::Owned)? {
            return Ok(row);
        }
        let mut q = Query::insert(values(json!({"default_view":"priority"})));
        q.conflict = Conflict::Ignore;
        if let Some(row) = self.query(PREFERENCES, &q)?.into_iter().next() {
            return Ok(row);
        }
        self.first(PREFERENCES, Filter::Owned)?
            .ok_or_else(|| moss_module_sdk::Error::new("Preferences creation lost its row").into())
    }
    pub fn set_default_view(&self, view: &str) -> Result<Preferences> {
        if !["priority", "matrix"].contains(&view) {
            return Err(Error::Http(400, "defaultView must be priority or matrix"));
        }
        self.preferences()?;
        self.one(
            PREFERENCES,
            Query::update(
                Filter::Owned,
                values(json!({"default_view":view,"updated_at":self.now()?})),
            ),
        )
    }
}
