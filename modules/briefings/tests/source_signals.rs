//! The Email and Calendar signal switches on Briefings settings. Each owner keeps its own switch, so
//! Briefings only forwards a checked boolean through the owner's public call for the caller.
mod common;
use common::*;
use serde_json::{json, Value};

fn owners(fake: &Fake, person: &str, email: bool, calendar: bool) {
    fake.answer(person, "email", "getBriefingSource", Some(json!({"enabled": email})));
    fake.answer(person, "calendar", "getSourceSwitches", Some(json!({"briefings": calendar, "planning": true})));
}

fn patch(fake: &Fake, body: Value) -> (u16, Value) {
    fake.route("PATCH", "/source-signals", &[], body)
}

#[test]
fn the_switches_read_from_each_owner_for_the_caller_only() {
    let fake = Fake::new();
    owners(&fake, A, false, true);
    let (status, out) = fake.route("GET", "/source-signals", &[], json!(null));
    assert_eq!((status, out), (200, json!({"email": false, "calendar": true})));
    let calls = fake.api_calls.borrow();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|(person, ..)| person == A), "{calls:?}");
}

#[test]
fn a_missing_owner_module_leaves_its_switch_out() {
    let fake = Fake::new();
    fake.answer(A, "email", "getBriefingSource", None);
    fake.answer(A, "calendar", "getSourceSwitches", Some(json!({"briefings": false, "planning": true})));
    let (_, out) = fake.route("GET", "/source-signals", &[], json!(null));
    assert_eq!(out, json!({"calendar": false}));
    fake.answer(A, "calendar", "getSourceSwitches", None);
    let (_, out) = fake.route("GET", "/source-signals", &[], json!(null));
    assert_eq!(out, json!({}));
}

#[test]
fn flipping_a_switch_writes_only_that_owners_call_for_the_caller() {
    let fake = Fake::new();
    owners(&fake, A, true, true);
    fake.answer(A, "email", "setBriefingSource", Some(json!({"enabled": false})));
    let (status, _) = patch(&fake, json!({"email": false}));
    assert_eq!(status, 200);
    fake.answer(A, "calendar", "setSourceSwitches", Some(json!({"briefings": false, "planning": true})));
    let (status, _) = patch(&fake, json!({"calendar": false}));
    assert_eq!(status, 200);
    let calls = fake.api_calls.borrow();
    let writes: Vec<_> = calls.iter().filter(|(_, _, name, _)| name.starts_with("set")).collect();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].1, "email");
    assert_eq!(writes[0].3, json!({"enabled": false}));
    assert_eq!(writes[1].1, "calendar");
    assert_eq!(writes[1].3, json!({"briefings": false}), "the planning switch must not be sent");
    assert!(calls.iter().all(|(person, ..)| person == A), "another person's call was made: {calls:?}");
}

#[test]
fn a_second_person_is_never_asked_or_changed() {
    let fake = Fake::new();
    owners(&fake, A, true, true);
    owners(&fake, B, true, true);
    fake.answer(A, "email", "setBriefingSource", Some(json!({"enabled": false})));
    patch(&fake, json!({"email": false}));
    assert!(fake.api_calls.borrow().iter().all(|(person, ..)| person != B));
}

#[test]
fn a_bad_body_is_refused_before_any_owner_is_called() {
    let fake = Fake::new();
    owners(&fake, A, true, true);
    for bad in [
        json!({}),
        json!(null),
        json!([true]),
        json!({"email": "yes"}),
        json!({"calendar": 1}),
        json!({"planning": false}),
        json!({"email": false, "planning": false}),
        json!({"email": null}),
    ] {
        let (status, out) = patch(&fake, bad.clone());
        assert_eq!(status, 400, "{bad} gave {out}");
    }
    assert!(fake.api_calls.borrow().is_empty(), "a refused body reached an owner");
}

#[test]
fn a_failing_owner_gives_an_error_and_no_later_write() {
    let fake = Fake::new();
    owners(&fake, A, true, true);
    fake.answer(A, "email", "setBriefingSource", None);
    fake.answer(A, "calendar", "setSourceSwitches", Some(json!({"briefings": false, "planning": true})));
    let (status, out) = patch(&fake, json!({"email": false, "calendar": false}));
    assert_eq!((status, out["code"].as_str()), (404, Some("briefing_source_unavailable")));
    assert!(fake.api_calls.borrow().iter().all(|(_, _, name, _)| name != "setSourceSwitches"));
}
