use moss_memory::handle;
use moss_memory::testing::Fake;
use serde_json::{json, Value};

const ID: &str = "0b7f6d0e-4c1f-4b8e-9d52-6a1d3f2c9e11";

fn send(host: &Fake, method: &str, path: &str, params: Value, query: Value, body: Value) -> (u64, Value) {
    let request = json!({"method": method, "path": path, "params": params, "query": query, "body": body});
    let out = handle(host, "route", &request.to_string()).unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    (response["status"].as_u64().unwrap(), response["body"].clone())
}
fn with_id(host: &Fake, method: &str, path: &str, body: Value) -> (u64, Value) {
    send(host, method, path, json!({"id": ID}), json!({}), body)
}
fn refusal(status: u64, message: &str) -> Value {
    json!({"refused": {"status": status, "message": message}})
}

#[test]
fn candidates_page_five_at_a_time_with_bounded_text() {
    let mut host = Fake::new();
    let long = "x".repeat(300);
    host.screen = json!({"total": 8, "hasMore": true, "nextCursor": "c", "items": [
        {"id": ID, "kind": "fact", "status": "pending", "provenance": "inferred",
         "createdAt": "2026-11-10T10:00:00.000000Z",
         "payload": {"kind": "fact", "recordKind": "goal",
                     "fact": {"subject": "Priya", "predicate": "works_on", "objectText": long}}}]});
    let (status, body) = send(&host, "GET", "/candidates", json!({}), json!({}), json!({}));
    assert_eq!(status, 200);
    assert_eq!(body["total"], 8);
    assert_eq!(body["remainingCount"], 7);
    assert_eq!(body["nextCursor"], "c");
    let item = &body["items"][0];
    assert_eq!(item["recordKind"], "goal");
    assert_eq!(item["titleTruncated"], true);
    assert_eq!(item["title"].as_str().unwrap().chars().count(), 120);
    assert_eq!(item["summary"].as_str().unwrap().chars().count(), 200);
    assert_eq!(host.sent("memory.candidates")["limit"], 5);
}

#[test]
fn candidates_refuse_offset_paging() {
    let host = Fake::new();
    let (status, body) = send(&host, "GET", "/candidates", json!({}), json!({"offset": 5}), json!({}));
    assert_eq!(status, 400);
    assert_eq!(body["error"], "Use cursor paging; omit cursor to start, then pass nextCursor");
    assert_eq!(host.count("memory.candidates"), 0);
}

#[test]
fn a_bad_cursor_from_the_host_is_a_400() {
    let mut host = Fake::new();
    host.screen = refusal(400, "Invalid cursor");
    let (status, body) = send(&host, "GET", "/candidates", json!({}), json!({"cursor": "nope"}), json!({}));
    assert_eq!((status, body["error"].as_str()), (400, Some("Invalid cursor")));
}

#[test]
fn accept_saves_then_indexes_and_reports_accepted() {
    let mut host = Fake::new();
    host.screen = json!({"fact": {"id": ID}});
    let (status, body) = with_id(&host, "POST", "/candidates/:id/accept", json!({}));
    assert_eq!((status, body), (200, json!({"accepted": true})));
    assert_eq!(host.sent("memory.candidate")["action"], "accept");
    assert_eq!(host.count("memory.index"), 1);
}

#[test]
fn accept_with_old_arguments_is_refused_before_the_host_is_called() {
    let host = Fake::new();
    for body in [json!({"resolveConflictWithFactId": ID}), json!({"supersedeFactIds": [ID]})] {
        let (status, reply) = with_id(&host, "POST", "/candidates/:id/accept", body);
        assert_eq!(status, 400);
        assert_eq!(
            reply["error"],
            "Accepting a suggestion adds a memory; it does not replace existing memories"
        );
    }
    assert_eq!(host.count("memory.candidate"), 0);
}

#[test]
fn accept_passes_a_refusal_through_and_does_not_index() {
    let mut host = Fake::new();
    host.screen = refusal(409, "More than one memory entity is named \"Pri\". Merge or rename them, then approve again.");
    let (status, body) = with_id(&host, "POST", "/candidates/:id/accept", json!({}));
    assert_eq!(status, 409);
    assert!(body["error"].as_str().unwrap().starts_with("More than one memory entity"));
    assert_eq!(host.count("memory.index"), 0);
}

#[test]
fn reject_and_suppress_answer_204_and_a_gone_candidate_is_404() {
    let mut host = Fake::new();
    for action in ["reject", "suppress"] {
        let (status, _) = with_id(&host, "POST", &format!("/candidates/:id/{action}"), json!({"reason": "no"}));
        assert_eq!(status, 204);
        assert_eq!(host.sent("memory.candidate")["action"], action);
        host.calls.borrow_mut().clear();
    }
    host.screen = refusal(404, "Candidate not found or not pending");
    let (status, body) = with_id(&host, "POST", "/candidates/:id/reject", json!({}));
    assert_eq!((status, body["error"].as_str()), (404, Some("Candidate not found or not pending")));
    let (status, _) = send(&host, "POST", "/candidates/:id/reject", json!({"id": "bad"}), json!({}), json!({}));
    assert_eq!(status, 404);
}

#[test]
fn dashboard_adds_a_confidence_tier_to_each_fact() {
    let mut host = Fake::new();
    host.screen = json!({"counts": {"saved": 1}, "hasMore": false, "nextCursor": null, "items": [
        {"id": ID, "confidence": 0.95, "provenance": "confirmed", "lastConfirmedAt": null}]});
    let (status, body) = send(&host, "GET", "/dashboard", json!({}), json!({"q": "tea", "view": "saved"}), json!({}));
    assert_eq!(status, 200);
    assert_eq!(body["items"][0]["confidenceTier"], "confirmed");
    assert_eq!(host.sent("memory.facts")["q"], "tea");
}

#[test]
fn dashboard_rejects_unknown_filters_values() {
    let host = Fake::new();
    let (status, _) = send(&host, "GET", "/dashboard", json!({}), json!({"sourceKind": "carrier-pigeon"}), json!({}));
    assert_eq!(status, 400);
    assert_eq!(host.count("memory.facts"), 0);
}

#[test]
fn patching_a_fact_or_entity_maps_refusals() {
    let mut host = Fake::new();
    let (status, body) = with_id(&host, "PATCH", "/graph/facts/:id", json!({"pinned": true}));
    assert_eq!((status, body), (200, json!({"patched": true})));
    assert_eq!(host.sent("memory.fact-patch")["factId"], ID);
    host.screen = refusal(404, "Fact not found");
    assert_eq!(with_id(&host, "PATCH", "/graph/facts/:id", json!({"pinned": true})).0, 404);
    host.screen = refusal(409, "Entity has associated facts; delete facts first");
    assert_eq!(with_id(&host, "PATCH", "/graph/entities/:id", json!({"status": "archived"})).0, 409);
    assert_eq!(with_id(&host, "DELETE", "/graph/entities/:id", json!({})).0, 409);
    host.screen = refusal(403, "The self memory entity cannot be changed");
    assert_eq!(with_id(&host, "DELETE", "/graph/entities/:id", json!({})).0, 403);
    host.screen = json!({"deleted": true});
    assert_eq!(with_id(&host, "DELETE", "/graph/entities/:id", json!({})).0, 204);
}

#[test]
fn adding_a_memory_by_hand_names_the_subject_and_the_source() {
    let mut host = Fake::new();
    host.screen = json!({"entityId": "e1"});
    let (status, body) = send(
        &host,
        "POST",
        "/memories",
        json!({}),
        json!({}),
        json!({"text": "  Anna lives in Porto ", "recordKind": "preference", "about": "Anna", "pinned": true}),
    );
    assert_eq!(status, 200);
    assert!(body["fact"]["confidenceTier"].is_string());
    let sent = host.sent("memory.fact");
    assert_eq!(sent["objectText"], "Anna lives in Porto");
    assert_eq!(sent["predicate"], "prefers");
    assert_eq!(sent["subjectEntityId"], "e1");
    assert_eq!(sent["source"]["sourceLabel"], "Added by you");
    assert_eq!(sent["pinned"], true);
    assert_eq!(host.count("memory.index"), 1);
}

#[test]
fn adding_empty_text_is_refused_and_an_ambiguous_name_saves_nothing() {
    let mut host = Fake::new();
    let (status, _) = send(&host, "POST", "/memories", json!({}), json!({}), json!({"text": "   "}));
    assert_eq!(status, 400);
    host.screen = refusal(409, "More than one memory entity is named \"Pri\". Merge or rename them, then approve again.");
    let (status, _) = send(&host, "POST", "/memories", json!({}), json!({}), json!({"text": "x", "about": "Pri"}));
    assert_eq!(status, 409);
    assert_eq!(host.count("memory.fact"), 0);
}
