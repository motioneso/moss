#![allow(dead_code)]
//! An in-memory host. Preferences and kv namespaces are plain maps, fetches return canned
//! bodies by host, and every call is recorded so tests can scan what crossed the boundary.
use moss_module_sdk::{Error, Host, Result, RouteRequest};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;

pub struct Fake {
    pub now: RefCell<String>,
    pub prefs: RefCell<BTreeMap<String, Value>>,
    pub kv: RefCell<BTreeMap<String, Value>>,
    /// Canned fetch bodies by host. The latest URL asked of each host is kept in `calls`.
    pub web: RefCell<BTreeMap<String, (u64, String)>>,
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
}

impl Fake {
    pub fn new(now: &str) -> Self {
        Self {
            now: RefCell::new(now.into()),
            prefs: Default::default(),
            kv: Default::default(),
            web: Default::default(),
            calls: Default::default(),
        }
    }
    pub fn serve(&self, host: &str, body: Value) {
        self.web.borrow_mut().insert(host.into(), (200, body.to_string()));
    }
    pub fn fetches(&self, host: &str) -> usize {
        self.calls.borrow().iter().filter(|c| c.0 == "fetch" && c.2 == host).count()
    }
    pub fn route(&self, method: &str, path: &str, query: Value, body: Value, client: Option<&str>) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: Default::default(),
            query: serde_json::from_value(query).unwrap(),
            body,
        };
        let r = moss_weather_module::route_from(self, request, client);
        (r.status, r.body)
    }
    pub fn tool(&self, tool: &str, parameters: Value) -> Value {
        let out = moss_weather_module::handle(self, "tool", &json!({"tool": tool, "parameters": parameters}).to_string()).unwrap();
        serde_json::from_str(&out).unwrap()
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        match (port, operation) {
            ("context", "read") => Ok(json!({"actorUserId": "a", "now": *self.now.borrow()})),
            ("kv", "preference.read") => Ok(json!({"value": self.prefs.borrow().get(resource).cloned().unwrap_or(Value::Null)})),
            ("kv", "preference.write") => {
                self.prefs.borrow_mut().insert(resource.into(), parameters["value"].clone());
                Ok(json!({"value": parameters["value"]}))
            }
            ("kv", "get") => Ok(self.kv.borrow().get(resource).cloned().unwrap_or(Value::Null)),
            ("kv", "set") => {
                self.kv.borrow_mut().insert(resource.into(), parameters);
                Ok(json!({}))
            }
            ("fetch", "get") => match self.web.borrow().get(resource) {
                Some((status, body)) => Ok(json!({"status": status, "body": body})),
                None => Err(Error::new("no route")),
            },
            _ => Err(Error::new("Unexpected host call")),
        }
    }
}

pub fn place(label: &str) -> Value {
    json!({"lat": 47.61, "lon": -122.33, "label": label})
}
