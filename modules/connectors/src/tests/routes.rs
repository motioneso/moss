use moss_connectors::{handle, testing::Fake};
use serde_json::{json, Value};

fn call(host: &Fake, method: &str, path: &str, id: Option<&str>, body: Value) -> (u64, Value) {
    let request = json!({"method":method,"path":path,"params":id.map(|i| json!({"id":i})).unwrap_or(json!({})),"body":body});
    let reply: Value = serde_json::from_str(&handle(host, "route", &request.to_string()).unwrap()).unwrap();
    (reply["status"].as_u64().unwrap(), reply["body"].clone())
}

#[test]
fn create_returns_201_and_a_safe_account() {
    let host = Fake::default();
    let (status, body) = call(&host, "POST", "/accounts", None, json!({"providerId":"google","tokenPayload":{"refresh":"SENTINEL-TOKEN"}}));
    assert_eq!(status, 201);
    assert_eq!(body["account"]["hasSecret"], true);
    assert!(!body.to_string().contains("SENTINEL-TOKEN"));
}
#[test]
fn every_response_hides_planted_secrets() {
    let host = Fake::default();
    let secret = json!({"password":"SENTINEL-PASSWORD","access":"SENTINEL-ACCESS"});
    let mut seen = Vec::new();
    seen.push(call(&host, "POST", "/accounts", None, json!({"providerId":"google","tokenPayload":secret})));
    seen.push(call(&host, "POST", "/accounts", None, json!({"providerId":"nope","tokenPayload":secret})));
    seen.push(call(&host, "POST", "/accounts", None, json!({"providerId":"outlook-browser-calendar","tokenPayload":secret})));
    seen.push(call(&host, "POST", "/accounts", None, json!({"tokenPayload":secret})));
    seen.push(call(&host, "PATCH", "/accounts/:id", Some("acct-1"), json!({"tokenPayload":secret,"status":"error"})));
    seen.push(call(&host, "PATCH", "/accounts/:id", Some("missing"), json!({"tokenPayload":secret})));
    seen.push(call(&host, "POST", "/accounts/:id/revoke", Some("acct-1"), Value::Null));
    seen.push(call(&host, "GET", "/accounts", None, Value::Null));
    seen.push(call(&host, "GET", "/admin/accounts", None, Value::Null));
    seen.push(call(&host, "GET", "/accounts/:id/feature-grants", Some("acct-1"), Value::Null));
    let text = serde_json::to_string(&seen).unwrap();
    assert!(!text.contains("SENTINEL"), "{text}");
}
#[test]
fn a_host_failure_becomes_a_scrubbed_500() {
    let mut host = Fake::default();
    host.failing = true;
    let (status, body) = call(&host, "GET", "/accounts", None, Value::Null);
    assert_eq!((status, body), (500, json!({"error":"Internal server error"})));
}
#[test]
fn unknown_routes_are_404() {
    assert_eq!(call(&Fake::default(), "GET", "/nothing", None, Value::Null).0, 404);
}
#[test]
fn a_grants_put_sends_one_audit_entry_per_named_feature() {
    let host = Fake::default().with_account("acct-9", "google", &["https://www.googleapis.com/auth/gmail.modify"]);
    let (status, body) = call(&host, "PUT", "/accounts/:id/feature-grants", Some("acct-9"), json!({"email":false}));
    assert_eq!((status, body), (200, json!({"email":false,"calendar":false})));
    let writes = host.writes.borrow();
    let audit = &writes.last().unwrap()["parameters"]["audit"];
    assert_eq!(audit, &json!([{"feature":"email","enabled":false}]));
}
