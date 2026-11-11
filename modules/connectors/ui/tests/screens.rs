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

mod google_flow {
    use super::*;
    use moss_connectors_ui::google::{GoogleConnect, Phase};

    fn render(phase: Phase, error: Option<&str>) -> String {
        let error = error.map(String::from);
        view! {<GoogleConnect phase=Signal::derive(move || phase)
            client_id=RwSignal::new(String::new()) client_secret=RwSignal::new(String::new())
            redirect=RwSignal::new(String::new()) error=Signal::derive(move || error.clone())
            busy=Signal::derive(|| false) on_open=Callback::new(|_| {}) on_finish=Callback::new(|_| {})
            on_cancel=Callback::new(|_| {}) on_file=Callback::new(|_| {})/>}
        .to_html()
    }

    #[test]
    fn first_step_shows_guide_fields_and_hint_but_not_the_finish_field() {
        let html = render(Phase::Credentials, None);
        assert!(html.contains("Create a project in the Google Cloud Console"));
        assert!(html.contains("Desktop app"));
        assert!(html.contains("Open consent screen"));
        assert!(html.contains("Stored encrypted on this server."));
        assert!(!html.contains("Finish connection"));
    }

    #[test]
    fn second_step_adds_the_paste_field_and_errors_show_as_alerts() {
        let html = render(Phase::Redirect, Some("Too many tries."));
        assert!(html.contains("Finish connection") && html.contains("Cancel"));
        assert!(html.contains("role=\"alert\"") && html.contains("Too many tries."));
    }

    #[test]
    fn local_checks_match_the_old_screen() {
        assert!(!model::google_credentials_ok("short", "secret-long"));
        assert!(model::google_credentials_ok("abcdefghi", "1234567"));
        assert!(model::google_redirect_ok("http://localhost:1/?state=x&code=4%2Fabc"));
        assert!(!model::google_redirect_ok("http://example.com/?code=abc"));
        assert!(!model::google_redirect_ok("http://localhost:1/?state=x"));
        assert!(!model::google_redirect_ok("http://localhost.evil.com/?code=a"));
        let json = r#"{"installed":{"client_id":"id.apps","client_secret":"sec"}}"#;
        assert_eq!(model::google_client_from_json(json), Some(("id.apps".into(), "sec".into())));
        assert_eq!(model::google_client_from_json("{}"), None);
        assert!(model::google_error_text(429, "x").contains("Too many"));
    }
}
