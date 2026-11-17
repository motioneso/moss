#![allow(dead_code)]
//! An in-memory host. Knobs set the saved key, the built-in search switch, the chat model and
//! the provider reply. Every call is recorded so tests can scan what crossed the boundary.
use moss_module_sdk::{Error, Host, Result, RouteRequest};
use serde_json::{json, Value};
use std::cell::RefCell;

pub struct Fake {
    pub key_saved: RefCell<bool>,
    /// `None` leaves the switch unset.
    pub native: RefCell<Option<bool>>,
    /// `None` means no chat model, else whether it can search the web.
    pub model: RefCell<Option<bool>>,
    /// The provider answer as status and body. `None` makes the call itself fail.
    pub brave: RefCell<Option<(u64, Value)>>,
    /// What the public-web fetch answers per address. An address not listed is refused.
    pub pages: RefCell<Vec<(String, Value)>>,
    /// Makes every fetch call fail outright.
    pub fetch_down: RefCell<bool>,
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            key_saved: RefCell::new(false),
            native: RefCell::new(None),
            model: RefCell::new(None),
            brave: RefCell::new(Some((200, json!({"web": {"results": []}})))),
            pages: Default::default(),
            fetch_down: RefCell::new(false),
            calls: Default::default(),
        }
    }
    pub fn with_key(self) -> Self {
        *self.key_saved.borrow_mut() = true;
        self
    }
    pub fn serve(&self, body: Value) {
        *self.brave.borrow_mut() = Some((200, body));
    }
    /// A readable page answer for `url`.
    pub fn page(&self, url: &str, content_type: &str, body: &str) {
        self.pages.borrow_mut().push((
            url.into(),
            json!({"ok": true, "status": 200, "finalUrl": url, "contentType": content_type,
                   "body": body, "truncated": false, "hopCount": 0, "encoding": "text"}),
        ));
    }
    pub fn refuse(&self, url: &str, reply: Value) {
        self.pages.borrow_mut().push((url.into(), reply));
    }
    /// Every parameter set sent to the public-web fetch.
    pub fn fetches(&self) -> Vec<Value> {
        self.calls
            .borrow()
            .iter()
            .filter(|c| c.0 == "fetch")
            .map(|c| c.3.clone())
            .collect()
    }
    pub fn read_tool(&self, parameters: Value) -> Value {
        let payload = json!({"tool": "web.read", "parameters": parameters}).to_string();
        serde_json::from_str(&moss_web_research_module::handle(self, "tool", &payload).unwrap())
            .unwrap()
    }
    pub fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let request = RouteRequest {
            method: "POST".into(),
            path: path.into(),
            params: Default::default(),
            query: Default::default(),
            body,
        };
        let r = moss_web_research_module::route_from(self, request);
        (r.status, r.body)
    }
    pub fn requests(&self) -> Vec<Value> {
        self.calls
            .borrow()
            .iter()
            .filter(|c| c.0 == "credentials" && c.1 == "request")
            .map(|c| c.3.clone())
            .collect()
    }
    pub fn tool(&self, parameters: Value) -> Value {
        let payload = json!({"tool": "web.search", "parameters": parameters}).to_string();
        serde_json::from_str(&moss_web_research_module::handle(self, "tool", &payload).unwrap())
            .unwrap()
    }
    pub fn api(&self, name: &str, parameters: Value) -> Value {
        let payload = json!({"name": name, "parameters": parameters}).to_string();
        serde_json::from_str(&moss_web_research_module::handle(self, "api", &payload).unwrap())
            .unwrap()
    }
    pub fn route(&self, method: &str, path: &str) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: Default::default(),
            query: Default::default(),
            body: Value::Null,
        };
        let r = moss_web_research_module::route_from(self, request);
        (r.status, r.body)
    }
}

impl Host for Fake {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        self.calls.borrow_mut().push((
            port.into(),
            operation.into(),
            resource.into(),
            parameters.clone(),
        ));
        match (port, operation) {
            ("credentials", "status") => Ok(json!({"configured": *self.key_saved.borrow()})),
            ("credentials", "request") => match self.brave.borrow().clone() {
                Some((status, body)) => Ok(json!({"status": status, "body": body})),
                None => Err(Error::new("upstream down")),
            },
            ("fetch", "get") => {
                if *self.fetch_down.borrow() {
                    return Err(Error::new("fetch down"));
                }
                let wanted = parameters["url"].as_str().unwrap_or("");
                Ok(self
                    .pages
                    .borrow()
                    .iter()
                    .find(|(url, _)| url == wanted)
                    .map(|(_, reply)| reply.clone())
                    .unwrap_or_else(|| json!({"ok": false, "reason": "blocked"})))
            }
            ("context", "read") => Ok(json!({"now": "2026-11-16T10:00:00.000Z"})),
            ("kv", "get") => Ok(match *self.native.borrow() {
                Some(enabled) => json!({"enabled": enabled}),
                None => Value::Null,
            }),
            ("ai", "capabilities") => Ok(match *self.model.borrow() {
                Some(web_search) => json!({"model": {"webSearch": web_search}}),
                None => json!({"model": null}),
            }),
            _ => Err(Error::new("Unexpected host call")),
        }
    }
}

pub fn brave_rows(n: usize) -> Value {
    let rows: Vec<Value> = (1..=n)
        .map(|i| json!({"title": format!("T{i}"), "url": format!("https://Example.COM/p{i}?x=1"), "description": format!("D{i}"), "age": "2 days ago"}))
        .collect();
    json!({"web": {"results": rows}})
}
