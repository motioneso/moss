//! Public `listBriefingTasks`: the small task facts Briefings may read for the caller.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Rows(RefCell<Vec<(String, Value)>>);
impl Host for Rows {
    fn call(&self, port: &str, operation: &str, table: &str, query: Value) -> Result<Value> {
        assert_eq!((port, operation), ("db", "query"));
        self.0.borrow_mut().push((table.to_owned(), query));
        if table != "app.tasks" {
            return Ok(json!([]));
        }
        let stamp = "2026-11-08T00:00:00.000Z";
        Ok(json!([{"id":"11111111-1111-4111-8111-111111111111","owner_user_id":"o","list_id":"l",
            "parent_task_id":null,"title":"Pay rent","description":"Secret body","status":"todo",
            "priority":3,"position":0,"due_at":"2026-11-09T10:00:00.000Z","do_at":null,"effort":null,
            "source":"user","source_ref":null,"completed_at":null,"created_at":stamp,
            "updated_at":stamp,"suggestion_metadata":null,"recurrence":null,
            "recurrence_series_id":null}]))
    }
}

fn call(rows: &Rows, parameters: Value) -> moss_module_sdk::Result<String> {
    let request = json!({"name":"listBriefingTasks","parameters":parameters});
    moss_tasks_module::handle(rows, "api", &request.to_string())
}

#[test]
fn only_id_title_status_due_and_priority_leave() {
    let rows = Rows(Default::default());
    let out: Value = serde_json::from_str(&call(&rows, json!({"status":"todo"})).unwrap()).unwrap();
    assert_eq!(
        out,
        json!({"items":[{"id":"11111111-1111-4111-8111-111111111111","title":"Pay rent",
            "status":"todo","dueAt":"2026-11-09T10:00:00.000Z","priority":3}]})
    );
    assert!(!out.to_string().contains("Secret body"));
}

#[test]
fn the_status_and_finished_after_time_become_filters() {
    let rows = Rows(Default::default());
    call(&rows, json!({"status":"done","completedAfter":"2026-11-10T10:00:00.000Z"})).unwrap();
    let queries = rows.0.borrow();
    let task_query = queries.iter().find(|(t, _)| t == "app.tasks").unwrap().1.to_string();
    assert!(task_query.contains("\"done\"") && task_query.contains("completed_at"), "{task_query}");
    assert!(task_query.contains("2026-11-10T10:00:00.000Z"), "{task_query}");
}

#[test]
fn another_status_or_an_unknown_field_is_refused() {
    let rows = Rows(Default::default());
    for bad in [
        json!({"status":"archived"}),
        json!({"status":"todo","ownerUserId":"someone-else"}),
        json!({}),
    ] {
        assert!(call(&rows, bad).is_err());
    }
    assert!(rows.0.borrow().is_empty(), "a refused call reads nothing");
}
