use moss_memory::handle;
use moss_memory::testing::Fake;
use serde_json::{json, Value};

const ID: &str = "0b7f6d0e-4c1f-4b8e-9d52-6a1d3f2c9e11";

fn route(host: &Fake, method: &str, pattern: &str, id: &str, body: Value) -> (u64, Value) {
    let request = json!({"method": method, "path": pattern, "params": {"id": id}, "body": body});
    let out = handle(host, "route", &request.to_string()).unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    (response["status"].as_u64().unwrap(), response["body"].clone())
}

fn tool(host: &Fake, parameters: Value, approval: Option<&str>) -> Result<Value, String> {
    let mut request = json!({"tool": "memory.forget", "parameters": parameters});
    if let Some(version) = approval {
        request["approvalVersion"] = json!(version);
    }
    handle(host, "tool", &request.to_string()).map(|s| serde_json::from_str(&s).unwrap())
}

fn api(host: &Fake, tool: &str, input: Value) -> Value {
    let request = json!({"name": "prepareMemoryAction",
        "parameters": {"tool": tool, "inputJson": input.to_string()}});
    serde_json::from_str(&handle(host, "api", &request.to_string()).unwrap()).unwrap()
}

fn refusal(status: u64, message: &str) -> Value {
    json!({"refused": {"status": status, "message": message}})
}

fn fact() -> Value {
    json!({"fact": {"id": ID, "confidence": 0.95, "provenance": "confirmed",
        "lastConfirmedAt": "2026-11-11T00:00:00.000Z", "status": "active"}})
}

const ROUTES: &[(&str, &str, u64)] = &[
    ("POST", "/graph/facts/:id/pin", 204),
    ("POST", "/graph/facts/:id/supersede", 204),
    ("DELETE", "/graph/facts/:id", 204),
];

fn body_for(pattern: &str) -> Value {
    match pattern {
        "/graph/facts/:id/pin" => json!({"pinned": true}),
        _ => json!({}),
    }
}

#[test]
fn bodiless_success_routes_answer_204() {
    let host = Fake::new();
    for (method, pattern, status) in ROUTES {
        assert_eq!(route(&host, method, pattern, ID, body_for(pattern)).0, *status, "{pattern}");
    }
    assert_eq!(host.count("memory.lifecycle"), 3);
}

#[test]
fn fact_routes_return_the_fact_with_its_tier() {
    let mut host = Fake::new();
    host.lifecycle = fact();
    for (pattern, body) in [
        ("/graph/facts/:id/confirm", json!({})),
        ("/graph/facts/:id/mark-stale", json!({})),
        ("/graph/facts/:id/status", json!({"status": "stale", "reason": "old"})),
        ("/graph/facts/:id/correct", json!({"replacementText": " tea "})),
    ] {
        let (status, out) = route(&host, "POST", pattern, ID, body);
        assert_eq!(status, 200, "{pattern}");
        assert_eq!(out["fact"]["id"], ID);
        assert!(out["fact"]["confidenceTier"].is_string(), "{pattern}");
    }
    assert_eq!(host.sent("memory.lifecycle")["action"], "confirm");
}

#[test]
fn every_route_answers_404_when_the_fact_is_missing() {
    let mut host = Fake::new();
    host.lifecycle = refusal(404, "Memory fact not found");
    let all = [
        ("POST", "/graph/facts/:id/pin", json!({"pinned": false})),
        ("POST", "/graph/facts/:id/confirm", json!({})),
        ("POST", "/graph/facts/:id/correct", json!({"replacementText": "x"})),
        ("POST", "/graph/facts/:id/status", json!({"status": "stale"})),
        ("POST", "/graph/facts/:id/mark-stale", json!({})),
        ("POST", "/graph/facts/:id/supersede", json!({})),
        ("DELETE", "/graph/facts/:id", Value::Null),
    ];
    for (method, pattern, body) in all {
        let (status, out) = route(&host, method, pattern, ID, body);
        assert_eq!((status, out["error"].as_str()), (404, Some("Memory fact not found")), "{pattern}");
    }
}

#[test]
fn a_malformed_id_is_not_found_and_never_reaches_the_host() {
    let host = Fake::new();
    let (status, out) = route(&host, "DELETE", "/graph/facts/:id", "not-a-uuid", Value::Null);
    assert_eq!((status, out["error"].as_str()), (404, Some("Memory fact not found")));
    assert_eq!(host.count("memory.lifecycle"), 0);
}

#[test]
fn host_refusals_keep_their_status_and_wording() {
    let mut host = Fake::new();
    let cases = [
        (409, "This recording's memory has changed or is being removed; refresh its saved state before continuing"),
        (400, "conflict-group memory must be resolved with confirm or correct"),
        (400, "Cannot reactivate a superseded memory record; create a new fact instead"),
    ];
    for (code, message) in cases {
        host.lifecycle = refusal(code, message);
        let (status, out) = route(&host, "POST", "/graph/facts/:id/status", ID, json!({"status": "active"}));
        assert_eq!((status, out["error"].as_str()), (code, Some(message)));
    }
}

#[test]
fn bodies_are_checked_like_the_old_schemas() {
    let host = Fake::new();
    let bad = [
        ("/graph/facts/:id/pin", json!({})),
        ("/graph/facts/:id/status", json!({"status": "gone"})),
        ("/graph/facts/:id/status", json!({})),
        ("/graph/facts/:id/correct", json!({})),
        ("/graph/facts/:id/correct", json!({"replacementText": "   "})),
        ("/graph/facts/:id/supersede", json!({"validTo": {"a": 1}})),
    ];
    for (pattern, body) in bad {
        assert_eq!(route(&host, "POST", pattern, ID, body).0, 400, "{pattern}");
    }
    assert_eq!(host.count("memory.lifecycle"), 0);
}

#[test]
fn a_correction_asks_the_host_to_index_the_replacement() {
    let mut host = Fake::new();
    host.lifecycle = fact();
    route(&host, "POST", "/graph/facts/:id/correct", ID, json!({"replacementText": "tea"}));
    assert_eq!(host.count("memory.index"), 1);
    let mut failing = Fake::new();
    failing.lifecycle = fact();
    failing.index_fails = true;
    let (status, _) = route(&failing, "POST", "/graph/facts/:id/correct", ID, json!({"replacementText": "tea"}));
    assert_eq!(status, 200);
}

#[test]
fn the_forget_card_names_the_memory_and_carries_its_version() {
    let mut host = Fake::new();
    host.target = json!({"target": {"label": "Self: prefers: tea", "version": "v1"}});
    let out = api(&host, "memory.forget", json!({"factId": ID}));
    assert_eq!(out["ok"], json!({"target": "Self: prefers: tea", "fields": [],
        "version": "v1", "approvalKind": "memory_delete"}));
}

#[test]
fn the_forget_card_refuses_bad_input_and_missing_memories() {
    let host = Fake::new();
    assert_eq!(api(&host, "memory.forget", json!({"factId": "nope"}))["ok"], Value::Null);
    assert_eq!(api(&host, "memory.forget", json!({"factId": ID, "extra": 1}))["ok"], Value::Null);
    let gone = api(&host, "memory.forget", json!({"factId": ID}));
    assert_eq!(gone["error"]["statusCode"], 409);
    assert_eq!(api(&host, "memory.other", json!({"factId": ID}))["error"]["statusCode"], 400);
}

#[test]
fn forget_sends_the_approved_version_to_the_host() {
    let host = Fake::new();
    let out = tool(&host, json!({"factId": ID}), Some("v1")).unwrap();
    assert_eq!(out["data"]["deleted"], true);
    assert_eq!(host.sent("memory.forget"), json!({"factId": ID, "version": "v1"}));
}

#[test]
fn forget_refuses_a_changed_memory_and_a_missing_approval() {
    let mut host = Fake::new();
    host.forget = json!({"deleted": false});
    let changed: Value = serde_json::from_str(&tool(&host, json!({"factId": ID}), Some("old")).unwrap_err()).unwrap();
    assert_eq!(changed["statusCode"], 409);
    assert_eq!(changed["error"], "The memory changed or is no longer available. Find it again and review a new request.");
    let bare: Value = serde_json::from_str(&tool(&host, json!({"factId": ID}), None).unwrap_err()).unwrap();
    assert_eq!(bare["statusCode"], 503);
    assert_eq!(host.count("memory.forget"), 1);
    assert!(tool(&host, json!({"factId": ID, "more": 1}), Some("v")).is_err());
    assert!(tool(&host, json!({"factId": "nope"}), Some("v")).is_err());
}
