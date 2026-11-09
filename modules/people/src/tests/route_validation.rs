use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Preferences(RefCell<Value>);
impl Host for Preferences {
    fn call(&self, port: &str, operation: &str, resource: &str, value: Value) -> Result<Value> {
        if (port, operation, resource) == ("kv", "preference.write", "people-folder") {
            *self.0.borrow_mut() = value["folder"].clone();
            return Ok(value);
        }
        Err(Error::new("A rejected body must not reach host services"))
    }
}

#[test]
fn get_ignores_json_bodies_like_the_legacy_bodyless_route() {
    struct ReadOnly;
    impl Host for ReadOnly {
        fn call(&self, port: &str, operation: &str, resource: &str, _: Value) -> Result<Value> {
            assert_eq!(
                (port, operation, resource),
                ("db", "query", "app.person_context_people")
            );
            Ok(json!([]))
        }
    }
    let reply = moss_people::guest::handle(
        &ReadOnly,
        "route",
        &json!({
            "method":"GET","path":"/people","params":{},"query":{},
            "body":{"__proto__":null}
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&reply).unwrap(),
        json!({
            "status":200,"body":{"people":[]}
        })
    );
}

#[test]
fn forbidden_json_keys_are_rejected_before_schema_coercion_or_host_effects() {
    struct NoEffects;
    impl Host for NoEffects {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
            panic!("A rejected JSON body must not call the host")
        }
    }
    for raw in [
        r#"{"__proto__":null}"#,
        r#"{"constructor":{"prototype":false}}"#,
        r#"{"extra":[{"nested":{"__proto__":{}}}]}"#,
        r#"{"aliases":[{"constructor":{"prototype":null}}]}"#,
        r#"[{"__proto__":true}]"#,
        r#"{"folder":"Work","extra":{"__proto__":{}}}"#,
    ] {
        let body: Value = serde_json::from_str(raw).unwrap();
        for (method, path) in [
            ("POST", "/people"),
            ("PATCH", "/people/:id"),
            ("PUT", "/people/notes-settings"),
            ("POST", "/people/:id/archive"),
        ] {
            let reply = moss_people::guest::handle(
                &NoEffects,
                "route",
                &json!({"method":method,"path":path,"params":{"id":"person"},"query":{},"body":body}).to_string(),
            ).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&reply).unwrap(),
                json!({
                    "status":400,"body":{"error":"Body is not valid JSON but content-type is set to 'application/json'"}
                }),
                "{method} {path} {raw}"
            );
        }
    }
}

#[test]
fn ordinary_constructor_and_prototype_members_and_strings_remain_allowed() {
    let host = Preferences(RefCell::new(Value::Null));
    for raw in [
        r#"{"constructor":null}"#,
        r#"{"constructor":false}"#,
        r#"{"constructor":"prototype"}"#,
        r#"{"constructor":[]}"#,
        r#"{"constructor":{"name":"prototype"}}"#,
        r#"{"prototype":{}}"#,
        r#"{"text":"__proto__"}"#,
        r#"{"Constructor":{"prototype":true},"__Proto__":true}"#,
    ] {
        let mut body: Value = serde_json::from_str(raw).unwrap();
        body["folder"] = json!("Work");
        let reply = moss_people::guest::handle(
            &host,
            "route",
            &json!({
                "method":"PUT","path":"/people/notes-settings","params":{},"query":{},"body":body
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap()["status"],
            200,
            "{raw}"
        );
        assert_eq!(*host.0.borrow(), json!("Work"));
    }
}

#[test]
fn forbidden_folder_body_keeps_the_saved_preference() {
    let host = Preferences(RefCell::new(json!("Previous folder")));
    let reply = moss_people::guest::handle(
        &host,
        "route",
        &json!({
            "method":"PUT","path":"/people/notes-settings","params":{},"query":{},
            "body":{"folder":"Work","extra":{"__proto__":null}}
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(*host.0.borrow(), json!("Previous folder"));
    assert_eq!(
        serde_json::from_str::<Value>(&reply).unwrap()["status"],
        400
    );
}

#[test]
fn root_arrays_are_rejected_without_clearing_the_saved_folder() {
    let host = Preferences(RefCell::new(json!("Previous folder")));
    for (method, path, body) in [
        ("PUT", "/people/notes-settings", json!([{"folder":"Work"}])),
        ("POST", "/people", json!([{"displayName":"Root array"}])),
        (
            "PATCH",
            "/people/:id",
            json!([{"displayName":"Root array"}]),
        ),
    ] {
        let reply = moss_people::guest::handle(
            &host,
            "route",
            &json!({
                "method":method,"path":path,"params":{"id":"person"},"query":{},"body":body
            })
            .to_string(),
        )
        .unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(
            reply,
            json!({"status":400,"body":{"error":"body must be object"}}),
            "{method} {path}; saved folder after request: {}",
            host.0.borrow()
        );
        assert_eq!(*host.0.borrow(), json!("Previous folder"));
    }
}

#[test]
fn empty_and_null_folder_saves_are_refused_without_clearing_the_preference() {
    let host = Preferences(RefCell::new(json!("Previous folder")));
    for folder in [json!(""), Value::Null] {
        let reply = moss_people::guest::handle(
            &host,
            "route",
            &json!({"method":"PUT","path":"/people/notes-settings","params":{},"query":{},"body":{"folder":folder}}).to_string(),
        ).unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(
            reply,
            json!({"status":400,"body":{"error":"People notes folder is unavailable"}})
        );
        assert_eq!(*host.0.borrow(), json!("Previous folder"));
    }
}
