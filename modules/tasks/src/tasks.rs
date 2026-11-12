//! Task mutations over typed, invocation-scoped queries. The host owns commit/rollback.
use crate::{
    parse::{Patch, TaskFields},
    repository::{and, values, Error, Repository, Result, ASSIGNMENTS, LISTS, TASKS},
    rows::{List, Task},
};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Host,
};
use serde_json::{json, Value};

impl<H: Host + ?Sized> Repository<'_, H> {
    pub(crate) fn uuid(&self) -> Result<String> {
        let value = self.client.0.call("context", "uuid", "new", json!({}))?;
        value["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| moss_module_sdk::Error::new("Invalid host identifier").into())
    }
    fn validate_links(&self, input: &TaskFields) -> Result<()> {
        if let Some(id) = &input.list_id {
            if self
                .first::<List>(LISTS, Filter::eq("id", id.as_str()))?
                .is_none()
            {
                return Err(Error::Http(404, "List not found or not accessible"));
            }
        }
        if let Patch::Set(id) = &input.parent_task_id {
            if self
                .first::<Task>(
                    TASKS,
                    and(vec![Filter::Owned, Filter::eq("id", id.as_str())]),
                )?
                .is_none()
            {
                return Err(Error::Http(404, "Parent task not found or not accessible"));
            }
        }
        Ok(())
    }
    pub fn create_task(&self, input: &TaskFields) -> Result<Task> {
        self.validate_links(input)?;
        let list = match &input.list_id {
            Some(id) => id.clone(),
            None => self.get_or_create_list("Personal")?.id,
        };
        let now = self.now()?;
        let status = input.status.map(|s| s.as_str()).unwrap_or("todo");
        let mut data = values(json!({
            "title":input.title,"list_id":list,"status":status,
            "source":"manual","position":0,"created_at":now,"updated_at":now,
            "completed_at":if status == "done" {Some(&now)} else {None},
        }));
        fields(input, &mut data);
        if let Patch::Set(_) = &input.recurrence {
            data.insert("recurrence_series_id".into(), json!(self.uuid()?));
        }
        let created = self.one(TASKS, Query::insert(data))?;
        if matches!(&input.recurrence, Patch::Set(_)) {
            crate::jobs::reconcile_recurrence_schedule(self);
        }
        Ok(created)
    }
    /// Creates the task for an accepted meeting action. A repeat of the same key returns the
    /// task made the first time, so a replayed or regenerated action never doubles up.
    pub fn create_meeting_task(
        &self,
        title: &str,
        due_at: Option<&str>,
        meeting_id: &str,
        external_key: &str,
    ) -> Result<Task> {
        let same = and(vec![
            Filter::Owned,
            Filter::eq("source", "meeting"),
            Filter::eq("external_key", external_key),
        ]);
        if let Some(found) = self.first::<Task>(TASKS, same)? {
            return Ok(found);
        }
        let list = self.get_or_create_list("Personal")?.id;
        let now = self.now()?;
        let data = values(json!({
            "title":title,"list_id":list,"status":"todo","due_at":due_at,
            "source":"meeting","source_ref":meeting_id,"external_key":external_key,
            "position":0,"created_at":now,"updated_at":now,
        }));
        self.one(TASKS, Query::insert(data))
    }
    pub fn update_task(&self, id: &str, input: &TaskFields) -> Result<Option<Task>> {
        // Keep the route's pre-read: do not resolve new relationships for a hidden task.
        let Some(prior) = self.task(id)? else {
            return Ok(None);
        };
        self.validate_links(input)?;
        let now = self.now()?;
        let mut data = values(json!({"updated_at":now}));
        fields(input, &mut data);
        if let Some(status) = input.status {
            data.insert("status".into(), json!(status.as_str()));
            data.insert(
                "completed_at".into(),
                if status.as_str() == "done" {
                    json!(now)
                } else {
                    Value::Null
                },
            );
        }
        match &input.recurrence {
            Patch::Set(_) => {
                data.insert(
                    "recurrence_series_id".into(),
                    json!(match &prior.recurrence_series_id {
                        Some(id) => id.clone(),
                        None => self.uuid()?,
                    }),
                );
            }
            Patch::Clear => {
                data.insert("recurrence_series_id".into(), Value::Null);
            }
            Patch::Keep => {}
        }
        // Legacy duplicate-successor handling rolls back the repeated completion's
        // write. Preserve that stored history for an owner's status-only retry,
        // without aborting this invocation's transaction. The INSERT decides whether
        // the successor exists atomically; a missing successor is still repaired.
        // Never take this insert-before-update path for a merely visible shared task.
        if prior.status == "done"
            && prior.recurrence_series_id.is_some()
            && input.status == Some(crate::task_fields::TaskStatus::Done)
            && data
                .keys()
                .all(|key| matches!(key.as_str(), "updated_at" | "status" | "completed_at"))
            && self
                .first::<Task>(TASKS, and(vec![Filter::Owned, Filter::eq("id", id)]))?
                .is_some()
            && self.generate_next(&prior)? == Some(false)
        {
            return Ok(Some(prior));
        }
        if let Some(list) = &input.list_id {
            self.drop_foreign_tags(id, list)?;
            if list != &prior.list_id {
                for child in self.subtasks(id)? {
                    self.drop_foreign_tags(&child.id, list)?;
                    let _: Vec<Value> = self.query(
                        TASKS,
                        &Query::update(
                            Filter::eq("id", child.id),
                            values(json!({"list_id":list,"updated_at":now})),
                        ),
                    )?;
                }
            }
        }
        let updated: Option<Task> = self
            .query(TASKS, &Query::update(Filter::eq("id", id), data))?
            .into_iter()
            .next();
        if updated.is_some() && matches!(&input.recurrence, Patch::Set(_)) {
            crate::jobs::reconcile_recurrence_schedule(self);
        }
        if let (Some(task), Some(status)) = (&updated, input.status) {
            let status = status.as_str();
            if task.parent_task_id.is_none() && ["done", "archived"].contains(&status) {
                for child in self.subtasks(id)? {
                    if child.status == status || child.status == "suggested" {
                        continue;
                    }
                    let _: Vec<Value> = self.query(TASKS, &Query::update(Filter::eq("id", child.id.as_str()), values(json!({
                        "status":status,"completed_at":if status == "done" {Some(&now)} else {None},"updated_at":now
                    }))))?;
                    self.add_activity(
                        &child.id,
                        "status_changed",
                        Some(&format!("Cascaded to {status} when parent was closed")),
                    )?;
                }
            }
            if status == "done" {
                if let Some(parent) = &task.parent_task_id {
                    let siblings = self.subtasks(parent)?;
                    if !siblings.is_empty() && siblings.iter().all(|t| t.status == "done") {
                        let _: Vec<Value> = self.query(
                            TASKS,
                            &Query::update(
                                and(vec![
                                    Filter::eq("id", parent.as_str()),
                                    Filter::Compare {
                                        column: "status".into(),
                                        op: moss_module_sdk::query::Compare::Ne,
                                        value: json!("done"),
                                    },
                                ]),
                                values(
                                    json!({"status":"done","completed_at":now,"updated_at":now}),
                                ),
                            ),
                        )?;
                        self.add_activity(
                            parent,
                            "completed",
                            Some("All subtasks completed — parent auto-closed"),
                        )?;
                    }
                }
                let _ = self.generate_next(task)?;
            }
        }
        Ok(updated)
    }
    pub(crate) fn drop_foreign_tags(&self, id: &str, list: &str) -> Result<()> {
        for tag in self.task_tags(id)? {
            if tag.list_id != list {
                let _: Vec<Value> = self.query(
                    ASSIGNMENTS,
                    &Query::delete(and(vec![
                        Filter::eq("task_id", id),
                        Filter::eq("tag_id", tag.id),
                    ])),
                )?;
            }
        }
        Ok(())
    }
    // None means non-recurring; Some(false) means the occurrence already exists.
    fn generate_next(&self, task: &Task) -> Result<Option<bool>> {
        let Some(series) = &task.recurrence_series_id else {
            return Ok(None);
        };
        let Some(mut spec) = task.recurrence.as_ref().and_then(crate::recurrence::parse) else {
            return Ok(None);
        };
        let next = spec
            .next()
            .ok_or(Error::Http(500, "Internal server error"))?;
        let old = chrono::NaiveDate::parse_from_str(&spec.occurrence_date, "%Y-%m-%d").unwrap();
        let new = chrono::NaiveDate::parse_from_str(&next, "%Y-%m-%d").unwrap();
        let delta = new - old;
        spec.occurrence_date = next;
        let now = self.now()?;
        let mut q = Query::insert(values(json!({
            "list_id":task.list_id,"parent_task_id":null,"title":task.title,"description":task.description,
            "status":"todo","priority":task.priority,"position":0,
            "due_at":task.due_at.map(|d| d + delta),"do_at":task.do_at.map(|d| d + delta),
            "effort":task.effort,"source":"recurrence","source_ref":null,"external_key":null,
            "recurrence":spec.dto(),"recurrence_series_id":series,"completed_at":null,"created_at":now,"updated_at":now
        })));
        q.conflict = Conflict::Ignore;
        let inserted: Vec<Task> = self.query(TASKS, &q)?;
        Ok(Some(!inserted.is_empty()))
    }
}

fn fields(input: &TaskFields, data: &mut std::collections::BTreeMap<String, Value>) {
    if let Some(title) = &input.title {
        data.insert("title".into(), json!(title));
    }
    if let Some(id) = &input.list_id {
        data.insert("list_id".into(), json!(id));
    }
    macro_rules! patch {
        ($field:ident,$column:literal) => {
            match &input.$field {
                Patch::Keep => {}
                Patch::Clear => {
                    data.insert($column.into(), Value::Null);
                }
                Patch::Set(v) => {
                    data.insert($column.into(), json!(v));
                }
            }
        };
    }
    patch!(description, "description");
    patch!(priority, "priority");
    patch!(due_at, "due_at");
    patch!(do_at, "do_at");
    patch!(effort, "effort");
    patch!(parent_task_id, "parent_task_id");
    match &input.recurrence {
        Patch::Keep => {}
        Patch::Clear => {
            data.insert("recurrence".into(), Value::Null);
        }
        Patch::Set(v) => {
            data.insert("recurrence".into(), v.dto());
        }
    }
}
