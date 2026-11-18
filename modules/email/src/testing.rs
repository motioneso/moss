//! An in-memory host for tests and the parity oracle. It follows the same `email.*`
//! contract as the real host but keeps rows in memory.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Map, Value};
use std::cell::RefCell;

pub const TIME: &str = "2026-01-01T00:00:00.000Z";

pub fn message(id: &str, subject: &str) -> Value {
    json!({
        "id":id,"ownerUserId":"user-1","sender":"sender@example.test",
        "recipients":["me@example.test"],"subject":subject,"snippet":null,
        "bodyExcerpt":null,"summary":null,"signals":{},"receivedAt":TIME,
        "externalId":format!("ext-{id}"),"createdAt":TIME,"updatedAt":TIME
    })
}

pub struct Fake {
    pub failing: bool,
    state: RefCell<State>,
    /// Every `set` call the guest made, so tests can search what it sent.
    pub writes: RefCell<Vec<Value>>,
}
#[derive(Default)]
struct State {
    messages: Vec<Value>,
    preferences: Map<String, Value>,
    source: Option<bool>,
    tier: Option<String>,
    next: u32,
}
impl Default for Fake {
    fn default() -> Self {
        Self {
            failing: false,
            state: RefCell::default(),
            writes: RefCell::default(),
        }
    }
}
impl Fake {
    pub fn with_message(self, id: &str, subject: &str) -> Self {
        self.state.borrow_mut().messages.push(message(id, subject));
        self
    }
    pub fn with_preference(self, key: &str, value: Value) -> Self {
        self.state.borrow_mut().preferences.insert(key.into(), value);
        self
    }
    pub fn messages(&self) -> Vec<Value> {
        self.state.borrow().messages.clone()
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        if self.failing {
            return Err(Error::new("host failure"));
        }
        assert_eq!(port, "kv");
        if operation == "set" {
            self.writes.borrow_mut().push(json!({"resource":resource,"parameters":p}));
        }
        let mut state = self.state.borrow_mut();
        Ok(match (operation, resource) {
            ("get", "email.messages") => match p["id"].as_str() {
                Some(id) => json!(state.messages.iter().filter(|m| m["id"] == id).collect::<Vec<_>>()),
                None => {
                    let offset = p["offset"].as_u64().unwrap_or(0) as usize;
                    let limit = p["limit"].as_u64().map_or(usize::MAX, |l| l as usize);
                    json!(state.messages.iter().skip(offset).take(limit).collect::<Vec<_>>())
                }
            },
            ("get", "email.preferences") => {
                let mut out = Map::new();
                for key in p["keys"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    if let Some(value) = state.preferences.get(key) {
                        out.insert(key.into(), value.clone());
                    }
                }
                Value::Object(out)
            }
            ("set", "email.preferences") => {
                for (key, value) in p["values"].as_object().into_iter().flatten() {
                    state.preferences.insert(key.clone(), value.clone());
                }
                Value::Object(state.preferences.clone())
            }
            ("get", "email.source-behaviors") => match state.source {
                Some(enabled) => json!({"enabled":enabled}),
                None => json!({}),
            },
            ("set", "email.source-behaviors") => {
                state.source = p["enabled"].as_bool();
                json!({"saved":true})
            }
            ("get", "email.draft-policy") => match &state.tier {
                Some(tier) => json!({"tier":tier}),
                None => json!({}),
            },
            ("set", "email.draft-policy") => {
                state.tier = p["tier"].as_str().map(String::from);
                json!({"saved":true})
            }
            ("set", "email.cache-write") => {
                let fields = p["fields"].clone();
                if p["action"] == "insert" {
                    if p["connectorAccountId"] == "no-such-account" {
                        return Ok(json!({"rejected":true}));
                    }
                    state.next += 1;
                    let id = format!("cached-{}", state.next);
                    let mut row = message(&id, "");
                    row["externalId"] = p["externalId"].clone();
                    for (key, value) in fields.as_object().into_iter().flatten() {
                        row[key] = value.clone();
                    }
                    state.messages.push(row.clone());
                    return Ok(row);
                }
                let Some(row) = state.messages.iter_mut().find(|m| m["id"] == p["id"]) else {
                    return Ok(Value::Null);
                };
                for (key, value) in fields.as_object().into_iter().flatten() {
                    row[key] = value.clone();
                }
                row.clone()
            }
            _ => return Err(Error::new("unknown resource")),
        })
    }
}
