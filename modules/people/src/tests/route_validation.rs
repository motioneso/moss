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
