//! Reads `[{method,url,body,admin?}]` on stdin, runs each through the guest on one
//! in-memory host, and prints `[{status,body}]`. Compared with the old server by
//! `tools/routes-parity.ts`.
use moss_connectors::{handle, testing::Fake};
use serde_json::{json, Value};
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
    let mut host = Fake::default();
    let mut out = Vec::new();
    for case in cases {
        match case["op"].as_str() {
            Some("grants") => {
                let scopes: Vec<String> = serde_json::from_value(case["scopes"].clone()).unwrap();
                out.push(moss_connectors::grants::effective(&scopes, &case["stored"]));
                continue;
            }
            Some("health") => {
                let rows: Vec<Value> = serde_json::from_value(case["rows"].clone()).unwrap();
                out.push(moss_connectors::health::section(&rows, &case["outlook"], case["limit"].as_i64().unwrap()));
                continue;
            }
            _ => {}
        }
        if let Some(seed) = case["seed"].as_object() {
            let scopes: Vec<&str> = seed["scopes"]
                .as_array()
                .map(|s| s.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            host = host.with_account(
                seed["id"].as_str().unwrap(),
                seed["providerId"].as_str().unwrap(),
                &scopes,
            );
            continue;
        }
        host.admin = match case["admin"].as_str() {
            Some("forbidden") => "forbidden",
            Some("unauthenticated") => "unauthenticated",
            _ => "ok",
        };
        let url = case["url"].as_str().unwrap();
        let (path, id) = route_of(url);
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
    let rest = url
        .strip_prefix("/api/admin/connectors")
        .map(|r| format!("/admin{r}"))
        .or_else(|| url.strip_prefix("/api/connectors").map(String::from))
        .unwrap();
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() >= 3 && parts[1] == "accounts" {
        let tail: String = parts[3..].iter().map(|p| format!("/{p}")).collect();
        (format!("/accounts/:id{tail}"), Some(parts[2].to_string()))
    } else {
        (rest, None)
    }
}
