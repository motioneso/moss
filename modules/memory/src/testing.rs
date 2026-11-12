//! An in-memory host for the guest tests. It answers each memory resource from a canned value.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

/// A host that answers each memory resource from a canned value and records every call.
pub struct Fake {
    pub recall: Value,
    pub core: Value,
    pub index_fails: bool,
    pub lifecycle: Value,
    pub target: Value,
    pub forget: Value,
    /// Answer for the screen resources (lists, decisions, patches, subject lookup).
    pub screen: Value,
    pub calls: RefCell<Vec<(String, String, Value)>>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            recall: json!({"nowMs": 0.0, "candidates": [], "names": {}}),
            core: json!({"facts": [], "names": {}}),
            index_fails: false,
            lifecycle: json!({"ok": true}),
            target: json!({"target": null}),
            forget: json!({"deleted": true}),
            screen: json!({}),
            calls: RefCell::default(),
        }
    }
    pub fn count(&self, resource: &str) -> usize {
        self.calls.borrow().iter().filter(|c| c.1 == resource).count()
    }
    pub fn sent(&self, resource: &str) -> Value {
        self.calls
            .borrow()
            .iter()
            .find(|c| c.1 == resource)
            .map(|c| c.2.clone())
            .unwrap_or(Value::Null)
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        assert_eq!(port, "kv");
        self.calls.borrow_mut().push((operation.into(), resource.into(), p.clone()));
        match resource {
            "memory.recall" => Ok(self.recall.clone()),
            "memory.core" => Ok(self.core.clone()),
            "memory.entity" => Ok(json!({"entity": {"id": "e1", "kind": p["kind"], "name": p["name"]}})),
            "memory.fact" => Ok(json!({"fact": {
                "id": "f1", "confidence": p["confidence"], "provenance": p["provenance"],
                "lastConfirmedAt": null, "recordKind": p["recordKind"]
            }})),
            "memory.lifecycle" => Ok(self.lifecycle.clone()),
            "memory.target" => Ok(self.target.clone()),
            "memory.forget" => Ok(self.forget.clone()),
            "memory.facts" | "memory.candidates" | "memory.candidate" | "memory.fact-patch"
            | "memory.entity-patch" | "memory.entity-delete" | "memory.subject" => Ok(self.screen.clone()),
            "memory.index" if self.index_fails => Err(Error::new("embedding failed")),
            "memory.index" => Ok(json!({"indexed": true})),
            _ => Err(Error::new("unknown resource")),
        }
    }
}
