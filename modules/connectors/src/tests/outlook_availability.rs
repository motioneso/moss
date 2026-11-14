//! When the Outlook copy is good enough to place an event against. Ported from the old tests.
use chrono::{DateTime, Utc};
use moss_connectors::outlook_availability::issue;
use serde_json::{json, Value};

fn at(text: &str) -> DateTime<Utc> { text.parse().unwrap() }

fn setup(health: Value, status: &str, grants: Value) -> Value {
    json!({
        "accounts": [{"id":"outlook","providerId":"outlook-browser-calendar","status":status}],
        "grants": {"outlook": grants},
        "outlook": {"outlook": health},
    })
}

fn fresh() -> Value {
    json!({"state":"current","lastCompleteAt":"2026-10-21T18:00:00.000Z","timeZone":"America/Los_Angeles",
           "windowStart":"2026-10-21","windowEnd":"2026-10-22","unconfirmed":0})
}

fn check(health: Value) -> Option<&'static str> {
    issue(&setup(health, "active", json!({"calendar":true})), at("2026-10-22T05:30:00Z"), at("2026-10-22T06:00:00Z"), at("2026-10-21T18:00:00Z"))
}

#[test]
fn coverage_uses_the_source_zone_midnight() {
    assert_eq!(check(fresh()), None);
    let late = issue(&setup(fresh(), "active", json!({"calendar":true})), at("2026-10-22T06:30:00Z"), at("2026-10-22T07:30:00Z"), at("2026-10-21T18:00:00Z"));
    assert!(late.unwrap().contains("verification"));
}

#[test]
fn every_state_but_current_refuses() {
    for state in ["partial", "stale", "collecting", "sign-in-needed", "source-changed", "disconnected"] {
        let mut health = fresh();
        health["state"] = json!(state);
        assert!(check(health).is_some(), "{state}");
    }
}

#[test]
fn old_uncertain_or_uncovered_copies_refuse() {
    let edits: [(&str, Value); 5] = [
        ("lastCompleteAt", json!("2026-10-21T17:44:59.000Z")),
        ("lastCompleteAt", json!("2026-10-21T18:00:01.000Z")),
        ("unconfirmed", json!(1)),
        ("timeZone", json!("Unknown/Zone")),
        ("windowStart", json!("2026-10-22")),
    ];
    for (key, value) in edits {
        let mut health = fresh();
        health[key] = value.clone();
        assert!(check(health).is_some(), "{key} {value}");
    }
    let mut health = fresh();
    health.as_object_mut().unwrap().remove("timeZone");
    assert!(check(health).is_some());
}

#[test]
fn a_disconnected_or_switched_off_source_still_refuses() {
    let args = (at("2026-10-22T05:30:00Z"), at("2026-10-22T06:00:00Z"), at("2026-10-21T18:00:00Z"));
    assert!(issue(&setup(fresh(), "revoked", json!({"calendar":true})), args.0, args.1, args.2).is_some());
    assert!(issue(&setup(fresh(), "active", json!({"calendar":false})), args.0, args.1, args.2).is_some());
}

#[test]
fn people_without_an_outlook_source_are_not_blocked() {
    let none = json!({"accounts":[{"id":"g","providerId":"google","status":"active"}],"grants":{},"outlook":{}});
    assert_eq!(issue(&none, at("2026-10-22T05:30:00Z"), at("2026-10-22T06:00:00Z"), at("2026-10-21T18:00:00Z")), None);
}
