//! Screen text must never reach a failure message, a job payload or a log-shaped value.
mod common;
use common::*;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

const MARKER: &str = "PLANTED-SCREEN-MARKER-7f3a91";

/// Fails every store call with text that echoes the request it was given.
struct Leaky;
impl Host for Leaky {
    fn call(&self, _: &str, _: &str, _: &str, parameters: Value) -> Result<Value> {
        Err(Error::new(&format!("database said no to {parameters}")))
    }
}

/// Behaves like the fake but records everything bound for the job queue.
struct Spy(Fake, RefCell<Vec<Value>>);
impl Host for Spy {
    fn call(&self, p: &str, o: &str, r: &str, v: Value) -> Result<Value> {
        if p == "jobs" {
            self.1.borrow_mut().push(v.clone());
        }
        self.0.call(p, o, r, v)
    }
}

fn marked() -> Value {
    let mut s = segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", MARKER);
    s["windowTitle"] = json!(MARKER);
    s["address"] = json!(format!("https://example.test/{MARKER}"));
    json!({"sentAt": NOW, "segments": [s]})
}

#[test]
fn a_failing_host_never_puts_screen_text_in_the_response_or_the_error() {
    let r = moss_backtrack_module::route(&Leaky, request("POST", "/ingest", marked()));
    assert_eq!(r.status, 500);
    assert!(!r.body.to_string().contains(MARKER));
    let payload = json!({"method":"POST","path":"/ingest","params":{},"query":{},"body":marked()}).to_string();
    let out = moss_backtrack_module::handle(&Leaky, "route", &payload).unwrap();
    assert!(!out.contains(MARKER));
    let err = moss_backtrack_module::handle(&Leaky, "job", &format!("{{\"body\":\"{MARKER}\"}}")).unwrap_err();
    assert!(!err.to_string().contains(MARKER));
}

#[test]
fn a_stored_upload_queues_only_the_fixed_sweep_and_no_screen_text() {
    let spy = Spy(Fake::default(), RefCell::default());
    let r = moss_backtrack_module::route(&spy, request("POST", "/ingest", marked()));
    assert_eq!(r.status, 200);
    assert!(!r.body.to_string().contains(MARKER));
    let jobs = spy.1.borrow();
    assert!(!jobs.is_empty());
    for payload in jobs.iter() {
        assert!(!payload.to_string().contains(MARKER));
        assert_eq!(payload["params"], json!({}));
    }
}

#[test]
fn every_refusal_body_is_fixed_text() {
    for host in [Fake { paused: true, ..Fake::default() }, Fake { storage: false, ..Fake::default() }, Fake { link: json!({"link":"none"}), ..Fake::default() }] {
        let r = moss_backtrack_module::route(&host, request("POST", "/ingest", marked()));
        assert!(!r.body.to_string().contains(MARKER));
    }
    let r = moss_backtrack_module::route(&Fake::default(), request("POST", "/ingest", json!({"sentAt": MARKER, "segments": [], "x": MARKER})));
    assert!(!r.body.to_string().contains(MARKER));
}
