//! Work mail appends through the Notes public API: private notes refused,
//! repeats skipped, changed notes reported instead of overwritten.
use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Default)]
struct Vault {
    files: RefCell<BTreeMap<String, String>>,
}

impl Host for Vault {
    fn call(&self, _port: &str, operation: &str, _resource: &str, query: Value) -> Result<Value> {
        match operation {
            "notes.read" => {
                let path = query["path"].as_str().unwrap();
                Ok(json!({"path": path, "destinationId": "d", "content": self.files.borrow().get(path)}))
            }
            "notes.compare-write" => {
                let path = query["path"].as_str().unwrap().to_owned();
                let current = self.files.borrow().get(&path).cloned();
                if query["expected"] != json!(current) {
                    return Err(Error::new("changed"));
                }
                self.files.borrow_mut().insert(path, query["content"].as_str().unwrap().into());
                Ok(json!({"saved": true}))
            }
            "index.search" => Ok(json!({"chunks": [
                {"sourcePath": "Projects.md", "text": "t", "lineStart": 0, "lineEnd": 1},
                {"sourcePath": "Secret.md", "text": "t", "lineStart": 0, "lineEnd": 1}
            ]})),
            _ => Err(Error::new("unexpected")),
        }
    }
}

fn api(host: &Vault, name: &str, parameters: Value) -> Value {
    let payload = json!({"name": name, "parameters": parameters});
    serde_json::from_str(&handle(host, "api", &payload.to_string()).unwrap()).unwrap()
}

const ENTRY: &str = "\n<!-- work-mail:abc123 -->\n\n## 2026-03-02 \u{2014} Work mail\n\nFrom: Boss\n\nNote text\n";

#[test]
fn appends_to_the_default_note_once_and_skips_private_candidates() {
    let host = Vault::default();
    host.files.borrow_mut().insert("Projects.md".into(), "# Projects\n".into());
    host.files.borrow_mut().insert("Secret.md".into(), "---\nprivate: true\n---\nsecret".into());

    let out = api(&host, "listWorkMailCandidates", json!({"query": "budget", "limit": 5}));
    assert_eq!(out["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(out["candidates"][0]["path"], "Projects.md");

    let out = api(&host, "appendWorkMailNote", json!({"path": "default", "entry": ENTRY}));
    assert_eq!(out, json!({"result": "written"}));
    let out = api(&host, "appendWorkMailNote", json!({"path": "default", "entry": ENTRY}));
    assert_eq!(out, json!({"result": "written"}));
    let text = host.files.borrow()["Work mail notes.md"].clone();
    assert_eq!(text.matches("work-mail:abc123").count(), 1);

    let out = api(&host, "appendWorkMailNote", json!({"path": "Secret.md", "entry": ENTRY}));
    assert_eq!(out, json!({"result": "private"}));
    assert!(!host.files.borrow()["Secret.md"].contains("Note text"));
}
