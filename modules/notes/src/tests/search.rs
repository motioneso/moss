use moss_module_sdk::{Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::cell::RefCell;

#[derive(Default)]
struct Ports(RefCell<Vec<Value>>);
impl Host for Ports {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        assert_eq!(
            (port, operation, resource),
            ("vault", "index.search", "source")
        );
        self.0.borrow_mut().push(parameters);
        Ok(
            json!({"chunks":[{"sourcePath":"/notes/private.md","lineStart":1,"lineEnd":2,"text":"Private café 🌱"}]}),
        )
    }
}

#[test]
fn search_trims_query_and_uses_legacy_limit_coercion() {
    for (limit, expected) in [
        (json!(null), 1),
        (json!(false), 1),
        (json!(true), 1),
        (json!("3.9"), 3),
        (json!(-3), 1),
        (json!(200), 20),
        (json!("NaN"), 8),
        (json!([]), 1),
        (json!([4]), 4),
        (json!({}), 8),
        (json!("0x10"), 16),
    ] {
        let ports = Ports::default();
        let result = handle(&ports, "tool", &json!({"tool":"notes.search","parameters":{"query":"\u{feff}  café 🌱\r\n", "limit":limit}}).to_string()).unwrap();
        assert_eq!(
            *ports.0.borrow(),
            vec![json!({"query":"café 🌱","limit":expected})]
        );
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["data"]["chunks"][0]["text"],
            "Private café 🌱"
        );
    }
    let ports = Ports::default();
    handle(
        &ports,
        "tool",
        r#"{"tool":"notes.search","parameters":{"query":"q"}}"#,
    )
    .unwrap();
    assert_eq!(ports.0.borrow()[0]["limit"], 8);
}

#[test]
fn empty_queries_do_not_access_memory_or_embeddings() {
    for query in [
        Value::Null,
        json!(42),
        json!(false),
        json!([]),
        json!("\u{feff}\r\n "),
    ] {
        let ports = Ports::default();
        let out = handle(
            &ports,
            "tool",
            &json!({"tool":"notes.search","parameters":{"query":query}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"data":{"chunks":[]}})
        );
        assert!(ports.0.borrow().is_empty());
    }
}

#[test]
fn input_and_projection_match_actual_legacy_execute() {
    for line in include_str!("search-vectors.jsonl").lines() {
        let case: Value = serde_json::from_str(line).unwrap();
        let ports = Ports::default();
        let out = handle(&ports, "tool", &case["request"].to_string()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            case["expected"],
            "{}",
            case["request"]
        );
        let calls: Vec<_> = ports
            .0
            .borrow()
            .iter()
            .map(|p| json!({"query":p["query"],"limit":p["limit"],"kind":"notes"}))
            .collect();
        assert_eq!(json!(calls), case["calls"]);
    }
}
