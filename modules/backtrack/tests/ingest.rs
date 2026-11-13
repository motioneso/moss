mod common;
use common::*;
use moss_backtrack_module::route;
use serde_json::{json, Value};

fn upload(sent: &str, segments: Vec<Value>) -> Value {
    json!({"sentAt": sent, "segments": segments})
}
fn good() -> Value {
    upload(NOW, vec![segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", "hello")])
}
fn post(host: &Fake, body: Value) -> moss_module_sdk::Response {
    route(host, request("POST", "/ingest", body))
}

#[test]
fn a_good_upload_is_stored_for_the_linked_mac_and_counted() {
    let host = Fake::default();
    let r = post(&host, good());
    assert_eq!(r.status, 200);
    assert_eq!(r.body, json!({"accepted":1,"duplicates":0,"discarded":0,"rejectedClock":0,"state":{"storage":"on","paused":false}}));
    let inserted = host.params("kv.insert").unwrap();
    assert_eq!(inserted["deviceId"], DEVICE);
    assert_eq!(inserted["segments"][0]["bodyHash"].as_str().unwrap().len(), 64);
    assert!(host.ops().contains(&"jobs.schedule".to_string()));
}

#[test]
fn no_link_no_storage_and_pause_each_refuse_and_store_nothing() {
    for (host, status, code) in [
        (Fake { link: json!({"link":"none"}), ..Fake::default() }, 401, "companion_credential_invalid"),
        (Fake { link: json!({"link":"pending"}), ..Fake::default() }, 403, "account_pending_approval"),
        (Fake { link: json!({"link":"deactivated"}), ..Fake::default() }, 403, "account_deactivated"),
        (Fake { storage: false, ..Fake::default() }, 409, "backtrack_unavailable"),
        (Fake { paused: true, ..Fake::default() }, 409, "backtrack_paused"),
    ] {
        let r = post(&host, good());
        assert_eq!((r.status, r.body["code"].as_str().unwrap()), (status, code));
        assert!(!host.ops().contains(&"kv.insert".to_string()), "{code} stored text");
    }
}

#[test]
fn a_clock_two_hours_off_either_way_is_a_422_with_the_clock_code() {
    for sent in ["2026-11-12T10:00:00Z", "2026-11-12T14:00:00Z"] {
        let host = Fake::default();
        let r = post(&host, upload(sent, vec![segment(sent, sent, "x")]));
        assert_eq!((r.status, r.body["code"].as_str()), (422, Some("backtrack_clock")));
        assert!(!host.ops().contains(&"kv.insert".to_string()));
    }
}

#[test]
fn old_future_and_backwards_segments_are_counted_and_the_rest_stored() {
    let host = Fake::default();
    let r = post(&host, upload(NOW, vec![
        segment("2026-11-11T09:00:00Z", "2026-11-11T09:05:00Z", "27h old"),
        segment("2026-11-12T12:30:00Z", "2026-11-12T12:35:00Z", "future"),
        segment("2026-11-12T11:30:00Z", "2026-11-12T11:00:00Z", "backwards"),
        segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", "kept"),
    ]));
    assert_eq!((r.body["accepted"].clone(), r.body["rejectedClock"].clone()), (json!(1), json!(3)));
}

#[test]
fn a_mac_clock_that_is_slightly_off_is_shifted_by_the_measured_skew() {
    let host = Fake::default();
    let r = post(&host, upload("2026-11-12T11:30:00Z", vec![segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", "x")]));
    assert_eq!(r.body["accepted"], 1);
    let row = &host.params("kv.insert").unwrap()["segments"][0];
    assert_eq!(row["startedAt"], "2026-11-12T11:30:00.000000Z");
    assert_eq!(row["clientStartedAt"], "2026-11-12T11:00:00.000000Z");
}

#[test]
fn segments_inside_a_deleted_window_are_discarded_not_stored() {
    let host = Fake { overlaps: vec![0], ..Fake::default() };
    let r = post(&host, good());
    assert_eq!((r.body["accepted"].clone(), r.body["discarded"].clone()), (json!(0), json!(1)));
    assert!(!host.ops().contains(&"kv.insert".to_string()));
    assert!(!host.ops().contains(&"jobs.schedule".to_string()));
}

#[test]
fn a_replayed_batch_counts_as_duplicates_not_new_rows() {
    let host = Fake { inserted: Some(0), ..Fake::default() };
    let r = post(&host, good());
    assert_eq!((r.body["accepted"].clone(), r.body["duplicates"].clone()), (json!(0), json!(1)));
}

#[test]
fn secrets_are_redacted_before_the_host_sees_them() {
    let host = Fake::default();
    let mut s = segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", "password=correcthorsebattery");
    s["windowTitle"] = json!("Authorization: Bearer abc123def456ghi789");
    s["address"] = json!("https://u:hunter2pass@example.test/");
    post(&host, upload(NOW, vec![s]));
    let sent = host.params("kv.insert").unwrap().to_string();
    for secret in ["correcthorsebattery", "abc123def456ghi789", "hunter2pass"] {
        assert!(!sent.contains(secret), "{secret}");
    }
}

#[test]
fn shape_limits_refuse_201_segments_a_9kb_body_and_unknown_keys() {
    let seg = || segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", "x");
    assert_eq!(post(&Fake::default(), upload(NOW, vec![seg(); 201])).status, 400);
    assert_eq!(post(&Fake::default(), upload(NOW, vec![])).status, 400);
    let big = segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", &"y".repeat(9000));
    assert_eq!(post(&Fake::default(), upload(NOW, vec![big])).status, 400);
    let mut extra = good();
    extra["extra"] = json!(1);
    assert_eq!(post(&Fake::default(), extra).status, 400);
}

#[test]
fn a_multibyte_body_over_the_byte_limit_is_dropped_alone() {
    let host = Fake::default();
    // 3000 three-byte characters are 9000 bytes: under the character limit, over the byte limit.
    let wide = segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", &"€".repeat(3000));
    let ok = segment("2026-11-12T11:10:00Z", "2026-11-12T11:15:00Z", "fine");
    let r = post(&host, upload(NOW, vec![wide, ok]));
    assert_eq!(r.body["accepted"], 1);
    let exact = segment("2026-11-12T11:00:00Z", "2026-11-12T11:05:00Z", &format!("{}ab", "€".repeat(2730)));
    assert_eq!(post(&Fake::default(), upload(NOW, vec![exact])).body["accepted"], 1);
}

#[test]
fn a_failed_schedule_still_answers_success() {
    struct NoJobs(Fake);
    impl moss_module_sdk::Host for NoJobs {
        fn call(&self, p: &str, o: &str, r: &str, v: Value) -> moss_module_sdk::Result<Value> {
            if p == "jobs" { Err(moss_module_sdk::Error::new("no")) } else { self.0.call(p, o, r, v) }
        }
    }
    assert_eq!(route(&NoJobs(Fake::default()), request("POST", "/ingest", good())).status, 200);
}
