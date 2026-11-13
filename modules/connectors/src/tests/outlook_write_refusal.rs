//! Calendar creation when the Outlook copy cannot be trusted. Ported from the old write tests.
use moss_connectors::handle;
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

const SCOPE: &str = "https://www.googleapis.com/auth/calendar";

struct Script {
    outlook: Value,
    log: RefCell<Vec<String>>,
}

impl Host for Script {
    fn call(&self, port: &str, operation: &str, resource: &str, _: Value) -> Result<Value> {
        self.log.borrow_mut().push(format!("{port}.{operation}.{resource}"));
        Ok(match (port, operation, resource) {
            ("context", "read", _) => json!({"now":"2026-10-21T18:00:00.000Z"}),
            ("kv", "get", "connectors.context-setup") => json!({
                "accounts":[
                    {"id":"g1","providerId":"google","status":"active","scopes":[SCOPE]},
                    {"id":"o1","providerId":"outlook-browser-calendar","status":"active","scopes":["calendar.readonly"]}],
                "grants":{"g1":{"calendar":true},"o1":{"calendar":true}},
                "outlook":{"o1":self.outlook.clone()},
            }),
            ("kv", "set", "connectors.write-calendar-freebusy") => json!({"result":"ok","busy":[]}),
            ("kv", "set", "connectors.write-calendar-insert") => json!({"result":"ok","created":true}),
            ("api", _, "calendar") => json!({"events":[],"id":"cached"}),
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn health(state: &str, last: &str) -> Value {
    json!({"state":state,"lastCompleteAt":last,"timeZone":"America/Los_Angeles",
           "windowStart":"2026-10-21","windowEnd":"2026-10-22","unconfirmed":0})
}

fn create(outlook: Value) -> (Value, Vec<String>) {
    let host = Script { outlook, log: RefCell::default() };
    let input = json!({"name":"createCalendarEvent","parameters":{
        "windowStart":"2026-10-22T05:30:00.000Z","windowEnd":"2026-10-22T06:00:00.000Z",
        "durationMinutes":30,"title":"Invented block"}});
    let reply = handle(&host, "api", &input.to_string()).unwrap();
    let log = host.log.borrow().clone();
    (serde_json::from_str(&reply).unwrap(), log)
}

fn touched_google(log: &[String]) -> bool {
    log.iter().any(|c| c.contains("write-calendar"))
}

#[test]
fn a_stale_partial_or_uncovered_copy_refuses_before_any_google_call() {
    let cases = [
        health("partial", "2026-10-21T18:00:00.000Z"),
        health("current", "2026-10-21T17:40:00.000Z"),
        {
            let mut h = health("current", "2026-10-21T18:00:00.000Z");
            h["windowStart"] = json!("2026-10-22");
            h
        },
    ];
    for outlook in cases {
        let (reply, log) = create(outlook.clone());
        assert_eq!(reply["created"], false, "{outlook}");
        assert!(reply["message"].as_str().unwrap().contains("availability needs verification"));
        assert!(!touched_google(&log), "{log:?}");
    }
}

#[test]
fn a_fresh_complete_copy_lets_the_event_through() {
    let (reply, log) = create(health("current", "2026-10-21T18:00:00.000Z"));
    assert_eq!(reply["created"], true);
    assert!(touched_google(&log));
}
