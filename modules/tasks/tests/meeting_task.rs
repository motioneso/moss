//! Public `createMeetingTask`: one task per accepted meeting action, however often it is asked.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::sync::Mutex;

const STAMP: &str = "2026-11-12T00:00:00.000Z";

#[derive(Default)]
struct Store(Mutex<Vec<Value>>);

impl Host for Store {
    fn call(&self, port: &str, operation: &str, table: &str, query: Value) -> Result<Value> {
        match (port, operation, table) {
            ("context", "read", _) => Ok(json!({"now":STAMP})),
            ("db", "query", "app.task_lists") => Ok(json!([{"id":"list","owner_user_id":"o",
                "name":"Personal","position":0,"created_at":STAMP,"updated_at":STAMP}])),
            ("db", "query", "app.tasks") => {
                let mut rows = self.0.lock().unwrap();
                if query["kind"] == "insert" {
                    let mut row = json!({"id":format!("t{}", rows.len()),"owner_user_id":"o",
                        "parent_task_id":null,"description":null,"priority":null,"position":0,
                        "do_at":null,"effort":null,"completed_at":null,"suggestion_metadata":null,
                        "recurrence":null,"recurrence_series_id":null,"created_at":STAMP,
                        "updated_at":STAMP});
                    for (k, v) in query["values"].as_object().unwrap() {
                        row[k] = v.clone();
                    }
                    rows.push(row.clone());
                    return Ok(json!([row]));
                }
                let text = query.to_string();
                Ok(json!(rows
                    .iter()
                    .filter(|r| text.contains(r["external_key"].as_str().unwrap_or("\u{0}")))
                    .collect::<Vec<_>>()))
            }
            other => panic!("unexpected call {other:?}"),
        }
    }
}

fn call(host: &Store, key: &str) -> Value {
    let request = json!({"name":"createMeetingTask","parameters":{"title":"Send the deck",
        "dueAt":null,"sourceRef":"m1","externalKey":key}});
    serde_json::from_str(&moss_tasks_module::handle(host, "api", &request.to_string()).unwrap())
        .unwrap()
}

#[test]
fn a_repeated_key_returns_the_first_task_and_adds_no_second() {
    let host = Store::default();
    let first = call(&host, "meeting:m1:candidate:c1");
    let again = call(&host, "meeting:m1:candidate:c1");
    assert_eq!(first, again);
    assert_eq!(host.0.lock().unwrap().len(), 1);
    let other = call(&host, "meeting:m1:candidate:c2");
    assert_ne!(first, other);
    assert_eq!(host.0.lock().unwrap().len(), 2);
    let row = host.0.lock().unwrap()[0].clone();
    assert_eq!((row["source"].as_str(), row["source_ref"].as_str()), (Some("meeting"), Some("m1")));
}
