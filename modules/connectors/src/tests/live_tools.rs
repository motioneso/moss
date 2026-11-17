//! Live read tools: one active Google account, grant check, plain failures, capped bodies.
use moss_connectors::live_tools::{events, message, search};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Script {
    accounts: Value,
    grants: Value,
    live: Value,
    calls: RefCell<Vec<(String, Value)>>,
}

impl Host for Script {
    fn call(&self, port: &str, _: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push((resource.to_string(), p));
        Ok(match (port, resource) {
            ("context", _) => json!({"now":"2026-03-02T08:00:00.000Z"}),
            ("kv", "connectors.context-setup") => json!({"accounts":self.accounts,"grants":self.grants}),
            ("kv", _) => self.live.clone(),
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn host(live: Value) -> Script {
    Script {
        accounts: json!([
            {"id":"old","providerId":"google","status":"revoked"},
            {"id":"g1","providerId":"google","status":"active"},
            {"id":"g2","providerId":"google","status":"active"}]),
        grants: json!({}),
        live,
        calls: RefCell::default(),
    }
}

#[test]
fn search_uses_the_first_active_google_account_and_clamps_the_limit() {
    let h = host(json!({"messages":[{"id":"m"}],"skipped":1}));
    let out = search(&h, &json!({"limit":500,"query":"  from:ann "})).unwrap();
    assert_eq!(out["data"]["messages"][0]["id"], "m");
    let calls = h.calls.borrow();
    let read = calls.iter().find(|c| c.0 == "connectors.live-gmail-list").unwrap();
    assert_eq!(read.1, json!({"accountId":"g1","limit":20,"query":"from:ann"}));
}

#[test]
fn a_switched_off_feature_answers_with_the_refusal_and_reads_nothing() {
    let mut h = host(json!({}));
    h.grants = json!({"g1":{"email":false}});
    let out = search(&h, &json!({})).unwrap();
    assert_eq!(out["data"]["code"], "CONNECTOR_FEATURE_GRANT_DISABLED");
    assert!(h.calls.borrow().iter().all(|c| !c.0.starts_with("connectors.live-")));
}

#[test]
fn no_active_account_or_a_sign_in_failure_asks_to_connect_google() {
    let mut h = host(json!({"result":"auth_failed"}));
    assert_eq!(message(&h, &json!({"id":"m"})).unwrap_err().message, "Connect Google in Settings first.");
    h.accounts = json!([]);
    assert_eq!(search(&h, &json!({})).unwrap_err().message, "Connect Google in Settings first.");
}

#[test]
fn a_failed_read_gives_a_plain_message_without_the_reason() {
    let h = host(json!({"result":"failed","error":{"status":500,"reason":"SECRET-REASON"}}));
    let error = search(&h, &json!({})).unwrap_err();
    assert!(!error.message.contains("SECRET"));
}

#[test]
fn a_message_needs_an_id_and_its_body_is_capped() {
    let h = host(json!({"message":{"id":"m","bodyText":"x".repeat(20000)}}));
    assert_eq!(message(&h, &json!({})).unwrap_err().status, 400);
    let out = message(&h, &json!({"id":"m"})).unwrap();
    assert_eq!(out["data"]["message"]["bodyText"].as_str().unwrap().len(), 12000);
}

#[test]
fn events_default_to_a_fourteen_day_window_and_keep_the_old_fields() {
    let live = json!({"events":[{"externalId":"e1","event":{"title":"Lunch","startsAt":"a","endsAt":"b",
        "location":null,"externalMetadata":{"htmlLink":"L","status":"confirmed","attendeeCount":3}}}]});
    let h = host(live);
    let out = events(&h, &json!({})).unwrap();
    assert_eq!(out["data"]["events"][0], json!({"id":"e1","title":"Lunch","startsAt":"a","endsAt":"b",
        "location":null,"htmlLink":"L","status":"confirmed","attendeeCount":3}));
    let calls = h.calls.borrow();
    let read = calls.iter().find(|c| c.0 == "connectors.live-calendar").unwrap();
    assert_eq!(read.1["timeMin"], "2026-03-02T08:00:00.000Z");
    assert_eq!(read.1["timeMax"], "2026-03-16T08:00:00.000Z");
}
