use moss_connectors::health::{observe, read_outlook, section};
use serde_json::{json, Value};

fn row(extra: Value) -> Value {
    let mut base = json!({
        "id":"a1","providerId":"google","status":"active","revokedAt":null,
        "lastSyncStartedAt":"2026-02-01T10:00:00.000Z","lastSyncFinishedAt":"2026-02-01T10:01:00.000Z",
        "lastSyncStatus":null,"errorLabel":null,"previousStatus":null,"previousFinishedAt":null
    });
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}
fn mail(extra: Value) -> Value {
    observe(&row(extra), None)
}

#[test]
fn mail_never_synced() {
    let seen = mail(json!({}));
    assert_eq!(seen["status"], "never-synced");
    assert_eq!(seen["failureCount"], 0);
    assert_eq!(seen["errorLabel"], Value::Null);
}
#[test]
fn mail_healthy_uses_finish_time_as_last_good() {
    let seen = mail(json!({"lastSyncStatus":"success"}));
    assert_eq!(seen["status"], "healthy");
    assert_eq!(seen["lastGoodAt"], "2026-02-01T10:01:00.000Z");
}
#[test]
fn mail_partial_keeps_the_previous_good_run() {
    let seen = mail(json!({"lastSyncStatus":"partial","previousStatus":"success","previousFinishedAt":"2026-01-30T09:00:00Z"}));
    assert_eq!(seen["status"], "sync-partial");
    assert_eq!(seen["lastGoodAt"], "2026-01-30T09:00:00.000Z");
}
#[test]
fn mail_failed_counts_one_and_labels_sync_error() {
    let seen = mail(json!({"lastSyncStatus":"failed"}));
    assert_eq!(seen["status"], "sync-failed");
    assert_eq!(seen["failureCount"], 1);
    assert_eq!(seen["errorLabel"], "sync-error");
    assert_eq!(seen["lastGoodAt"], Value::Null);
}
#[test]
fn mail_error_status_wins_over_sync_status() {
    let seen = mail(json!({"status":"error","lastSyncStatus":"success"}));
    assert_eq!(seen["status"], "error");
    assert_eq!(seen["errorLabel"], "sync-error");
}
#[test]
fn mail_stored_label_is_kept() {
    let seen = mail(json!({"lastSyncStatus":"failed","errorLabel":"auth-error"}));
    assert_eq!(seen["errorLabel"], "auth-error");
}
#[test]
fn revoked_account_reports_revoked() {
    for extra in [json!({"status":"revoked"}), json!({"revokedAt":"2026-02-02T00:00:00Z"})] {
        let seen = mail(extra);
        assert_eq!(seen["status"], "revoked");
        assert_eq!(seen["errorLabel"], "revoked");
        assert_eq!(seen["lastGoodAt"], Value::Null);
        assert_eq!(seen["lastAttemptAt"], "2026-02-01T10:00:00.000Z");
    }
}
#[test]
fn labels_are_cut_to_120_characters() {
    let seen = mail(json!({"id":"i".repeat(300),"providerId":"p".repeat(300)}));
    assert_eq!(seen["accountId"].as_str().unwrap().len(), 120);
    assert_eq!(seen["provider"].as_str().unwrap().len(), 120);
}

fn outlook(state: Value) -> Value {
    let row = row(json!({"providerId":"outlook-browser-calendar"}));
    observe(&row, Some(&read_outlook(&state)))
}
#[test]
fn outlook_states_map_to_their_labels() {
    for state in ["stale", "sign-in-needed", "source-changed", "settings-not-found", "disconnected"] {
        let seen = outlook(json!({"state":state}));
        assert_eq!(seen["status"], state);
        assert_eq!(seen["errorLabel"], state);
    }
}
#[test]
fn outlook_healthy_and_collecting_have_no_error() {
    assert_eq!(outlook(json!({"state":"current"}))["status"], "healthy");
    assert_eq!(outlook(json!({"state":"current"}))["errorLabel"], Value::Null);
    assert_eq!(outlook(json!({"state":"collecting"}))["status"], "collecting");
    assert_eq!(outlook(json!({"state":"collecting"}))["errorLabel"], Value::Null);
}
#[test]
fn outlook_partial_tells_failures_from_incomplete() {
    assert_eq!(outlook(json!({"state":"partial"}))["errorLabel"], "scan-incomplete");
    let seen = outlook(json!({"state":"partial","failures":2}));
    assert_eq!(seen["errorLabel"], "scan-incomplete-or-helper-unreachable");
    assert_eq!(seen["failureCount"], 2);
}
#[test]
fn unreadable_outlook_state_counts_as_collecting() {
    for bad in [json!(null), json!("x"), json!([]), json!({"state":"mystery"})] {
        assert_eq!(outlook(bad)["status"], "collecting");
    }
}
#[test]
fn outlook_times_prefer_the_helper_over_the_sync_columns() {
    let seen = outlook(json!({"state":"current","attemptedAt":"2026-03-01T00:00:00Z","lastCompleteAt":"2026-02-28T00:00:00Z"}));
    assert_eq!(seen["lastAttemptAt"], "2026-03-01T00:00:00.000Z");
    assert_eq!(seen["lastGoodAt"], "2026-02-28T00:00:00.000Z");
}
#[test]
fn section_clamps_the_limit_and_flags_truncation() {
    let rows: Vec<Value> = (0..12).map(|i| row(json!({"id":format!("a{i}")}))).collect();
    assert_eq!(section(&rows, &json!({}), 3)["items"].as_array().unwrap().len(), 3);
    assert_eq!(section(&rows, &json!({}), 3)["truncated"], true);
    assert_eq!(section(&rows, &json!({}), 99)["items"].as_array().unwrap().len(), 10);
    assert_eq!(section(&rows[..2], &json!({}), 5)["truncated"], false);
    assert_eq!(section(&rows, &json!({}), 0)["items"].as_array().unwrap().len(), 1);
}
