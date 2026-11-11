use leptos::prelude::*;
use moss_connectors_ui::{model, views::AccountList};
use serde_json::{json, Value};

fn account(id: &str, status: &str, sync: Value, scopes: Value) -> Value {
    json!({"id":id,"providerDisplayName":"Google","status":status,"revokedAt":null,
           "lastSyncStatus":sync,"scopes":scopes})
}
fn render(accounts: Vec<(Value, Value)>) -> String {
    view! {<AccountList accounts busy=Signal::derive(|| false)
        on_switch=Callback::new(|_| {}) on_revoke=Callback::new(|_| {})/>}
    .to_html()
}

#[test]
fn health_words_and_labels() {
    let a = |status: &str, sync: Value, revoked: Value| {
        let mut x = account("1", status, sync, json!([]));
        x["revokedAt"] = revoked;
        model::health_label(model::health(&x)).0
    };
    assert_eq!(a("active", Value::Null, Value::Null), "Not synced yet");
    assert_eq!(a("active", json!("success"), Value::Null), "Healthy");
    assert_eq!(a("active", json!("partial"), Value::Null), "Partly synced");
    assert_eq!(a("active", json!("failed"), Value::Null), "Last sync failed");
    assert_eq!(a("error", json!("success"), Value::Null), "Needs attention");
    assert_eq!(a("active", json!("success"), json!("2026-01-01T00:00:00.000Z")), "Revoked");
}

#[test]
fn empty_list_says_so() {
    assert!(render(vec![]).contains("No connections yet"));
}

#[test]
fn rows_show_switches_only_for_offered_features_and_default_on() {
    let calendar = account("c", "active", json!("success"), json!(["https://www.googleapis.com/auth/calendar"]));
    let html = render(vec![(calendar, json!(null))]);
    assert!(html.contains("Calendar for Google"));
    assert!(!html.contains("Email for Google"));
    assert!(html.contains("Revoke"));
    let off = render(vec![(account("c", "active", json!(null), json!(["calendar.read"])), json!({"calendar":false}))]);
    assert!(!off.contains("checked"), "a saved off choice must render unchecked: {off}");
}

#[test]
fn revoked_rows_have_no_revoke_button_and_locked_switches() {
    let mut a = account("r", "revoked", json!(null), json!(["email.read"]));
    a["revokedAt"] = json!("2026-01-01T00:00:00.000Z");
    let html = render(vec![(a, json!(null))]);
    assert!(!html.contains("Revoke<"));
    assert!(html.contains("disabled"));
}

#[test]
fn audit_lines_map_to_connections() {
    assert_eq!(model::audit_category("connector.feature_grant.set"), "Connections");
    assert_eq!(
        model::audit_phrase("connector.feature_grant.set", &json!({"feature":"email","enabled":false})).unwrap(),
        "turned Email off for a connection"
    );
    assert_eq!(model::audit_phrase("user.approve", &json!({})), None);
}
