use moss_email::{handle, testing::Fake};
use serde_json::{json, Value};

fn api(host: &Fake, name: &str, parameters: Value) -> Result<Value, String> {
    let request = json!({"name":name,"parameters":parameters});
    handle(host, "api", &request.to_string()).map(|r| serde_json::from_str(&r).unwrap())
}
fn input() -> Value {
    json!({"connectorAccountId":"acct-1","externalId":"ext-1","sender":"a@example.test",
           "subject":"Hi","receivedAt":"2026-01-01T00:00:00.000Z","recipients":["b@example.test"]})
}

#[test]
fn insert_returns_the_stored_message_and_caps_the_excerpt() {
    let host = Fake::default();
    let mut request = input();
    request["bodyExcerpt"] = json!("x".repeat(900));
    let reply = api(&host, "insertCachedMessage", request).unwrap();
    assert_eq!(reply["message"]["bodyExcerpt"].as_str().unwrap().len(), 500);
    assert_eq!(host.messages().len(), 1);
}
#[test]
fn insert_needs_the_required_fields() {
    let host = Fake::default();
    for name in ["connectorAccountId", "externalId", "sender", "subject", "receivedAt"] {
        let mut request = input();
        request.as_object_mut().unwrap().remove(name);
        assert!(api(&host, "insertCachedMessage", request).is_err(), "{name}");
    }
    assert!(host.writes.borrow().is_empty());
}
#[test]
fn a_refused_account_is_an_error() {
    let mut request = input();
    request["connectorAccountId"] = json!("no-such-account");
    assert!(api(&Fake::default(), "insertCachedMessage", request).is_err());
}
#[test]
fn update_changes_only_named_fields_and_misses_cleanly() {
    let host = Fake::default().with_message("m1", "Old");
    let reply = api(&host, "updateCachedMessage", json!({"id":"m1","summary":"Short"})).unwrap();
    assert_eq!(reply["message"]["summary"], "Short");
    assert_eq!(reply["message"]["subject"], "Old");
    assert_eq!(api(&host, "updateCachedMessage", json!({"id":"zzz","summary":"x"})).unwrap_err(), "Email message not found");
    assert!(api(&host, "updateCachedMessage", json!({"id":"m1"})).is_err());
}
#[test]
fn unknown_operations_fail() {
    assert!(api(&Fake::default(), "sendMessage", json!({})).is_err());
}
