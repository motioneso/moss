use moss_memory::handle;
use moss_memory::testing::Fake;
use serde_json::{json, Value};

fn call(host: &Fake, name: &str, parameters: Value) -> Value {
    let out = handle(host, "api", &json!({"name": name, "parameters": parameters}).to_string()).unwrap();
    serde_json::from_str(&out).unwrap()
}

fn error(answer: &Value) -> (u64, String) {
    (answer["error"]["statusCode"].as_u64().unwrap(), answer["error"]["error"].as_str().unwrap().to_owned())
}

const ID: &str = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

#[test]
fn the_old_error_text_and_limits_are_kept() {
    let host = Fake::new();
    let paths: Vec<String> = (0..501).map(|i| format!("backtrack/{i}")).collect();
    let capped = call(&host, "deleteChunksForSources", json!({"sourceKind": "screen", "sourcePaths": paths}));
    assert_eq!(error(&capped), (400, "deleteChunksForSources accepts at most 500 source paths per call, got 501".into()));
    let importance = call(&host, "updateFactImportance", json!({"id": ID, "importance": 1.5}));
    assert_eq!(error(&importance), (400, "importance must be a number between 0 and 1".into()));
    assert_eq!(error(&call(&host, "nope", json!({}))).0, 404);
    assert_eq!(host.count("memory.public"), 0, "invalid calls never reach the host");
}

#[test]
fn bad_input_is_refused_before_any_host_call() {
    let host = Fake::new();
    for (name, params) in [
        ("searchChunks", json!({"query": "  "})),
        ("searchChunks", json!({"query": "x", "sourceKind": "secrets"})),
        ("embedTurn", json!({"threadId": "not-a-uuid", "userText": "a", "assistantText": "b"})),
        ("insertFact", json!({"category": "mood", "content": "x"})),
        ("insertFact", json!({"category": "fact", "content": "x", "sourceThreadId": "nope"})),
        ("getActiveFact", json!({"id": "1; drop table"})),
        ("createEntity", json!({"kind": "self", "name": "me"})),
        ("insertCandidate", json!({"kind": "fact", "action": "create", "provenance": "confirmed", "candidateSignature": "s"})),
    ] {
        assert_eq!(error(&call(&host, name, params)).0, 400, "{name}");
    }
    assert_eq!(host.count("memory.public"), 0);
}

#[test]
fn calls_send_no_owner_and_no_vector_to_the_host() {
    let host = Fake::new();
    let answer = call(&host, "searchChunks", json!({"query": "tea", "limit": 500, "ownerUserId": "x", "embedding": [1]}));
    assert!(answer.get("ok").is_some());
    let sent = host.sent("memory.public");
    assert_eq!(sent, json!({"name": "searchChunks", "query": "tea", "limit": 50, "sourceKind": "vault"}));
}

#[test]
fn a_host_refusal_becomes_its_plain_status() {
    let mut host = Fake::new();
    host.public = json!({"refused": {"status": 503, "message": "No embedding model is set up"}});
    let answer = call(&host, "searchChunks", json!({"query": "tea"}));
    assert_eq!(error(&answer), (503, "No embedding model is set up".into()));
}

#[test]
fn recall_and_core_use_the_existing_graph_resources() {
    let host = Fake::new();
    assert_eq!(call(&host, "recallMemory", json!({"query": "tea"}))["ok"]["items"], json!([]));
    assert_eq!(error(&call(&host, "recallMemory", json!({"query": " "}))), (400, "query is required".into()));
    assert_eq!(call(&host, "listCoreFacts", json!({"limit": 30}))["ok"]["items"], json!([]));
    assert_eq!(host.sent("memory.core")["limit"], 30);
    assert_eq!(host.count("memory.public"), 0);
}

#[test]
fn paging_and_defaults_match_the_old_repositories() {
    let host = Fake::new();
    call(&host, "listCorrections", json!({"limit": 1000, "offset": -4}));
    let sent = host.sent("memory.public");
    assert_eq!((sent["limit"].as_i64(), sent["offset"].as_i64()), (Some(100), Some(0)));
    call(&host, "insertFact", json!({"category": "goal", "content": "run"}));
    let sent = host.calls.borrow().last().unwrap().2.clone();
    assert_eq!((sent["provenance"].as_str(), sent["importance"].as_f64()), (Some("inferred"), Some(0.5)));
}
