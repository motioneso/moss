use moss_email::{handle, testing::Fake};
use serde_json::{json, Value};

fn call(host: &Fake, method: &str, path: &str, id: Option<&str>, body: Value) -> (u64, Value) {
    let request = json!({"method":method,"path":path,"params":id.map(|i| json!({"id":i})).unwrap_or(json!({})),"body":body});
    let reply: Value = serde_json::from_str(&handle(host, "route", &request.to_string()).unwrap()).unwrap();
    (reply["status"].as_u64().unwrap(), reply["body"].clone())
}

#[test]
fn list_and_detail_return_messages_and_404_for_absent() {
    let host = Fake::default().with_message("m1", "Hello");
    let (status, body) = call(&host, "GET", "/messages", None, Value::Null);
    assert_eq!(status, 200);
    assert_eq!(body["messages"][0]["subject"], "Hello");
    let (status, body) = call(&host, "GET", "/messages/:id", Some("m1"), Value::Null);
    assert_eq!((status, body["message"]["id"].clone()), (200, json!("m1")));
    let (status, body) = call(&host, "GET", "/messages/:id", Some("hidden"), Value::Null);
    assert_eq!((status, body), (404, json!({"error":"Email message not found"})));
}
#[test]
fn briefing_defaults_apply_when_nothing_is_stored() {
    let host = Fake::default();
    let (_, body) = call(&host, "GET", "/briefing-settings", None, Value::Null);
    assert_eq!(body, json!({"settings":{"createTasks":true,"suggestReplies":true,"draftReplies":true,"autoSend":false}}));
    let (_, body) = call(&host, "GET", "/task-creation-mode", None, Value::Null);
    assert_eq!(body, json!({"mode":"suggest"}));
    let (_, body) = call(&host, "GET", "/briefing-source", None, Value::Null);
    assert_eq!(body, json!({"enabled":true}));
    let (_, body) = call(&host, "GET", "/draft-policy", None, Value::Null);
    assert_eq!(body, json!({"tier":"ask_each_time"}));
}
#[test]
fn patch_writes_only_named_fields_and_returns_all_four() {
    let host = Fake::default();
    let (status, body) = call(&host, "PATCH", "/briefing-settings", None, json!({"autoSend":true,"createTasks":false,"extra":1}));
    assert_eq!(status, 200);
    assert_eq!(body["settings"], json!({"createTasks":false,"suggestReplies":true,"draftReplies":true,"autoSend":true}));
    let writes = host.writes.borrow();
    assert_eq!(writes.len(), 1);
    assert!(writes[0]["parameters"]["values"].get("extra").is_none());
}
#[test]
fn bad_bodies_are_400_and_write_nothing() {
    let host = Fake::default();
    assert_eq!(call(&host, "PUT", "/task-creation-mode", None, json!({"mode":"loud"})).0, 400);
    assert_eq!(call(&host, "PUT", "/task-creation-mode", None, json!({})).0, 400);
    assert_eq!(call(&host, "PATCH", "/briefing-settings", None, json!({"autoSend":"maybe"})).0, 400);
    assert_eq!(call(&host, "PATCH", "/briefing-settings", None, Value::Null).0, 400);
    assert_eq!(call(&host, "PUT", "/draft-policy", None, json!({"tier":"yolo"})).0, 400);
    assert!(host.writes.borrow().is_empty());
}
#[test]
fn stored_values_round_trip() {
    let host = Fake::default();
    assert_eq!(call(&host, "PUT", "/task-creation-mode", None, json!({"mode":"auto_safe"})), (200, json!({"mode":"auto_safe"})));
    assert_eq!(call(&host, "GET", "/task-creation-mode", None, Value::Null).1, json!({"mode":"auto_safe"}));
    call(&host, "PUT", "/briefing-source", None, json!({"enabled":false}));
    assert_eq!(call(&host, "GET", "/briefing-source", None, Value::Null).1, json!({"enabled":false}));
    call(&host, "PUT", "/draft-policy", None, json!({"tier":"trusted_auto"}));
    assert_eq!(call(&host, "GET", "/draft-policy", None, Value::Null).1, json!({"tier":"trusted_auto"}));
}
#[test]
fn a_garbage_stored_mode_reads_as_the_default() {
    let host = Fake::default().with_preference("email.task_creation_mode", json!("nonsense"));
    assert_eq!(call(&host, "GET", "/task-creation-mode", None, Value::Null).1, json!({"mode":"suggest"}));
}
#[test]
fn a_host_failure_becomes_a_scrubbed_500() {
    let mut host = Fake::default();
    host.failing = true;
    assert_eq!(call(&host, "GET", "/messages", None, Value::Null), (500, json!({"error":"Internal server error"})));
}
#[test]
fn unknown_routes_are_404() {
    assert_eq!(call(&Fake::default(), "GET", "/nothing", None, Value::Null).0, 404);
}
