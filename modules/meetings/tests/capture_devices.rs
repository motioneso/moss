//! Device eligibility and busy rules ported from the TypeScript connection service tests.
use chrono::{DateTime, Duration, TimeZone, Utc};
use moss_meetings_module::capture_devices::*;
use moss_meetings_module::capture_errors::{CaptureCode, Failure};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 6, 0, 0, 0).unwrap()
}

fn t(d: Duration) -> String {
    (now() + d).to_rfc3339()
}

fn connection(id: &str, seen: Duration, expires: Duration) -> Value {
    json!({"device_id": id, "connection_id": id, "device_name": "Mac", "revision": 1, "capability_revision": 1,
        "inventory_json": {}, "last_seen_at": t(seen), "expires_at": t(expires)})
}

#[test]
fn a_connection_is_live_only_when_fresh_and_unexpired() {
    assert!(live(&connection("a", Duration::seconds(-30), Duration::hours(1)), now()));
    assert!(!live(&connection("a", Duration::seconds(-31), Duration::hours(1)), now()));
    assert!(!live(&connection("a", Duration::zero(), Duration::zero()), now()));
}

#[test]
fn a_start_with_no_device_needs_exactly_one_eligible_mac() {
    let one = [connection("a", Duration::zero(), Duration::hours(1))];
    assert!(default_connection(&one, &one, false).is_ok());
    let two = [one[0].clone(), connection("b", Duration::zero(), Duration::hours(1))];
    assert_eq!(default_connection(&two, &two, false), Err(Failure::new(CaptureCode::SourceUnavailable)));
    assert_eq!(default_connection(&[], &[], false), Err(Failure::new(CaptureCode::SourceUnavailable)));
}

#[test]
fn a_full_page_never_proves_the_only_mac_is_the_only_mac() {
    let page: Vec<Value> = (0..32).map(|i| connection(&format!("c{i}"), Duration::zero(), Duration::hours(1))).collect();
    let eligible = [page[0].clone()];
    assert_eq!(default_connection(&page, &eligible, false), Err(Failure::new(CaptureCode::SourceUnavailable)));
    assert!(default_connection(&page, &eligible, true).is_ok());
}

fn grant(status: &str, desired: &str, seen: Option<Duration>) -> Value {
    json!({"status": status, "state_json": {"desired": desired, "originAt": t(Duration::minutes(-5)),
        "lastSeenAt": seen.map(t), "finalizationDeadline": null}})
}

#[test]
fn busy_phases_follow_the_grant() {
    assert_eq!(phase(&grant("approved", "idle", None), now()), Some("starting"));
    assert_eq!(phase(&grant("active", "recording", Some(Duration::seconds(-5))), now()), Some("recording"));
    assert_eq!(phase(&grant("active", "paused", Some(Duration::seconds(-5))), now()), Some("paused"));
    assert_eq!(phase(&grant("finalizing", "stopped", Some(Duration::seconds(-5))), now()), Some("finalizing"));
}

#[test]
fn an_active_grant_with_a_silent_mac_frees_the_device() {
    assert_eq!(phase(&grant("active", "recording", Some(Duration::seconds(-31))), now()), None);
    let free = entry(&connection("a", Duration::zero(), Duration::hours(1)), Some(&grant("active", "recording", Some(Duration::seconds(-60)))), now());
    assert_eq!(free["busy"], false);
    assert_eq!(free["capturePhase"], Value::Null);
}
