mod common;
use common::{brave_rows, Fake};
use serde_json::json;

const MARKER: &str = "zq7-private-marker-9431";

#[test]
fn query_text_only_reaches_the_provider_address() {
    let host = Fake::new().with_key();
    host.serve(brave_rows(1));
    host.tool(json!({"query": MARKER}));
    host.api("webSearch", json!({"query": MARKER}));
    for (port, op, resource, params) in host.calls.borrow().iter() {
        let seen = format!("{resource}{params}");
        if port == "credentials" && op == "request" {
            assert!(params["url"].as_str().unwrap().contains(MARKER));
            assert!(!resource.contains(MARKER));
            assert!(params.get("body").is_none() && params.get("headers").is_none());
        } else {
            assert!(!seen.contains(MARKER), "{port}.{op} carried the query");
        }
    }
}

#[test]
fn failures_never_echo_the_query_or_reply() {
    let host = Fake::new().with_key();
    *host.brave.borrow_mut() = Some((400, json!({"error": MARKER})));
    assert!(!host.tool(json!({"query": MARKER})).to_string().contains(MARKER));
    assert!(!host.api("webSearch", json!({"query": MARKER})).to_string().contains(MARKER));
}

#[test]
fn the_key_is_never_asked_for_or_returned() {
    let host = Fake::new().with_key();
    host.tool(json!({"query": "q"}));
    host.route("GET", "/status");
    for c in host.calls.borrow().iter() {
        assert!(c.0 != "credentials" || matches!(c.1.as_str(), "status" | "request"));
    }
}
