//! One-level ordered breakdown uses the existing database hierarchy guard.
use crate::{
    repository::{and, values, Error, Repository, Result, TASKS},
    rows::Task,
};
use moss_module_sdk::{
    query::{Filter, Query},
    Host,
};
use serde_json::json;

impl<H: Host + ?Sized> Repository<'_, H> {
    pub fn break_down(&self, parent: &str, steps: &[String]) -> Result<Vec<Task>> {
        // Legacy empty breakdowns do not even look up the parent.
        if steps.is_empty() {
            return Ok(vec![]);
        }
        let parent: Task = self
            .first(TASKS, and(vec![Filter::Owned, Filter::eq("id", parent)]))?
            .ok_or(Error::Http(500, "Internal server error"))?;
        let now = self.now()?;
        let mut children = Vec::with_capacity(steps.len());
        for (position, title) in steps.iter().enumerate() {
            children.push(self.one(
                crate::repository::TASKS,
                Query::insert(values(json!({
                    "list_id":parent.list_id,"parent_task_id":parent.id,"title":title,
                    "status":"todo","position":position,"source":"manual",
                    "created_at":now,"updated_at":now
                }))),
            )?);
        }
        self.add_activity(
            &parent.id,
            "broken_down",
            Some(&format!(
                "Broken into {} step{}",
                steps.len(),
                if steps.len() == 1 { "" } else { "s" }
            )),
        )?;
        Ok(children)
    }
}
