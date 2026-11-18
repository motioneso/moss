//! Legacy Fastify validation/coercion at the guest boundary. Real handlers and
//! saved revisions are compared by the installed Settings database oracle.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

#[derive(Default)]
struct Folder(RefCell<Vec<Value>>);
impl Host for Folder {
    fn call(&self, port: &str, op: &str, resource: &str, params: Value) -> Result<Value> {
        if (port, op) == ("jobs", "schedule") {
            return Ok(json!({}));
        }
        assert_eq!((port, resource), ("vault", "source"));
        assert!(matches!(op, "folder.set" | "folder.list"));
        self.0.borrow_mut().push(params.clone());
        Ok(json!({"status":200,"body":params}))
    }
}
fn route(host: &Folder, method: &str, path: &str, body: Value, query: Value) -> Value {
    serde_json::from_str(
        &moss_notes::routes::handle(
            host,
            &json!({"method":method,"path":path,"body":body,"query":query}).to_string(),
        )
        .unwrap(),
    )
    .unwrap()
}
fn validation(message: &str) -> Value {
    json!({"status":400,"body":{"error":message}})
}
#[test]
fn input_matches_actual_legacy_fastify_schemas() {
    for line in include_str!("settings-input-vectors.jsonl").lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let host = Folder::default();
        let out: Value = serde_json::from_str(
            &moss_notes::routes::handle(&host, &case["request"].to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(out, case["expected"], "{case}");
        if out["status"] == 400 {
            assert!(host.0.borrow().is_empty());
        }
    }
}
#[test]
fn validation_errors_do_not_reach_preferences_or_files() {
    let host = Folder::default();
    for body in [
        json!(42),
        json!(true),
        json!("invalid"),
        json!([]),
        json!([null]),
        json!([{}]),
    ] {
        assert_eq!(
            route(&host, "PUT", "/notes-source", body, json!({})),
            validation("body must be object,null")
        );
    }
    for path in [json!({}), json!([]), json!(["/notes"]), json!(["a", "b"])] {
        assert_eq!(
            route(
                &host,
                "PUT",
                "/notes-source",
                json!({"path":path}),
                json!({})
            ),
            validation("body/path must be string,null")
        );
    }
    assert_eq!(
        route(
            &host,
            "GET",
            "/notes-source/directories",
            Value::Null,
            json!({"path":["a","b"]})
        ),
        validation("querystring/path must be string")
    );
    assert!(host.0.borrow().is_empty());
}
#[test]
fn legacy_scalar_coercion_and_ignored_fields_stay_account_bound() {
    let host = Folder::default();
    for body in [
        json!(false),
        json!(0),
        json!(""),
        json!([false]),
        json!([0]),
        json!([""]),
        json!({"actorUserId":"other"}),
    ] {
        assert_eq!(
            route(&host, "PUT", "/notes-source", body, json!({})),
            json!({"status":200,"body":{"path":null}})
        );
    }
    for (path, expected) in [
        (json!(42), json!("42")),
        (json!(false), json!("false")),
        (json!(true), json!("true")),
        (json!([null]), json!("")),
        (json!([false]), json!("false")),
        (json!([0]), json!("0")),
        (json!([""]), Value::Null),
    ] {
        assert_eq!(
            route(
                &host,
                "PUT",
                "/notes-source",
                json!({"path":path,"actorUserId":"other"}),
                json!({})
            ),
            json!({"status":200,"body":{"path":expected}})
        );
    }
    assert_eq!(
        route(
            &host,
            "GET",
            "/notes-source/directories",
            Value::Null,
            json!({"path":"/notes","actorUserId":"other"})
        ),
        json!({"status":200,"body":{"path":"/notes"}})
    );
}
