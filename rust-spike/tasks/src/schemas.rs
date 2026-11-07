//! The Tasks request schemas, transcribed from `packages/shared/src/tasks-api.ts`.
//!
//! Path-parameter schemas are omitted: every matched route supplies its parameters as
//! strings, so they cannot fail. No Tasks route declares a querystring schema.

use crate::schema::{Pattern, Schema};

const TASK_STATUSES: &[&str] = &["todo", "suggested", "done", "archived"];
const TASK_EFFORTS: &[&str] = &["quick", "medium", "large"];
const RECURRENCE_FREQUENCIES: &[&str] = &["daily", "weekly", "monthly"];
const DEFAULT_VIEWS: &[&str] = &["priority", "matrix"];

fn nullable_string() -> Schema {
    Schema::nullable(Schema::string())
}

/// `^\d{4}-\d{2}-\d{2}$`, which in JavaScript matches ASCII digits only.
fn is_iso_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}

fn recurrence_spec() -> Schema {
    Schema::object(
        &["freq", "interval", "occurrence_date"],
        vec![
            ("freq", Schema::one_of_strings(RECURRENCE_FREQUENCIES)),
            ("interval", Schema::Integer { minimum: Some(1), maximum: None }),
            (
                "occurrence_date",
                Schema::String {
                    allowed: None,
                    pattern: Some(Pattern { source: r"^\d{4}-\d{2}-\d{2}$", test: is_iso_day }),
                },
            ),
        ],
    )
}

fn task_properties() -> Vec<(&'static str, Schema)> {
    vec![
        ("title", Schema::string()),
        ("description", nullable_string()),
        ("status", Schema::one_of_strings(TASK_STATUSES)),
        ("priority", Schema::nullable(Schema::Integer { minimum: Some(1), maximum: Some(5) })),
        ("dueAt", nullable_string()),
        ("listId", Schema::string()),
        ("doAt", nullable_string()),
        ("effort", Schema::nullable(Schema::one_of_strings(TASK_EFFORTS))),
        ("parentTaskId", nullable_string()),
        ("recurrence", Schema::nullable(recurrence_spec())),
    ]
}

pub fn create_task() -> Schema {
    Schema::object(&["title"], task_properties())
}

pub fn update_task() -> Schema {
    Schema::object(&[], task_properties())
}

pub fn add_activity() -> Schema {
    Schema::object(&[], vec![("activityType", Schema::string()), ("body", nullable_string())])
}

pub fn deferred_status() -> Schema {
    Schema::object(
        &["status"],
        vec![("status", Schema::one_of_strings(TASK_STATUSES)), ("idempotencyKey", Schema::string())],
    )
}

/// Create list, rename list, create tag and rename tag share this body.
pub fn name_only() -> Schema {
    Schema::object(&["name"], vec![("name", Schema::string())])
}

pub fn delete_list() -> Schema {
    Schema::object(&[], vec![("reassignToListId", Schema::string())])
}

pub fn assign_tag() -> Schema {
    Schema::object(&["tagId"], vec![("tagId", Schema::string())])
}

pub fn update_preferences() -> Schema {
    Schema::object(&["defaultView"], vec![("defaultView", Schema::one_of_strings(DEFAULT_VIEWS))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_day_pattern_is_ascii_only() {
        assert!(is_iso_day("2026-11-07"));
        assert!(is_iso_day("0000-99-99"));
        assert!(!is_iso_day("2026-11-7"));
        assert!(!is_iso_day("2026-11-07\n"));
        assert!(!is_iso_day("２026-11-07"));
    }
}
