mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const TABLE: &str = "app.wellness_checkins";

fn make(f: &Fake, body: Value) -> Value {
    let (status, out) = f.route("POST", "/wellness/checkins", &[], body);
    assert_eq!(status, 201, "{out}");
    out["checkin"].clone()
}

#[test]
fn create_stores_day_and_offset_and_forces_the_third_level_empty() {
    let f = Fake::new();
    let c = make(&f, json!({"feelingCore":"happy","feelingSecondary":"Joy","sensations":["Open"],"intensity":4,"energy":2,"note":"  fine  "}));
    assert_eq!(c["feelingCore"], "happy");
    assert_eq!(c["feelingSecondary"], "Joy");
    assert_eq!(c["feelingTertiary"], Value::Null);
    assert_eq!(c["note"], "fine");
    assert_eq!(c["identifiedVia"], "wheel");
    assert_eq!(c["checkedInAt"], "2026-11-11T18:00:00.123Z");
    let row = &f.rows(TABLE)[0];
    assert_eq!(row["local_date"], "2026-11-11");
    assert_eq!(row["timezone_offset"], -480);
}

#[test]
fn bad_bodies_get_the_old_answers() {
    let f = Fake::new();
    let cases = [
        (json!({}), "body must have required property 'feelingCore'"),
        (json!({"feelingCore":"glad"}), "body/feelingCore must be equal to one of the allowed values"),
        (json!({"feelingCore":"happy","intensity":9}), "body/intensity must be <= 5, body/intensity must be null, body/intensity must match a schema in anyOf"),
        (json!({"feelingCore":"happy","intensity":"x"}), "body/intensity must be integer, body/intensity must be null, body/intensity must match a schema in anyOf"),
        (json!({"feelingCore":"happy","feelingSecondary":"Lonely"}), "feelingSecondary/feelingTertiary must form a valid path under feelingCore"),
        (json!({"feelingCore":"happy","feelingTertiary":"Joy"}), "feelingSecondary/feelingTertiary must form a valid path under feelingCore"),
        (json!({"feelingCore":"happy","identifiedVia":"guess"}), "body/identifiedVia must be equal to one of the allowed values"),
        (json!({"feelingCore":"happy","note":{"a":1}}), "body/note must be string, body/note must be null, body/note must match a schema in anyOf"),
    ];
    for (body, message) in cases {
        let (status, out) = f.route("POST", "/wellness/checkins", &[], body.clone());
        assert_eq!((status, out["error"].as_str().unwrap()), (400, message), "{body}");
    }
    assert!(f.rows(TABLE).is_empty());
}

#[test]
fn change_keeps_omitted_fields_and_checks_the_path_against_the_stored_feeling() {
    let f = Fake::new();
    let c = make(&f, json!({"feelingCore":"happy","feelingSecondary":"Joy","intensity":3,"note":"keep"}));
    let id = c["id"].as_str().unwrap();
    let (status, out) = f.route("PATCH", "/wellness/checkins/:id", &[("id", id)], json!({"feelingCore":"happy","energy":5}));
    assert_eq!(status, 200);
    assert_eq!(out["checkin"]["energy"], 5);
    assert_eq!(out["checkin"]["feelingSecondary"], "Joy");
    assert_eq!(out["checkin"]["note"], "keep");
    let (status, out) = f.route("PATCH", "/wellness/checkins/:id", &[("id", id)], json!({"feelingCore":"sad"}));
    assert_eq!(status, 400);
    assert_eq!(out["error"], "feelingSecondary 'Joy' is not valid under feelingCore 'sad'");
    let (status, out) = f.route("PATCH", "/wellness/checkins/:id", &[("id", id)], json!({"feelingCore":"sad","feelingSecondary":null}));
    assert_eq!((status, out["checkin"]["feelingSecondary"].clone()), (200, Value::Null));
    let (status, out) = f.route("PATCH", "/wellness/checkins/:id", &[("id", "00000000-0000-4000-8000-0000000000ff")], json!({"feelingCore":"sad"}));
    assert_eq!((status, out), (404, json!({"error":"Check-in not found"})));
}

#[test]
fn history_pages_newest_first_and_the_cursor_is_strict() {
    let f = Fake::new();
    for _ in 0..5 {
        make(&f, json!({"feelingCore":"happy"}));
    }
    let (_, first) = f.route_query("GET", "/wellness/checkins", &[], &[("limit", "2")], Value::Null);
    assert_eq!(first["checkins"].as_array().unwrap().len(), 2);
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    let (_, second) = f.route_query("GET", "/wellness/checkins", &[], &[("limit", "2"), ("cursor", &cursor)], Value::Null);
    let (_, third) = f.route_query("GET", "/wellness/checkins", &[], &[("limit", "2"), ("cursor", second["nextCursor"].as_str().unwrap())], Value::Null);
    assert_eq!(third["checkins"].as_array().unwrap().len(), 1);
    assert_eq!(third["nextCursor"], Value::Null);
    let ids: Vec<&str> = [&first, &second, &third].iter().flat_map(|p| p["checkins"].as_array().unwrap()).map(|c| c["id"].as_str().unwrap()).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), 5, "no check-in repeats or is skipped");
    let (status, out) = f.route_query("GET", "/wellness/checkins", &[], &[("cursor", "not-a-cursor")], Value::Null);
    assert_eq!((status, out["error"].as_str().unwrap()), (400, "Invalid check-in cursor. Restart history from the newest entries."));
    let (status, out) = f.route_query("GET", "/wellness/checkins", &[], &[("cursor", &cursor), ("since", "2020-01-01T00:00:00Z")], Value::Null);
    assert_eq!((status, out["error"].as_str().unwrap()), (400, "Check-in cursor does not match this date window. Restart the read."));
    for limit in ["0", "501", "x", "1.5"] {
        let (status, out) = f.route_query("GET", "/wellness/checkins", &[], &[("limit", limit)], Value::Null);
        assert_eq!((status, out["error"].as_str().unwrap()), (400, "limit must be 1\u{2013}500"), "{limit}");
    }
    let (status, out) = f.route_query("GET", "/wellness/checkins", &[], &[("since", "soon")], Value::Null);
    assert_eq!((status, out["error"].as_str().unwrap()), (400, "since must be an ISO timestamp"));
}

#[test]
fn each_person_sees_only_their_own_check_ins() {
    let f = Fake::new();
    let mine = make(&f, json!({"feelingCore":"happy"}));
    f.as_actor(B);
    let (_, list) = f.route("GET", "/wellness/checkins", &[], Value::Null);
    assert_eq!(list["checkins"], json!([]));
    let (status, _) = f.route("PATCH", "/wellness/checkins/:id", &[("id", mine["id"].as_str().unwrap())], json!({"feelingCore":"sad"}));
    assert_eq!(status, 404);
    f.as_actor(A);
    let (_, list) = f.route("GET", "/wellness/checkins", &[], Value::Null);
    assert_eq!(list["checkins"].as_array().unwrap().len(), 1);
}

#[test]
fn consent_defaults_on_and_follows_the_saved_choice() {
    let f = Fake::new();
    let (_, out) = f.route("GET", "/wellness/ai-consent", &[], Value::Null);
    assert_eq!(out, json!({"effective":true,"explicit":null}));
    let (status, out) = f.route("PUT", "/wellness/ai-consent", &[], json!({"granted":false}));
    assert_eq!((status, out), (200, json!({"effective":false,"explicit":false})));
    f.as_actor(B);
    let (_, out) = f.route("GET", "/wellness/ai-consent", &[], Value::Null);
    assert_eq!(out, json!({"effective":true,"explicit":null}), "another person's choice is separate");
    let (status, out) = f.route("PUT", "/wellness/ai-consent", &[], json!({}));
    assert_eq!((status, out["error"].as_str().unwrap()), (400, "body must have required property 'granted'"));
    let (status, out) = f.route("PUT", "/wellness/ai-consent", &[], json!({"granted":"maybe"}));
    assert_eq!((status, out["error"].as_str().unwrap()), (400, "body/granted must be boolean"));
}

#[test]
fn local_day_gives_the_persons_date_and_zone_and_nothing_else() {
    let f = Fake::new();
    let (status, out) = f.route("GET", "/wellness/local-day", &[], Value::Null);
    assert_eq!(status, 200, "{out}");
    assert_eq!(out, json!({"date":"2026-11-11","timezone":"America/Los_Angeles"}));
}
