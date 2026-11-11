//! Reads `[{method,url,body?}]` on stdin and seed entries, runs each through the guest
//! on one in-memory host, and prints `[{status,body}]`. Compared with the old server by
//! `tools/routes-parity.ts`.
use moss_email::{handle, testing::Fake};
use serde_json::{json, Value};
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
    let mut host = Fake::default();
    let mut out = Vec::new();
    for case in cases {
        if let Some(seed) = case["seed"].as_object() {
            host = host.with_message(seed["id"].as_str().unwrap(), seed["subject"].as_str().unwrap());
            continue;
        }
        let (path, id) = route_of(case["url"].as_str().unwrap());
        let request = json!({
            "method": case["method"], "path": path,
            "params": id.map(|id| json!({"id":id})).unwrap_or(json!({})),
            "body": case.get("body").cloned().unwrap_or(Value::Null),
        });
        let reply = handle(&host, "route", &request.to_string()).unwrap();
        out.push(serde_json::from_str::<Value>(&reply).unwrap());
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}

/// Maps an old-style URL onto a manifest route pattern and its id.
fn route_of(url: &str) -> (String, Option<String>) {
    let rest = url.strip_prefix("/api/email").unwrap().to_string();
    match rest.strip_prefix("/messages/") {
        Some(id) => ("/messages/:id".into(), Some(id.to_string())),
        None => (rest, None),
    }
}
