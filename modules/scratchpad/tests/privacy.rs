//! Note text must never reach a failure message or any other host port.
mod common;
use common::*;
use moss_module_sdk::{Error, Host, Result};
use moss_scratchpad_module::{handle, route};
use serde_json::{json, Value};
use std::cell::RefCell;

const MARKER: &str = "PLANTED-NOTE-MARKER-5c1e88";

/// Fails every store call with text that echoes the request.
struct Leaky;
impl Host for Leaky {
    fn call(&self, _: &str, _: &str, _: &str, parameters: Value) -> Result<Value> {
        Err(Error::new(&format!("database said no to {parameters}")))
    }
}

/// Behaves like the fake and records every port other than the store.
struct Spy(Fake, RefCell<Vec<(String, Value)>>);
impl Host for Spy {
    fn call(&self, p: &str, o: &str, r: &str, v: Value) -> Result<Value> {
        if p != "kv" {
            self.1.borrow_mut().push((p.into(), v.clone()));
        }
        self.0.call(p, o, r, v)
    }
}

#[test]
fn a_failing_host_never_puts_note_text_in_the_response_or_the_error() {
    for (method, path, body) in [
        ("PUT", "/note", json!({"body": MARKER, "revision": 0})),
        ("POST", "/append", json!({"text": MARKER})),
        ("PATCH", "/settings", json!({"shortcut": format!("mod+{MARKER}")})),
    ] {
        let r = route(&Leaky, request(method, path, body.clone()));
        assert!(r.status == 500 || r.status == 400, "{method} {path}");
        assert!(!r.body.to_string().contains(MARKER), "{method} {path}");
        let payload = json!({"method": method, "path": path, "params": {}, "query": {}, "body": body}).to_string();
        let out = handle(&Leaky, "route", &payload).unwrap();
        assert!(!out.contains(MARKER), "{method} {path}");
    }
    let err = handle(&Leaky, "other", &format!("{{\"body\":\"{MARKER}\"}}")).unwrap_err();
    assert!(!err.to_string().contains(MARKER));
}

#[test]
fn note_text_goes_only_to_the_store() {
    let spy = Spy(Fake::default(), RefCell::default());
    route(&spy, request("PUT", "/note", json!({"body": MARKER, "revision": 0})));
    route(&spy, request("POST", "/append", json!({"text": MARKER})));
    route(&spy, request("GET", "/note", json!(null)));
    assert!(spy.1.borrow().is_empty(), "a port other than the store was called");
}
