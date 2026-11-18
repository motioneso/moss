use moss_module_sdk::{Host, RouteRequest};
use serde_json::{json, Value};

struct NoEffects;
impl Host for NoEffects {
    fn call(&self, _: &str, _: &str, _: &str, _: Value) -> moss_module_sdk::Result<Value> {
        Err(moss_module_sdk::Error::new(
            "Schema must reject before effects",
        ))
    }
}

#[test]
fn route_schemas_reject_invalid_requests_before_effects() {
    for (method, path, body, message) in [
        ("POST", "/tasks", json!({}), "body must have required property 'title'"),
        ("POST", "/tasks", json!({"title":"x","priority":6}), "body/priority must be <= 5, body/priority must be null, body/priority must match a schema in anyOf"),
        ("PATCH", "/tasks/:id", json!({"status":"invalid"}), "body/status must be equal to one of the allowed values"),
        ("POST", "/tasks/:id/tags", json!({}), "body must have required property 'tagId'"),
        ("PATCH", "/tasks/preferences", json!({}), "body must have required property 'defaultView'"),
        ("POST", "/tasks/lists", json!([]), "body must be object"),
    ] {
        let request: RouteRequest = serde_json::from_value(json!({
            "method":method,"path":path,"params":{"id":"test"},"query":{},"body":body
        })).unwrap();
        let response = moss_tasks_module::routes::handle(&NoEffects, request);
        assert_eq!(response.status, 400, "{method} {path}");
        assert_eq!(response.body, json!({"error":message}), "{method} {path}");
    }
}
