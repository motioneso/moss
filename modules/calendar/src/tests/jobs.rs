use moss_calendar::handle;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

/// Records every host call. `visible` is whether the scoped read can see the event.
struct Scoped {
    visible: bool,
    calls: RefCell<Vec<(String, String, String, Value)>>,
}
impl Host for Scoped {
    fn call(&self, port: &str, op: &str, resource: &str, body: Value) -> Result<Value> {
        self.calls
            .borrow_mut()
            .push((port.into(), op.into(), resource.into(), body.clone()));
        match (port, op) {
            ("db", "query") if body["kind"] == "delete" => Ok(json!([{"id":"e1"}])),
            ("db", "query") if self.visible => Ok(json!([{"id":"e1"}])),
            ("db", "query") => Ok(json!([])),
            _ => panic!("unexpected host call {port}.{op}"),
        }
    }
}
fn job(id: &str) -> String {
    json!({"queue":"calendar-cache-evict-event","parameters":{"target-item-id":id}}).to_string()
}

#[test]
fn evict_job_deletes_a_visible_event() {
    let host = Scoped {
        visible: true,
        calls: RefCell::default(),
    };
    let out: Value = serde_json::from_str(&handle(&host, "job", &job("e1")).unwrap()).unwrap();
    assert_eq!(out, json!({"evicted":true}));
    let calls = host.calls.borrow();
    let delete = calls
        .iter()
        .find(|c| c.3["kind"] == "delete")
        .expect("delete call");
    assert_eq!(delete.2, "app.calendar_events");
}

#[test]
fn evict_job_never_deletes_an_event_the_actor_cannot_see() {
    let host = Scoped {
        visible: false,
        calls: RefCell::default(),
    };
    let out: Value = serde_json::from_str(&handle(&host, "job", &job("e1")).unwrap()).unwrap();
    assert_eq!(out, json!({"evicted":false}));
    assert!(host.calls.borrow().iter().all(|c| c.3["kind"] != "delete"));
}

#[test]
fn evict_job_rejects_unknown_queue_and_extra_fields() {
    let host = Scoped {
        visible: true,
        calls: RefCell::default(),
    };
    let bad_queue = json!({"queue":"other","parameters":{"target-item-id":"e1"}}).to_string();
    assert!(handle(&host, "job", &bad_queue).is_err());
    let extra = json!({"queue":"calendar-cache-evict-event",
        "parameters":{"target-item-id":"e1","owner":"x"}})
    .to_string();
    assert!(handle(&host, "job", &extra).is_err());
    assert!(host.calls.borrow().is_empty());
}
