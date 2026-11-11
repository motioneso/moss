//! An in-memory host for tests and the parity oracle. It follows the same
//! `connectors.*` contract as the real host but keeps rows in memory.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap};

pub const TIME: &str = "2026-01-01T00:00:00.000Z";

pub fn providers() -> Vec<Value> {
    [
        ("google", "google", "Google", json!(["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/calendar"])),
        ("imap-fastmail", "imap", "Fastmail", json!(["email.read"])),
        ("outlook-browser-calendar", "calendar", "Outlook calendar (browser)", json!(["calendar.readonly"])),
    ]
    .into_iter()
    .map(|(id, kind, name, scopes)| {
        json!({"id":id,"providerType":kind,"displayName":name,"status":"available","defaultScopes":scopes,"createdAt":TIME,"updatedAt":TIME})
    })
    .collect()
}

pub struct Fake {
    pub admin: &'static str,
    pub failing: bool,
    state: RefCell<State>,
    /// Every `set` call the guest made, so tests can search what it sent.
    pub writes: RefCell<Vec<Value>>,
}
#[derive(Default)]
struct State {
    accounts: Vec<Value>,
    grants: BTreeMap<String, Value>,
    next: u32,
}
impl Default for Fake {
    fn default() -> Self {
        Self {
            admin: "ok",
            failing: false,
            state: RefCell::default(),
            writes: RefCell::default(),
        }
    }
}
impl Fake {
    pub fn with_account(self, id: &str, provider: &str, scopes: &[&str]) -> Self {
        let kind = providers()
            .into_iter()
            .find(|p| p["id"] == provider)
            .map(|p| p["providerType"].clone())
            .unwrap_or(json!("email"));
        self.state.borrow_mut().accounts.push(account(id, provider, kind, scopes, "active"));
        self
    }
}

fn account(id: &str, provider: &str, kind: Value, scopes: &[impl AsRef<str>], status: &str) -> Value {
    let scopes: Vec<&str> = scopes.iter().map(AsRef::as_ref).collect();
    json!({
        "id":id,"providerId":provider,"providerType":kind,
        "providerDisplayName":provider,"providerStatus":"available",
        "ownerUserId":"user-1","scopes":scopes,"status":status,"hasSecret":true,
        "revokedAt":null,"createdAt":TIME,"updatedAt":TIME,
        "lastSyncStartedAt":null,"lastSyncFinishedAt":null,"lastSyncStatus":null,
        "lastSyncError":null,"lastSyncCounts":null
    })
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
            ("get", "connectors.providers") => json!(providers()),
            ("get", "connectors.accounts") => match p["id"].as_str() {
                Some(id) => json!(state.accounts.iter().filter(|a| a["id"] == id).collect::<Vec<_>>()),
                None => json!(state.accounts),
            },
            ("set", "connectors.account-write") => {
                let action = p["action"].as_str().unwrap_or("");
                if action == "create" {
                    let provider = p["providerId"].as_str().unwrap_or("");
                    let Some(found) = providers().into_iter().find(|d| d["id"] == provider) else {
                        return Ok(json!({"rejected":true}));
                    };
                    state.next += 1;
                    let id = format!("acct-{}", state.next);
                    let scopes: Vec<String> = serde_json::from_value(p["scopes"].clone()).unwrap_or_default();
                    let row = account(&id, provider, found["providerType"].clone(), &scopes, p["status"].as_str().unwrap_or("active"));
                    state.accounts.insert(0, row.clone());
                    return Ok(row);
                }
                let Some(row) = state.accounts.iter_mut().find(|a| a["id"] == p["id"]) else {
                    return Ok(Value::Null);
                };
                if action == "revoke" {
                    row["status"] = json!("revoked");
                    row["revokedAt"] = json!(TIME);
                } else {
                    if !p["scopes"].is_null() {
                        row["scopes"] = p["scopes"].clone();
                    }
                    if !p["status"].is_null() {
                        row["status"] = p["status"].clone();
                        row["revokedAt"] = Value::Null;
                    }
                }
                row.clone()
            }
            ("get", "connectors.feature-grants") => {
                state.grants.get(p["accountId"].as_str().unwrap_or("")).cloned().unwrap_or(Value::Null)
            }
            ("set", "connectors.feature-grants") => {
                let id = p["accountId"].as_str().unwrap_or("").to_string();
                if !state.accounts.iter().any(|a| a["id"] == id.as_str()) {
                    return Ok(Value::Null);
                }
                state.grants.insert(id, p["value"].clone());
                json!({"saved":true})
            }
            ("get", "connectors.admin-accounts") => {
                json!({"status":self.admin,"accounts":state.accounts})
            }
            ("set", "connectors.google-authorize") => {
                json!({"authUrl":format!("https://accounts.example.test/auth?client_id={}", p["clientId"].as_str().unwrap_or(""))})
            }
            ("set", "connectors.google-complete") => {
                let url = p["redirectUrl"].as_str().unwrap_or("");
                if url.contains("refuse") {
                    return Ok(json!({"refused":{"status":429,"body":{"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"}}}));
                }
                if url.contains("mismatch") {
                    return Ok(json!({"failure":"Authorization state did not match \u{2014} please retry the connect flow"}));
                }
                state.next += 1;
                let id = format!("acct-{}", state.next);
                let row = account(&id, "google", json!("google"), &["https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/calendar"], "active");
                state.accounts.insert(0, row.clone());
                json!({"account":row})
            }
            _ => return Err(Error::new("unknown resource")),
        })
    }
}
