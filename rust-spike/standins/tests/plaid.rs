//! Contract tests for the Plaid stand-in. Native only, no network.

#[path = "../src/plaid.rs"]
mod plaid;

use plaid::{PlaidConfig, PlaidStandIn};
use serde_json::{json, Value};

fn fake() -> PlaidStandIn {
    PlaidStandIn::new(PlaidConfig {
        client_id: "cid".into(),
        secret: "sec".into(),
        marker: "TOK-MARK".into(),
        private_marker: "PRIV-MARK".into(),
    })
}

fn call(p: &PlaidStandIn, path: &str, body: Value) -> (u16, Value) {
    p.handle("sandbox.plaid.com", path, &body)
}

fn keys(mut body: Value) -> Value {
    body["client_id"] = json!("cid");
    body["secret"] = json!("sec");
    body
}

#[test]
fn calls_without_the_right_keys_are_refused() {
    let p = fake();
    let (status, reply) = call(&p, "/link/token/create", json!({}));
    assert_eq!((status, reply["error_code"].as_str()), (400, Some("INVALID_API_KEYS")));
    let wrong = json!({"client_id":"cid","secret":"nope"});
    assert_eq!(call(&p, "/link/token/create", wrong).0, 400);
}

#[test]
fn a_public_token_works_once_and_the_access_token_carries_the_marker() {
    let p = fake();
    let (_, link) = call(&p, "/link/token/create", keys(json!({})));
    let public = p.complete_link(link["link_token"].as_str().unwrap());
    let (status, first) = call(&p, "/item/public_token/exchange", keys(json!({"public_token":public})));
    assert_eq!(status, 200);
    let access = first["access_token"].as_str().unwrap();
    assert!(access.contains("TOK-MARK"));
    assert_eq!(p.minted_access_tokens(), vec![access.to_string()]);
    assert!(!public.contains("TOK-MARK"), "only access tokens carry the marker");
    let (status, again) = call(&p, "/item/public_token/exchange", keys(json!({"public_token":public})));
    assert_eq!((status, again["error_code"].as_str()), (400, Some("INVALID_PUBLIC_TOKEN")));
}

#[test]
fn an_unknown_access_token_and_unknown_path_fail_like_plaid() {
    let p = fake();
    let (status, reply) = call(&p, "/accounts/get", keys(json!({"access_token":"bogus"})));
    assert_eq!((status, reply["error_code"].as_str()), (400, Some("INVALID_ACCESS_TOKEN")));
    assert_eq!(call(&p, "/nope", keys(json!({}))).0, 404);
}

#[test]
fn every_call_is_recorded() {
    let p = fake();
    call(&p, "/link/token/create", keys(json!({})));
    let seen = p.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/link/token/create");
    assert_eq!(seen[0].body["secret"], "sec");
}
