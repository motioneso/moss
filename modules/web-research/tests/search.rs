mod common;
use common::{brave_rows, Fake};
use serde_json::json;

fn data(v: &serde_json::Value) -> &serde_json::Value {
    &v["data"]
}

#[test]
fn shapes_results_like_the_old_tool() {
    let host = Fake::new().with_key();
    host.serve(brave_rows(3));
    let out = host.tool(json!({"query": "rust news"}));
    let d = data(&out);
    assert_eq!(d["query"], "rust news");
    assert_eq!(d["results"][0]["resultId"], "web-1");
    assert_eq!(d["results"][0]["domain"], "example.com");
    assert_eq!(d["results"][0]["snippet"], "D1");
    assert_eq!(d["results"][0]["publishedAt"], "2 days ago");
    assert_eq!(d["trace"]["provider"], "brave");
    assert_eq!(d["trace"]["resultCount"], 3);
    assert_eq!(d["trace"]["limitApplied"], false);
    assert_eq!(d["trace"]["queryTruncated"], false);
}

#[test]
fn limit_defaults_to_five_and_clamps() {
    let host = Fake::new().with_key();
    host.serve(brave_rows(9));
    assert_eq!(
        data(&host.tool(json!({"query": "q"})))["results"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        data(&host.tool(json!({"query": "q"})))["trace"]["limitApplied"],
        true
    );
    assert_eq!(
        data(&host.tool(json!({"query": "q", "limit": 99})))["results"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        data(&host.tool(json!({"query": "q", "limit": 0})))["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        data(&host.tool(json!({"query": "q", "limit": 2.9})))["results"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let url = host.requests().last().unwrap()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(url.contains("count=2"));
}

#[test]
fn query_is_cut_to_200_units_and_says_so() {
    let host = Fake::new().with_key();
    let out = host.tool(json!({"query": "a".repeat(300)}));
    assert_eq!(data(&out)["query"].as_str().unwrap().len(), 200);
    assert_eq!(data(&out)["trace"]["queryTruncated"], true);
}

#[test]
fn freshness_maps_to_provider_codes() {
    let host = Fake::new().with_key();
    for (word, code) in [("day", "pd"), ("week", "pw"), ("month", "pm")] {
        host.tool(json!({"query": "q", "freshness": word}));
        let url = host.requests().last().unwrap()["url"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(url.ends_with(&format!("&freshness={code}")), "{url}");
    }
    host.tool(json!({"query": "q", "freshness": "any"}));
    assert!(!host.requests().last().unwrap()["url"]
        .as_str()
        .unwrap()
        .contains("freshness"));
}

#[test]
fn query_is_percent_encoded() {
    let host = Fake::new().with_key();
    host.tool(json!({"query": "a b&c=d"}));
    let url = host.requests()[0]["url"].as_str().unwrap().to_owned();
    assert!(url.contains("q=a%20b%26c%3Dd&"), "{url}");
}

#[test]
fn empty_query_is_refused_without_a_provider_call() {
    let host = Fake::new().with_key();
    let out = host.tool(json!({"query": "   "}));
    assert_eq!(data(&out)["error"], "A search needs words to look for");
    assert!(host.requests().is_empty());
}

#[test]
fn provider_failure_gives_fixed_words() {
    let host = Fake::new().with_key();
    *host.brave.borrow_mut() = None;
    assert_eq!(
        data(&host.tool(json!({"query": "q"})))["error"],
        "Web search is temporarily unavailable"
    );
    *host.brave.borrow_mut() = Some((500, json!({"echo": "q"})));
    let out = host.tool(json!({"query": "q"}));
    assert_eq!(data(&out)["error"], "Web search is temporarily unavailable");
    assert!(!out.to_string().contains("echo"));
}

#[test]
fn no_engine_gives_unavailable_trace_with_the_gate_reason() {
    let host = Fake::new();
    let out = host.tool(json!({"query": "q"}));
    let t = &data(&out)["trace"];
    assert_eq!(t["unavailable"], true);
    assert_eq!(t["provider"], "unavailable");
    assert_eq!(t["reason"], "no-key-no-native-model");
    assert_eq!(data(&out)["results"], json!([]));
    assert!(host.requests().is_empty());
}

#[test]
fn model_native_is_unavailable_until_citations_arrive() {
    let host = Fake::new();
    *host.model.borrow_mut() = Some(true);
    let out = host.tool(json!({"query": "q"}));
    assert_eq!(data(&out)["trace"]["provider"], "model-native");
    assert_eq!(data(&out)["trace"]["reason"], "citations-not-available");
    assert!(host
        .calls
        .borrow()
        .iter()
        .all(|c| c.0 != "ai" || c.1 == "capabilities"));
}

#[test]
fn news_api_search_returns_the_fields_news_reads() {
    let host = Fake::new().with_key();
    host.serve(brave_rows(2));
    let reply = host.api("webSearch", json!({"query": "topic", "limit": 2}));
    let r = &reply["data"]["results"][1];
    assert_eq!(r["title"], "T2");
    assert_eq!(r["url"], "https://Example.COM/p2?x=1");
    assert_eq!(r["snippet"], "D2");
    assert_eq!(r["publishedAt"], "2 days ago");
    *host.brave.borrow_mut() = None;
    assert_eq!(
        host.api("webSearch", json!({"query": "topic"}))["error"],
        "Web search is temporarily unavailable"
    );
}

#[test]
fn unknown_tool_and_api_are_refused() {
    let host = Fake::new();
    assert!(moss_web_research_module::handle(
        &host,
        "tool",
        r#"{"tool":"web.read","parameters":{}}"#
    )
    .is_err());
    assert!(
        moss_web_research_module::handle(&host, "api", r#"{"name":"nope","parameters":{}}"#)
            .is_err()
    );
}
