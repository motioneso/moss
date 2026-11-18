//! Tool inputs are schema-checked but are not HTTP form inputs: keep their text
//! exactly as supplied, including empty strings, as the legacy tool repository does.
use crate::{
    parse::{Patch, TaskFields},
    recurrence::Recurrence,
    repository::{Error, Result},
    task_fields::TaskStatus,
};
use serde_json::Value;

pub fn task_fields(input: &Value) -> Result<TaskFields> {
    Ok(TaskFields {
        title: input
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned),
        description: patch(input, "description", string)?,
        status: match input.get("status").and_then(Value::as_str) {
            Some("todo") => Some(TaskStatus::Todo),
            Some("suggested") => Some(TaskStatus::Suggested),
            Some("done") => Some(TaskStatus::Done),
            Some("archived") => Some(TaskStatus::Archived),
            None => None,
            _ => return Err(Error::Http(400, "Invalid status")),
        },
        priority: patch(input, "priority", |v| {
            v.as_f64()
                .map(|n| n as i16)
                .ok_or(Error::Http(400, "Invalid priority"))
        })?,
        due_at: patch(input, "dueAt", date)?,
        list_id: input
            .get("listId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        do_at: patch(input, "doAt", date)?,
        effort: patch(input, "effort", string)?,
        parent_task_id: patch(input, "parentTaskId", string)?,
        recurrence: patch(input, "recurrence", |v| {
            Ok(Recurrence {
                freq: v["freq"].as_str().unwrap().into(),
                interval: v["interval"].as_f64().unwrap(),
                occurrence_date: v["occurrence_date"].as_str().unwrap().into(),
            })
        })?,
    })
}
fn patch<T>(input: &Value, key: &str, read: impl FnOnce(&Value) -> Result<T>) -> Result<Patch<T>> {
    match input.get(key) {
        None => Ok(Patch::Keep),
        Some(Value::Null) => Ok(Patch::Clear),
        Some(value) => read(value).map(Patch::Set),
    }
}
fn string(value: &Value) -> Result<String> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or(Error::Http(400, "Invalid text"))
}
fn date(value: &Value) -> Result<chrono::DateTime<chrono::Utc>> {
    value
        .as_str()
        .and_then(crate::dates::parse_js_date)
        .ok_or(Error::Http(400, "Invalid date"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_text_nulls_and_omitted_fields_separately() {
        let fields =
            task_fields(&json!({"title":"  raw  ","description":"","priority":3.0})).unwrap();
        assert_eq!(fields.title.as_deref(), Some("  raw  "));
        assert_eq!(fields.description, Patch::Set(String::new()));
        assert_eq!(fields.priority, Patch::Set(3));
        assert!(matches!(fields.due_at, Patch::Keep));
        let fields =
            task_fields(&json!({"description":null,"dueAt":null,"recurrence":null})).unwrap();
        assert_eq!(fields.description, Patch::Clear);
        assert!(matches!(fields.due_at, Patch::Clear));
        assert!(matches!(fields.recurrence, Patch::Clear));
    }
}
