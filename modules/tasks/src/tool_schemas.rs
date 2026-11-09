//! Tool schemas follow the legacy manifest and tool-schemas declarations.
use crate::{schema::Schema, schemas};

pub fn input(tool: &str) -> Option<Schema> {
    Some(match tool {
        "tasks.list" => Schema::object(
            &[],
            vec![
                ("listId", Schema::string()),
                ("tagId", Schema::string()),
                (
                    "status",
                    Schema::one_of_strings(&["todo", "done", "archived"]),
                ),
                (
                    "priority",
                    Schema::Integer {
                        minimum: Some(1),
                        maximum: Some(5),
                    },
                ),
                ("dueBefore", Schema::string()),
                ("dueAfter", Schema::string()),
                ("completedAfter", Schema::string()),
                (
                    "quadrant",
                    Schema::one_of_strings(&["do", "schedule", "delegate", "eliminate"]),
                ),
            ],
        ),
        "tasks.get" | "tasks.activity" => strings(&["taskId"]),
        "tasks.listTags" => strings(&["listId"]),
        "tasks.listLists" => strings(&[]),
        "tasks.heartbeatWindow" => Schema::object(
            &[],
            vec![
                (
                    "horizonHours",
                    Schema::Integer {
                        minimum: Some(1),
                        maximum: Some(48),
                    },
                ),
                (
                    "limit",
                    Schema::Integer {
                        minimum: Some(1),
                        maximum: Some(20),
                    },
                ),
            ],
        ),
        "tasks.create" => schemas::create_task(),
        "tasks.update" => with_ids(schemas::update_task(), &["taskId"]),
        "tasks.updateStatus" => Schema::object(
            &["taskId", "status"],
            vec![
                ("taskId", Schema::string()),
                (
                    "status",
                    Schema::one_of_strings(&["todo", "suggested", "done", "archived"]),
                ),
            ],
        ),
        "tasks.breakDown" => with_ids(schemas::breakdown(), &["taskId", "steps"]),
        "tasks.addActivity" => with_ids(schemas::add_activity(), &["taskId"]),
        "tasks.assignTag" | "tasks.unassignTag" => strings(&["taskId", "tagId"]),
        "tasks.createList" => schemas::name_only(),
        "tasks.renameList" | "tasks.createTag" => {
            with_ids(schemas::name_only(), &["listId", "name"])
        }
        "tasks.renameTag" => with_ids(schemas::name_only(), &["listId", "tagId", "name"]),
        "tasks.deleteTag" => strings(&["listId", "tagId"]),
        "tasks.deleteList" => with_ids(schemas::delete_list(), &["listId"]),
        _ => return None,
    })
}
fn strings(required: &'static [&'static str]) -> Schema {
    Schema::object(
        required,
        required
            .iter()
            .map(|key| (*key, Schema::string()))
            .collect(),
    )
}
fn with_ids(schema: Schema, required: &'static [&'static str]) -> Schema {
    let Schema::Object(mut object) = schema else {
        unreachable!("Tasks body schemas are objects")
    };
    object.required = required;
    for key in required.iter().rev() {
        if !object.properties.iter().any(|(name, _)| name == key) {
            object.properties.insert(0, (*key, Schema::string()));
        }
    }
    Schema::Object(object)
}

/// Tools receive typed JSON rather than Fastify form coercions. In particular,
/// a null must stay null and a number must not become a task title.
pub fn validate(schema: &Schema, value: &serde_json::Value) -> bool {
    use serde_json::Value;
    match schema {
        Schema::Object(object) => value.as_object().is_some_and(|v| {
            object.required.iter().all(|key| v.contains_key(*key))
                && object
                    .properties
                    .iter()
                    .all(|(key, schema)| v.get(*key).is_none_or(|value| validate(schema, value)))
        }),
        Schema::String { allowed, pattern } => value.as_str().is_some_and(|s| {
            allowed.is_none_or(|a| a.contains(&s)) && pattern.is_none_or(|p| (p.test)(s))
        }),
        Schema::Integer { minimum, maximum } => value.as_f64().is_some_and(|n| {
            n.fract() == 0.0
                && minimum.is_none_or(|m| n >= m as f64)
                && maximum.is_none_or(|m| n <= m as f64)
        }),
        Schema::Boolean => value.is_boolean(),
        Schema::Null => value == &Value::Null,
        Schema::AnyOf(schemas) => schemas.iter().any(|s| validate(s, value)),
        Schema::Array(item) => value
            .as_array()
            .is_some_and(|values| values.iter().all(|v| validate(item, v))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tools_do_not_coerce_nulls_numbers_or_step_arrays() {
        let schema = input("tasks.create").unwrap();
        assert!(validate(
            &schema,
            &json!({"title":"","description":null,"priority":null})
        ));
        assert!(!validate(&schema, &json!({"title":12})));
        assert!(!validate(&schema, &json!({"title":"x","priority":"3"})));
        let schema = input("tasks.breakDown").unwrap();
        assert!(validate(
            &schema,
            &json!({"taskId":"x","steps":[" raw ",""]})
        ));
        assert!(!validate(&schema, &json!({"taskId":"x","steps":"raw"})));
        assert!(!validate(&schema, &json!({"taskId":"x","steps":[12]})));
        assert!(!validate(&schema, &json!({"steps":[]})));
        let schema = input("tasks.list").unwrap();
        for value in [
            json!({"priority":"3"}),
            json!({"priority":0}),
            json!({"priority":6}),
            json!({"status":"suggested"}),
            json!({"quadrant":"other"}),
            json!({"dueBefore":null}),
        ] {
            assert!(!validate(&schema, &value));
        }
    }
}
