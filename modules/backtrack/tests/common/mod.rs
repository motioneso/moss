//! A scripted host for the Backtrack guest tests. It records every call it receives.
#![allow(dead_code)]
use moss_module_sdk::{Host, Result, RouteRequest};
use serde_json::{json, Value};
use std::cell::RefCell;

pub const NOW: &str = "2026-11-12T12:00:00.000000Z";
pub const DEVICE: &str = "22222222-2222-4222-8222-222222222222";

pub struct Fake {
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
    pub link: Value,
    pub storage: bool,
    pub paused: bool,
    pub overlaps: Vec<usize>,
    pub inserted: Option<u64>,
    pub segment_ids: Vec<String>,
    pub expired: Vec<String>,
    pub pending: Vec<Value>,
    pub stale: bool,
    pub memory_fails: bool,
}

impl Default for Fake {
    fn default() -> Self {
        Fake { calls: RefCell::default(), link: json!({"link":"device","deviceId":DEVICE}), storage: true, paused: false, overlaps: vec![], inserted: None, segment_ids: vec![], expired: vec![], pending: vec![], stale: false, memory_fails: false }
    }
}

impl Fake {
    pub fn ops(&self) -> Vec<String> {
        self.calls.borrow().iter().map(|c| format!("{}.{}", c.0, c.1)).collect()
    }
    pub fn params(&self, op: &str) -> Option<Value> {
        self.calls.borrow().iter().find(|c| format!("{}.{}", c.0, c.1) == op).map(|c| c.3.clone())
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        Ok(match (port, operation) {
            ("context", "read") => json!({"now": NOW}),
            ("kv", "link") => self.link.clone(),
            ("kv", "storage") => json!({"on": self.storage}),
            ("kv", "paused") => json!({"paused": self.paused}),
            ("kv", "set-paused") => json!({"paused": parameters["paused"]}),
            ("kv", "overlaps") => json!({"indexes": self.overlaps}),
            ("kv", "insert") => {
                let n = parameters["segments"].as_array().map_or(0, |a| a.len() as u64);
                json!({"inserted": self.inserted.unwrap_or(n)})
            }
            ("kv", "delete") => json!({"deleted": 3}),
            ("kv", "segment-ids") => json!({"ids": self.segment_ids}),
            ("kv", "expired") => json!({"ids": self.expired}),
            ("kv", "pending") => json!({"segments": self.pending}),
            ("kv", "stale") => json!({"stale": self.stale}),
            ("kv", "index-key") => json!({"key": "33333333-3333-4333-8333-333333333333"}),
            ("kv", "mark-indexed") => json!({"marked": parameters["ids"].as_array().map_or(0, |a| a.len())}),
            ("api", "call") if self.memory_fails => json!({"error": {"statusCode": 500, "error": "embedder down"}}),
            ("api", "call") => json!({"ok": {}}),
            ("kv", "upkeep") => json!({"segments": 2, "markers": 1}),
            ("kv", "status") => json!({"paused": self.paused, "devices": 1, "segments": 4}),
            ("kv", "export") => json!([{"id": "x"}]),
            _ => json!({}),
        })
    }
}

pub fn request(method: &str, path: &str, body: Value) -> RouteRequest {
    RouteRequest { method: method.into(), path: path.into(), params: Default::default(), query: Default::default(), body }
}

pub fn segment(started: &str, ended: &str, body: &str) -> Value {
    json!({"startedAt": started, "endedAt": ended, "appName": "Safari", "bundleId": "com.apple.Safari",
        "windowTitle": "Title", "address": "https://example.test/a", "body": body})
}
