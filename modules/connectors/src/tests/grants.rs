use moss_connectors::grants::{effective, is_granted, key, merged};
use serde_json::{json, Value};

fn scopes(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn key_names_the_account() {
    assert_eq!(key("abc"), "connector.abc.feature_grants");
}
#[test]
fn missing_or_odd_stored_values_grant_everything() {
    for stored in [Value::Null, json!("x"), json!(5), json!([])] {
        assert!(is_granted(&stored, "email") && is_granted(&stored, "calendar"));
    }
}
#[test]
fn an_object_grants_only_what_is_exactly_true() {
    let stored = json!({"email":true,"calendar":"true"});
    assert!(is_granted(&stored, "email"));
    assert!(!is_granted(&stored, "calendar"));
    assert!(!is_granted(&json!({}), "email"));
}
#[test]
fn a_feature_needs_both_the_scope_and_the_grant() {
    let google = scopes(&["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar"]);
    assert_eq!(effective(&google, &Value::Null), json!({"email":true,"calendar":true}));
    assert_eq!(effective(&google, &json!({"email":false,"calendar":true})), json!({"email":false,"calendar":true}));
    assert_eq!(effective(&scopes(&["email.read"]), &Value::Null), json!({"email":true,"calendar":false}));
    assert_eq!(effective(&scopes(&["unrelated"]), &Value::Null), json!({"email":false,"calendar":false}));
}
#[test]
fn a_put_keeps_the_feature_it_does_not_mention() {
    let stored = json!({"email":false,"calendar":true});
    assert_eq!(merged(&stored, Some(true), None), json!({"email":true,"calendar":true}));
    assert_eq!(merged(&Value::Null, None, Some(false)), json!({"email":true,"calendar":false}));
}
