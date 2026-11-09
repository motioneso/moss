//! Deletion shares the invocation transaction. Identifier-preserving updates
//! lock existing actor lists without changing their stored fields or timestamps.
use crate::{
    repository::{and, order, values, Error, Repository, Result, LISTS, TAGS, TASKS},
    rows::{List, Task},
};
use moss_module_sdk::{
    query::{Filter, Query},
    Host,
};
use serde_json::json;

impl<H: Host + ?Sized> Repository<'_, H> {
    fn discard_deletion_rows(&self, table: &str, query: &Query) -> Result<()> {
        #[cfg(target_arch = "wasm32")]
        {
            crate::component::execute_query(table, query)?;
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.client.query(table, query)?;
        }
        Ok(())
    }

    fn owned_lists(&self) -> Result<Vec<List>> {
        self.all(LISTS, Filter::Owned, vec![order("id", false)])
    }

    fn lock_lists(&self) -> Result<()> {
        loop {
            let lists = self.owned_lists()?;
            if lists.is_empty() {
                return Ok(());
            }
            let mut locked = false;
            // Lock every initially visible row in a stable order, including the
            // rows this invocation will keep. A later delete must wait for at
            // least one survivor. Inserts do not invalidate the last-list guard.
            for list in lists {
                let rows: Vec<List> = self.query(
                    LISTS,
                    &Query::update(
                        and(vec![Filter::Owned, Filter::eq("id", list.id.clone())]),
                        values(json!({"id":list.id})),
                    ),
                )?;
                locked |= !rows.is_empty();
            }
            if locked {
                return Ok(());
            }
            // A concurrent delete may have removed every selected row before
            // we acquired a lock. Re-read instead of counting without a lock.
        }
    }

    pub fn delete_list(&self, id: &str, destination: Option<&str>) -> Result<()> {
        self.lock_lists()?;
        if self.first::<List>(LISTS, Filter::eq("id", id))?.is_none() {
            return Err(Error::Http(404, "List not found or not accessible"));
        }
        if destination == Some(id) {
            return Err(Error::Http(400, "Cannot reassign a list's tasks to itself"));
        }
        if self.owned_lists()?.len() <= 1 {
            return Err(Error::Http(409, "Cannot delete your only list"));
        }
        if let Some(destination) = destination.filter(|id| !id.is_empty()) {
            if self
                .first::<List>(
                    LISTS,
                    and(vec![Filter::Owned, Filter::eq("id", destination)]),
                )?
                .is_none()
            {
                return Err(Error::Http(
                    404,
                    "Destination list not found or not accessible",
                ));
            }
            // The existing task_tag_list_match rule only permits assignments
            // within a task's list. Removing source tags cascades their links;
            // those definitions would be removed with the source list anyway.
            // Do this before moving tasks, without reading full task bodies.
            self.discard_deletion_rows(TAGS, &Query::delete(Filter::eq("list_id", id)))?;
            // Unused returning rows are not parsed or copied into Task values.
            self.discard_deletion_rows(
                TASKS,
                &Query::update(
                    Filter::eq("list_id", id),
                    values(json!({"list_id":destination,"updated_at":self.now()?})),
                ),
            )?;
        } else if self
            .first::<Task>(TASKS, Filter::eq("list_id", id))?
            .is_some()
        {
            return Err(Error::Http(409, "List is not empty"));
        }
        let deleted: Vec<List> = self.query(LISTS, &Query::delete(Filter::eq("id", id)))?;
        if deleted.is_empty() {
            return Err(Error::Http(404, "List not found or not accessible"));
        }
        Ok(())
    }
}
