//! Calendar context: live first, cache only for transient failures, gaps for the rest.
use moss_connectors::calendar_context::{degraded_reason, flags, list};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;
use chrono_tz::UTC;

const GOOGLE_SCOPES: [&str; 2] = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar"];

struct Script {
    setup: Value,
    /// Live answer per account id.
    live: Value,
    cache: Vec<Value>,
    calls: RefCell<Vec<String>>,
}

impl Host for Script {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push(format!("{port}.{resource}"));
        Ok(match (port, operation, resource) {
            ("context", "read", _) => json!({"now":"2026-03-02T08:00:00.000Z"}),
            ("kv", "get", "connectors.context-setup") => self.setup.clone(),
            ("kv", "get", "connectors.live-calendar") => self.live[p["accountId"].as_str().unwrap()].clone(),
            ("api", _, "calendar") => json!({"events":self.cache}),
            _ => return Err(Error::new("unexpected call")),
        })
    }
}

fn account(id: &str, provider: &str, kind: &str, status: &str, scopes: &[&str]) -> Value {
    json!({"id":id,"providerId":provider,"providerType":kind,"providerDisplayName":provider,
           "status":status,"scopes":scopes,"lastSyncFinishedAt":"2026-03-02T07:00:00.000Z"})
}

fn live_event(id: &str, start: &str, end: &str, attendees: u64, place: Option<&str>) -> Value {
    json!({"externalId":id,"event":{"title":id,"startsAt":start,"endsAt":end,"location":place,
           "externalMetadata":{"attendeeCount":attendees,"allDay":false}}})
}

fn cached(id: &str, account: &str, start: &str, end: &str) -> Value {
    json!({"externalId":id,"connectorAccountId":account,"title":id,"startsAt":start,"endsAt":end,
           "location":null,"attendeeCount":0,"allDay":false})
}

fn script(accounts: Vec<Value>, live: Value, cache: Vec<Value>) -> Script {
    Script {
        setup: json!({"accounts":accounts,"grants":{},"outlook":{},"timezone":"UTC"}),
        live,
        cache,
        calls: RefCell::default(),
    }
}

#[test]
fn a_live_read_is_marked_live_with_the_read_time() {
    let host = script(
        vec![account("g1", "google", "google", "active", &GOOGLE_SCOPES)],
        json!({"g1":{"events":[live_event("e1", "2026-03-02T10:00:00.000Z", "2026-03-02T11:00:00.000Z", 3, Some("Room 4"))]}}),
        vec![],
    );
    let out = list(&host, &json!({})).unwrap();
    assert_eq!(out["items"][0]["source"], "live");
    assert_eq!(out["items"][0]["flags"], json!(["has_location", "prep_attendees"]));
    assert_eq!(out["accounts"][0]["asOf"], "2026-03-02T08:00:00.000Z");
    assert_eq!(out["asOf"], "2026-03-02T08:00:00.000Z");
    assert!(!host.calls.borrow().iter().any(|c| c == "api.calendar"), "live success never reads the cache");
}

#[test]
fn a_transient_failure_serves_that_accounts_cache_and_names_why() {
    let host = script(
        vec![
            account("g1", "google", "google", "active", &GOOGLE_SCOPES),
            account("g2", "google", "google", "active", &GOOGLE_SCOPES),
        ],
        json!({"g1":{"result":"failed","error":{"status":503,"reason":null}},
               "g2":{"events":[live_event("live2", "2026-03-02T12:00:00.000Z", "2026-03-02T13:00:00.000Z", 0, None)]}}),
        vec![
            cached("c1", "g1", "2026-03-02T09:00:00.000Z", "2026-03-02T09:30:00.000Z"),
            cached("other", "g2", "2026-03-02T09:00:00.000Z", "2026-03-02T09:30:00.000Z"),
        ],
    );
    let out = list(&host, &json!({})).unwrap();
    let keys: Vec<&str> = out["items"].as_array().unwrap().iter().map(|i| i["eventKey"].as_str().unwrap()).collect();
    assert_eq!(keys, ["c1", "live2"]);
    assert_eq!(out["items"][0]["source"], "cache");
    assert_eq!(out["items"][0]["degradedReason"], "provider_error");
    assert_eq!(out["accounts"][0]["asOf"], "2026-03-02T07:00:00.000Z");
    assert_eq!(out["asOf"], "2026-03-02T07:00:00.000Z");
}

#[test]
fn a_sign_in_failure_is_a_gap_and_never_the_cache() {
    let host = script(
        vec![account("g1", "google", "google", "active", &GOOGLE_SCOPES)],
        json!({"g1":{"result":"auth_failed","error":{"status":401,"reason":null}}}),
        vec![cached("c1", "g1", "2026-03-02T09:00:00.000Z", "2026-03-02T09:30:00.000Z")],
    );
    let out = list(&host, &json!({})).unwrap();
    assert_eq!(out["items"], json!([]));
    assert_eq!(out["gaps"][0]["reason"], "auth_error");
    assert!(!host.calls.borrow().iter().any(|c| c == "api.calendar"));
}

#[test]
fn revoked_disabled_unsupported_and_inactive_accounts_become_gaps_without_a_read() {
    let mut setup_grants = json!({"g2":{"calendar":false,"email":true}});
    let host = Script {
        setup: json!({"accounts":[
            account("g1", "google", "google", "revoked", &GOOGLE_SCOPES),
            account("g2", "google", "google", "active", &GOOGLE_SCOPES),
            account("g3", "google", "google", "error", &GOOGLE_SCOPES),
            account("g4", "other-cal", "caldav", "active", &["calendar"]),
            account("g5", "imap-fastmail", "imap", "active", &["email.read"]),
        ],"grants":setup_grants.take(),"outlook":{},"timezone":"UTC"}),
        live: json!({}),
        cache: vec![],
        calls: RefCell::default(),
    };
    let out = list(&host, &json!({})).unwrap();
    let reasons: Vec<&str> = out["gaps"].as_array().unwrap().iter().map(|g| g["reason"].as_str().unwrap()).collect();
    assert_eq!(reasons, ["connector_revoked", "feature_grant_disabled", "auth_error", "unsupported_provider"]);
    assert!(!host.calls.borrow().iter().any(|c| c.contains("live-calendar")), "no provider read for a gap");
}

#[test]
fn no_calendar_account_gives_an_empty_answer() {
    let host = script(vec![account("m1", "imap-fastmail", "imap", "active", &["email.read"])], json!({}), vec![]);
    let out = list(&host, &json!({})).unwrap();
    assert_eq!(out, json!({"items":[],"accounts":[],"gaps":[],"truncated":false,"asOf":null}));
}

#[test]
fn an_unknown_account_time_makes_the_whole_answer_unknown() {
    let mut stale = account("g1", "google", "google", "active", &GOOGLE_SCOPES);
    stale["lastSyncFinishedAt"] = Value::Null;
    let host = script(
        vec![stale, account("g2", "google", "google", "active", &GOOGLE_SCOPES)],
        json!({"g1":{"result":"failed","error":{"status":429}},"g2":{"events":[]}}),
        vec![],
    );
    let out = list(&host, &json!({})).unwrap();
    assert_eq!(out["accounts"][0]["degradedReason"], "rate_limited");
    assert_eq!(out["asOf"], Value::Null);
}

#[test]
fn events_already_over_or_past_the_window_and_routine_banners_are_dropped() {
    let mut banner = live_event("banner", "2026-03-02T08:00:00.000Z", "2026-03-04T08:00:00.000Z", 0, None);
    banner["event"]["externalMetadata"]["allDay"] = json!(true);
    let host = script(
        vec![account("g1", "google", "google", "active", &GOOGLE_SCOPES)],
        json!({"g1":{"events":[
            live_event("over", "2026-03-02T06:00:00.000Z", "2026-03-02T07:00:00.000Z", 0, None),
            live_event("late", "2026-03-04T08:00:00.000Z", "2026-03-04T09:00:00.000Z", 0, None),
            live_event("running", "2026-03-02T07:30:00.000Z", "2026-03-02T08:30:00.000Z", 0, None),
            banner]}}),
        vec![],
    );
    let out = list(&host, &json!({"windowEnd":"2026-03-04T08:00:00.000Z"})).unwrap();
    let keys: Vec<&str> = out["items"].as_array().unwrap().iter().map(|i| i["eventKey"].as_str().unwrap()).collect();
    assert_eq!(keys, ["running"]);
}

#[test]
fn the_limit_caps_items_and_says_so() {
    let events: Vec<Value> = (0..4)
        .map(|n| live_event(&format!("e{n}"), &format!("2026-03-02T1{n}:00:00.000Z"), &format!("2026-03-02T1{n}:30:00.000Z"), 0, None))
        .collect();
    let host = script(
        vec![account("g1", "google", "google", "active", &GOOGLE_SCOPES)],
        json!({"g1":{"events":events}}),
        vec![],
    );
    let out = list(&host, &json!({"limit":2})).unwrap();
    assert_eq!(out["items"].as_array().unwrap().len(), 2);
    assert_eq!(out["truncated"], true);
}

#[test]
fn outlook_reads_the_cache_and_is_fresh_only_within_fifteen_minutes() {
    let outlook = account("o1", "outlook-browser-calendar", "calendar", "active", &["calendar.readonly"]);
    let mut host = script(
        vec![outlook],
        json!({}),
        vec![cached("c1", "o1", "2026-03-02T09:00:00.000Z", "2026-03-02T09:30:00.000Z")],
    );
    host.setup["outlook"] = json!({"o1":{"state":"current","lastCompleteAt":"2026-03-02T07:50:00.000Z"}});
    let fresh = list(&host, &json!({})).unwrap();
    assert_eq!(fresh["items"][0]["degradedReason"], Value::Null);
    assert_eq!(fresh["gaps"], json!([]));
    host.setup["outlook"] = json!({"o1":{"state":"current","lastCompleteAt":"2026-03-02T07:40:00.000Z"}});
    let stale = list(&host, &json!({})).unwrap();
    assert_eq!(stale["items"][0]["degradedReason"], "source_stale");
    assert_eq!(stale["gaps"][0]["reason"], "service_unavailable");
}

#[test]
fn failures_classify_the_way_the_old_server_did() {
    let cases = [
        (json!({"result":"failed","error":{"status":429}}), Some("rate_limited")),
        (json!({"result":"failed","error":{"status":500}}), Some("provider_error")),
        (json!({"result":"failed","error":{"status":404}}), Some("provider_error")),
        (json!({"result":"failed","error":{"status":403}}), None),
        (json!({"result":"auth_failed","error":{}}), None),
        (json!({"result":"failed","error":{"status":null,"reason":"timeout"}}), Some("timeout")),
        (json!({"result":"failed","error":{"status":null,"reason":null}}), Some("network_error")),
        (json!({"result":"failed","error":{"status":200,"reason":null}}), Some("internal_error")),
    ];
    for (failure, want) in cases {
        assert_eq!(degraded_reason(&failure), want, "{failure}");
    }
}

#[test]
fn flags_mark_conflicts_early_late_and_places() {
    let item = |start: &str, end: &str, all_day: bool| {
        json!({"startsAt":start,"endsAt":end,"allDay":all_day,"location":" ","attendeeCount":1})
    };
    let items = [
        item("2026-03-02T08:00:00.000Z", "2026-03-02T09:00:00.000Z", false),
        item("2026-03-02T08:30:00.000Z", "2026-03-02T09:30:00.000Z", false),
        item("2026-03-02T18:00:00.000Z", "2026-03-02T19:00:00.000Z", false),
        item("2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z", true),
    ];
    let marks = flags(&items, UTC);
    assert_eq!(marks[0], ["conflict", "early"]);
    assert_eq!(marks[1], ["conflict", "early"]);
    assert_eq!(marks[2], ["late"]);
    assert!(marks[3].is_empty(), "an all-day event is never early, late or in conflict");
}
