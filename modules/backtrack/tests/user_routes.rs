mod common;
use common::*;
use moss_backtrack_module::route;
use serde_json::json;

#[test]
fn status_reports_the_switch_and_the_actors_counts() {
    let r = route(&Fake::default(), request("GET", "/status", json!(null)));
    assert_eq!((r.status, r.body["storage"].clone(), r.body["segments"].clone()), (200, json!("on"), json!(4)));
    let off = route(&Fake { storage: false, ..Fake::default() }, request("GET", "/status", json!(null)));
    assert_eq!(off.body["storage"], "off");
}

#[test]
fn pause_takes_exactly_one_boolean_and_schedules_the_sweep() {
    let host = Fake::default();
    let r = route(&host, request("PUT", "/preferences", json!({"paused": true})));
    assert_eq!((r.status, r.body), (200, json!({"paused": true})));
    assert!(host.ops().contains(&"jobs.schedule".to_string()));
    for bad in [json!({}), json!({"paused": "yes"}), json!({"paused": true, "x": 1}), json!(null)] {
        assert_eq!(route(&Fake::default(), request("PUT", "/preferences", bad)).status, 400);
    }
}

#[test]
fn delete_with_no_body_or_an_empty_object_deletes_everything_up_to_now() {
    for body in [json!(null), json!({})] {
        let host = Fake::default();
        let r = route(&host, request("DELETE", "/segments", body));
        assert_eq!((r.status, r.body), (200, json!({"deleted": 3})));
        let p = host.params("kv.delete").unwrap();
        assert_eq!((p["from"].clone(), p["to"].clone()), (json!(null), json!(NOW)));
        assert_eq!(host.ops()[0], "kv.lock");
    }
}

#[test]
fn a_range_reaching_into_the_future_is_cut_at_now() {
    let host = Fake::default();
    route(&host, request("DELETE", "/segments", json!({"from":"2026-11-12T11:00:00Z","to":"2026-11-12T20:00:00Z"})));
    assert_eq!(host.params("kv.delete").unwrap()["to"], NOW);
}

#[test]
fn a_range_that_starts_in_the_future_deletes_nothing_and_writes_no_marker() {
    let host = Fake::default();
    let r = route(&host, request("DELETE", "/segments", json!({"from":"2026-11-13T00:00:00Z","to":"2026-11-13T12:00:00Z"})));
    assert_eq!(r.body, json!({"deleted": 0}));
    assert!(!host.ops().contains(&"kv.delete".to_string()));
}

#[test]
fn bad_ranges_get_the_legacy_messages_and_delete_nothing() {
    let cases = [
        (json!({"from":"2026-11-01T00:00:00Z"}), "Send both from and to, or neither"),
        (json!({"from":"nope","to":"nope"}), "from and to must be timestamps"),
        (json!({"from":"2026-11-02T00:00:00Z","to":"2026-11-01T00:00:00Z"}), "from must be before to"),
        (json!({"from":"2026-09-01T00:00:00Z","to":"2026-11-01T00:00:00Z"}), "A range can span at most 31 days"),
        (json!({"junk":1}), "Send a from and to, or nothing"),
        (json!("text"), "Send a from and to, or nothing"),
    ];
    for (body, message) in cases {
        let host = Fake::default();
        let r = route(&host, request("DELETE", "/segments", body.clone()));
        assert_eq!((r.status, r.body["error"].as_str()), (400, Some(message)), "{body}");
        assert!(!host.ops().contains(&"kv.delete".to_string()));
    }
}

#[test]
fn unknown_routes_are_404() {
    assert_eq!(route(&Fake::default(), request("GET", "/nope", json!(null))).status, 404);
}
