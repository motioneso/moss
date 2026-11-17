//! A scripted host for the Scratchpad guest tests. It keeps one note and records every call.
#![allow(dead_code)]
use moss_module_sdk::{Host, Result, RouteRequest};
use serde_json::{json, Value};
use std::cell::RefCell;

pub const STAMP: &str = "2026-11-12T12:00:00.000Z";

pub struct Fake {
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
    pub body: RefCell<String>,
    pub revision: RefCell<u64>,
    pub notes_folder: bool,
}

impl Default for Fake {
    fn default() -> Self {
        Fake { calls: RefCell::default(), body: RefCell::default(), revision: RefCell::new(0), notes_folder: true }
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), p.clone()));
        let revision = *self.revision.borrow();
        Ok(match operation {
            "get" => json!({"body": *self.body.borrow(), "revision": revision, "updatedAt": null,
                "syncToNotes": false, "notesFolderConfigured": self.notes_folder, "shortcut": "mod+shift+s"}),
            "put" if p["revision"] == json!(revision) => {
                *self.body.borrow_mut() = p["body"].as_str().unwrap().to_owned();
                *self.revision.borrow_mut() = revision + 1;
                json!({"ok": true, "revision": revision + 1, "updatedAt": STAMP})
            }
            "put" => json!({"ok": false, "current": {"body": *self.body.borrow(), "revision": revision, "updatedAt": null}}),
            "append" => {
                let text = p["text"].as_str().unwrap();
                let empty = self.body.borrow().is_empty();
                self.body.borrow_mut().push_str(&if empty { text.to_owned() } else { format!("\n{text}") });
                *self.revision.borrow_mut() = revision + 1;
                json!({"revision": revision + 1, "updatedAt": STAMP, "appended": if empty { text.to_owned() } else { format!("\n{text}") }})
            }
            "settings" if p["syncToNotes"] == json!(true) && !self.notes_folder => json!({"notesFolderMissing": true}),
            "settings" => json!({"syncToNotes": p["syncToNotes"].as_bool().unwrap_or(false), "shortcut": p["shortcut"].as_str().unwrap_or("mod+shift+s")}),
            _ => json!({}),
        })
    }
}

impl Fake {
    pub fn ops(&self) -> Vec<String> {
        self.calls.borrow().iter().map(|c| format!("{}.{}", c.0, c.1)).collect()
    }
}

pub fn request(method: &str, path: &str, body: Value) -> RouteRequest {
    serde_json::from_value(json!({"method": method, "path": path, "params": {}, "query": {}, "body": body})).unwrap()
}
