use moss_memory::handle;
use moss_memory::testing::Fake;
use serde_json::{json, Value};

fn route(host: &Fake, method: &str, path: &str, query: Value, body: Value) -> (u64, Value) {
    let request = json!({"method": method, "path": path, "query": query, "body": body});
    let out = handle(host, "route", &request.to_string()).unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    (response["status"].as_u64().unwrap(), response["body"].clone())
}

fn tool(host: &Fake, name: &str, parameters: Value) -> Result<Value, String> {
    let request = json!({"tool": name, "parameters": parameters});
    handle(host, "tool", &request.to_string()).map(|s| serde_json::from_str::<Value>(&s).unwrap())
}

fn source() -> Value {
    json!({"sourceKind": "chat", "sourceRef": "t1", "excerpt": "said so"})
}

fn candidate(id: &str, text: &str, similarity: f64) -> Value {
    json!({"similarity": similarity, "searchText": text, "fact": {
        "id": id, "subjectEntityId": "s1", "predicate": "prefers", "objectEntityId": null,
        "objectText": text, "recordKind": "preference", "confidence": 0.9,
        "provenance": "volunteered", "status": "active", "validFrom": null, "validTo": null,
        "staleAt": null, "supersededByFactId": null, "conflictGroupId": null,
        "lastConfirmedAt": null, "importance": 0.5, "pinned": false,
        "createdAt": "2026-11-01T00:00:00.000Z", "updatedAt": "2026-11-01T00:00:00.000Z",
        "sources": []
    }})
}

#[test]
fn health_and_unknown_things() {
    let host = Fake::new();
    assert_eq!(handle(&host, "health", "{}").unwrap(), "{}");
    assert_eq!(route(&host, "GET", "/graph/nope", json!({}), Value::Null).0, 404);
    assert!(tool(&host, "memory.nope", json!({})).is_err());
}

#[test]
fn recall_route_trims_the_query_and_drops_the_subject_name() {
    let mut host = Fake::new();
    host.recall = json!({"nowMs": 1.7829e12, "candidates": [candidate("a", "coffee", 0.9)],
        "names": {"s1": "Sam"}});
    let (status, body) = route(&host, "GET", "/graph/recall", json!({"q": "  coffee "}), Value::Null);
    assert_eq!(status, 200);
    assert_eq!(body["query"], "coffee");
    assert_eq!(body["items"][0]["id"], "a");
    assert!(body["items"][0].get("subjectName").is_none());
    assert_eq!(host.sent("memory.recall")["query"], "coffee");
}

#[test]
fn the_recall_tool_keeps_the_subject_name_and_wraps_in_data() {
    let mut host = Fake::new();
    host.recall = json!({"nowMs": 1.7829e12, "candidates": [candidate("a", "coffee", 0.9)],
        "names": {"s1": "Sam"}});
    let out = tool(&host, "memory.recall", json!({"query": "coffee"})).unwrap();
    assert_eq!(out["data"]["items"][0]["subjectName"], "Sam");
    let blank = tool(&host, "memory.recall", json!({"query": "  "})).unwrap();
    assert_eq!(blank, json!({"data": {"query": "", "items": []}}));
}

#[test]
fn recall_rejects_a_missing_or_blank_query() {
    let host = Fake::new();
    let (status, body) = route(&host, "GET", "/graph/recall", json!({}), Value::Null);
    assert_eq!((status, body["error"].as_str().unwrap()), (400, "querystring must have required property 'q'"));
    let (status, body) = route(&host, "GET", "/graph/recall", json!({"q": " "}), Value::Null);
    assert_eq!((status, body["error"].as_str().unwrap()), (400, "q is required"));
    assert_eq!(host.count("memory.recall"), 0);
}

#[test]
fn an_embedding_refusal_becomes_its_status() {
    let mut host = Fake::new();
    host.recall = json!({"refused": {"status": 503, "message": "Memory search is unavailable"}});
    let (status, body) = route(&host, "GET", "/graph/recall", json!({"q": "x"}), Value::Null);
    assert_eq!((status, body["error"].as_str().unwrap()), (503, "Memory search is unavailable"));
}

#[test]
fn core_route_scores_every_fact_one() {
    let mut host = Fake::new();
    host.core = json!({"facts": [candidate("a", "tea", 0.0)["fact"].clone()], "names": {}});
    let (status, body) = route(&host, "GET", "/graph/core", json!({}), Value::Null);
    assert_eq!((status, body["query"].as_str().unwrap()), (200, ""));
    assert_eq!(body["items"][0]["score"], 1.0);
}

#[test]
fn entity_route_fills_defaults() {
    let host = Fake::new();
    let (status, body) =
        route(&host, "POST", "/graph/entities", json!({}), json!({"kind": "person", "name": "Sam"}));
    assert_eq!(status, 200);
    assert_eq!(body["entity"]["name"], "Sam");
    let sent = host.sent("memory.entity");
    assert_eq!((sent["summary"].as_str(), sent["importance"].as_f64(), sent["pinned"].as_bool()),
        (Some(""), Some(0.5), Some(false)));
    let (status, _) = route(&host, "POST", "/graph/entities", json!({}), json!({"kind": "bogus", "name": "x"}));
    assert_eq!(status, 400);
}

#[test]
fn fact_route_defaults_and_derives_the_record_kind() {
    let host = Fake::new();
    let body = json!({"predicate": "has_goal", "objectText": "learn rust", "source": source()});
    let (status, out) = route(&host, "POST", "/graph/facts", json!({}), body);
    assert_eq!(status, 200);
    assert_eq!(out["fact"]["id"], "f1");
    assert_eq!(out["fact"]["confidenceTier"], "medium");
    assert!(out.get("searchPending").is_none());
    let sent = host.sent("memory.fact");
    assert_eq!(sent["recordKind"], "goal");
    assert_eq!(sent["confidence"], 0.6);
    assert_eq!(sent["provenance"], "inferred");
    assert_eq!(sent["importance"], 0.5);
    assert_eq!(host.count("memory.index"), 1);
}

#[test]
fn a_fact_needs_exactly_one_object_target() {
    let host = Fake::new();
    for extra in [json!({}), json!({"objectText": "a", "objectEntityId": "b"})] {
        let mut body = json!({"predicate": "prefers", "source": source()});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let (status, out) = route(&host, "POST", "/graph/facts", json!({}), body);
        assert_eq!((status, out["error"].as_str().unwrap()), (400, "memory fact requires exactly one object target"));
    }
    assert_eq!(host.count("memory.fact"), 0);
}

#[test]
fn a_failed_embedding_keeps_the_fact_and_flags_it() {
    let mut host = Fake::new();
    host.index_fails = true;
    let body = json!({"predicate": "prefers", "objectText": "tea", "source": source()});
    let (status, out) = route(&host, "POST", "/graph/facts", json!({}), body);
    assert_eq!(status, 200);
    assert_eq!(out["fact"]["id"], "f1");
    assert_eq!(out["searchPending"], true);
    assert_eq!(host.count("memory.fact"), 1);
    assert_eq!(host.count("memory.index"), 2);
    let said = tool(&host, "memory.remember",
        json!({"predicate": "prefers", "objectText": "tea", "source": source()})).unwrap();
    assert_eq!(said, json!({"data": {"factId": "f1", "searchPending": true}}));
}

#[test]
fn remember_tool_answers_with_the_fact_id_and_trims() {
    let host = Fake::new();
    let params = json!({"predicate": "prefers", "objectText": " tea ",
        "source": {"sourceKind": "chat", "sourceRef": "t1", "excerpt": " said so "}});
    assert_eq!(tool(&host, "memory.remember", params).unwrap(), json!({"data": {"factId": "f1"}}));
    let sent = host.sent("memory.fact");
    assert_eq!((sent["predicate"].as_str(), sent["objectText"].as_str()), (Some("prefers"), Some("tea")));
    assert_eq!(sent["source"]["excerpt"], "said so");
    assert!(tool(&host, "memory.remember", json!({"predicate": "prefers"})).is_err());
}

#[test]
fn explicit_nulls_stay_null() {
    let host = Fake::new();
    let body = json!({
        "predicate": "prefers", "objectText": "tea", "objectEntityId": null,
        "source": {"sourceKind": "chat", "sourceRef": "t1", "excerpt": "x", "occurredAt": null}
    });
    let (status, _) = route(&host, "POST", "/graph/facts", json!({}), body);
    assert_eq!(status, 200);
    let sent = host.sent("memory.fact");
    assert!(sent["objectEntityId"].is_null());
    assert!(sent["source"]["occurredAt"].is_null());
    assert_eq!(sent["objectText"], "tea");
}
