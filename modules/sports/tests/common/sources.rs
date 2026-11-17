#![allow(dead_code)]
//! An in-memory host for the added-source routes. Every table is owner-only, deleting a source
//! removes its targets, the two unique rules of the sources table apply, and the saved settings
//! and fetch answers are kept per person and per address. The real-database tests in the host
//! crate prove the same rules in Postgres.
use moss_module_sdk::{
    query::{Compare, Conflict, Filter, Kind, Query},
    Error, Host, Result, RouteRequest,
};
use moss_sports_module::{sources::row_identity_key, teams::TeamList};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

pub const A: &str = "00000000-0000-4000-8000-00000000000a";
pub const B: &str = "00000000-0000-4000-8000-00000000000b";
pub const SOURCES: &str = "app.sports_custom_sources";
pub const ASSIGNMENTS: &str = "app.sports_source_assignments";
pub const COVERAGE: &str = "app.sports_espn_source_assignments";
pub const PREFS: &str = "app.sports_headline_prefs";
pub const FOLLOWS: &str = "app.sports_follows";

pub struct Src {
    pub actor: Cell<&'static str>,
    pub tables: RefCell<BTreeMap<String, Vec<Value>>>,
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
    pub pages: RefCell<BTreeMap<String, Value>>,
    pub files: RefCell<BTreeMap<(String, String), Value>>,
    /// What the browser port answers for a page address. An address with no entry is refused.
    pub renders: RefCell<BTreeMap<String, Value>>,
    /// Set to make the whole browser port missing, as on a host that does not grant it.
    pub no_browser: Cell<bool>,
    pub clock: Cell<i64>,
    /// Canned model replies, used oldest first. With none left the model is "not set up".
    pub replies: RefCell<Vec<String>>,
    /// The host's private photo folder, per person: name to {bodyBase64} or {text}.
    pub vault: RefCell<BTreeMap<(String, String), Value>>,
    /// How many milliseconds every fetch takes.
    pub fetch_cost: Cell<i64>,
    /// Makes every photo save fail.
    pub put_fails: Cell<bool>,
    ids: Cell<u32>,
}

impl Src {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            tables: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(vec![]),
            pages: RefCell::new(BTreeMap::new()),
            files: RefCell::new(BTreeMap::new()),
            renders: RefCell::new(BTreeMap::new()),
            no_browser: Cell::new(false),
            clock: Cell::new(1_794_000_000_000),
            replies: RefCell::new(vec![]),
            vault: RefCell::new(BTreeMap::new()),
            fetch_cost: Cell::new(0),
            put_fails: Cell::new(false),
            ids: Cell::new(1),
        }
    }
    /// The host's photo folder. A picture body of "TINY" is too small and "BAD" will not decode.
    fn vault_call(&self, actor: &str, operation: &str, p: &Value) -> Result<Value> {
        let key = |name: &str| (actor.to_owned(), name.to_owned());
        let name = p["name"].as_str().unwrap_or("");
        let mut vault = self.vault.borrow_mut();
        Ok(match operation {
            "reencode" => match p["bodyBase64"].as_str().unwrap_or("") {
                "TINY" => json!({"ok":false,"reason":"too-small"}),
                "BAD" => json!({"ok":false,"reason":"undecodable"}),
                "HUGE" => json!({"ok":false,"reason":"too-large"}),
                body => json!({"ok":true,"contentType":"image/jpeg","bodyBase64":format!("JPEG:{body}"),"width":640,"height":360,"originalWidth":1600,"originalHeight":900,"bytes":2048}),
            },
            "put" => {
                if self.put_fails.get() {
                    return Err(Error::new("Sports host call failed"));
                }
                vault.insert(key(name), p.clone());
                json!({})
            }
            "get" => match vault.get(&key(name)) {
                Some(v) => json!({"found":true,"bodyBase64":v["bodyBase64"],"text":v["text"]}),
                None => json!({"found":false}),
            },
            "list" => json!({"names": vault.keys().filter(|(a, _)| a == actor).map(|(_, n)| n.clone()).collect::<Vec<_>>()}),
            "delete" => {
                vault.remove(&key(name));
                json!({})
            }
            _ => return Err(Error::new("Unexpected host call")),
        })
    }
    pub fn vault_names(&self, person: &str) -> Vec<String> {
        self.vault.borrow().keys().filter(|(a, _)| a == person).map(|(_, n)| n.clone()).collect()
    }
    pub fn as_actor(&self, actor: &'static str) {
        self.actor.set(actor);
    }
    pub fn route(&self, method: &str, path: &str, params: &[(&str, &str)], body: Value) -> (u16, Value) {
        self.route_with(&moss_sports_module::teams::Unavailable, method, path, params, body)
    }
    pub fn route_with(&self, teams: &dyn TeamList, method: &str, path: &str, params: &[(&str, &str)], body: Value) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: params.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            query: Default::default(),
            body,
        };
        let response = moss_sports_module::route_with(self, teams, request);
        (response.status, response.body)
    }
    fn next_id(&self) -> String {
        let n = self.ids.get();
        self.ids.set(n + 1);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    fn stamp(&self) -> String {
        let n = self.ids.get() as i64;
        let at = chrono::DateTime::from_timestamp_millis(self.clock.get() + n * 1000).unwrap();
        at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
    pub fn advance(&self, ms: i64) {
        self.clock.set(self.clock.get() + ms);
    }
    /// A follow the person owns, as the picker saves one.
    pub fn follow(&self, owner: &str, competition: &str, team_key: Option<&str>) -> String {
        let id = self.next_id();
        let row = json!({"id":id,"owner_user_id":owner,"competition_key":competition,"team_key":team_key,
            "source_team_id":null,"created_at":self.stamp()});
        self.tables.borrow_mut().entry(FOLLOWS.into()).or_default().push(row);
        id
    }
    pub fn page(&self, url: &str, content_type: &str, body: &str) {
        self.pages.borrow_mut().insert(
            url.into(),
            json!({"ok":true,"status":200,"finalUrl":url,"contentType":content_type,"body":body,"truncated":false,"hopCount":0,"encoding":"text"}),
        );
    }
    /// A page that answers from another address after a redirect.
    pub fn moved(&self, from: &str, to: &str, content_type: &str, body: &str) {
        self.pages.borrow_mut().insert(
            from.into(),
            json!({"ok":true,"status":200,"finalUrl":to,"contentType":content_type,"body":body,"truncated":false,"hopCount":1,"encoding":"text"}),
        );
    }
    pub fn image(&self, url: &str, base64: &str) {
        self.pages.borrow_mut().insert(
            url.into(),
            json!({"ok":true,"status":200,"finalUrl":url,"contentType":"image/png","body":base64,"truncated":false,"hopCount":0,"encoding":"base64"}),
        );
    }
    pub fn fails(&self, url: &str, reason: &str, status: Option<u16>) {
        let mut page = json!({"ok":false,"reason":reason});
        if let Some(status) = status {
            page["status"] = json!(status);
        }
        self.pages.borrow_mut().insert(url.into(), page);
    }
    /// A page the browser renders, with its visible text and link candidates.
    pub fn render(&self, url: &str, text: &str, links: &[(&str, &str)]) {
        let candidates: Vec<Value> = links.iter().map(|(u, t)| json!({"url": u, "text": t})).collect();
        self.renders.borrow_mut().insert(
            url.into(),
            json!({"ok":true,"requestId":"r","finalUrl":url,"title":"T","text":text,"candidates":candidates,"requests":3}),
        );
    }
    pub fn render_refused(&self, url: &str, reason: &str) {
        self.renders.borrow_mut().insert(url.into(), json!({"ok":false,"reason":reason}));
    }
    /// Every browser call, as the address asked for and the hosts allowed.
    pub fn rendered(&self) -> Vec<(String, Vec<String>)> {
        self.calls
            .borrow()
            .iter()
            .filter(|(p, ..)| p == "browser")
            .map(|(_, _, _, v)| {
                let hosts = v["allowedHosts"].as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_owned()).collect();
                (v["url"].as_str().unwrap().to_owned(), hosts)
            })
            .collect()
    }
    pub fn reply(&self, text: &str) {
        self.replies.borrow_mut().push(text.to_owned());
    }
    /// Every prompt the model was sent.
    pub fn prompts(&self) -> Vec<String> {
        self.calls.borrow().iter().filter(|(p, _, _, _)| p == "ai").map(|(_, _, _, v)| v["prompt"].as_str().unwrap_or("").to_owned()).collect()
    }
    pub fn fetched(&self) -> Vec<String> {
        self.calls
            .borrow()
            .iter()
            .filter(|(p, _, _, _)| p == "fetch")
            .map(|(_, _, _, v)| v["url"].as_str().unwrap_or("").to_owned())
            .collect()
    }
    pub fn rows(&self, table: &str) -> Vec<Value> {
        self.tables.borrow().get(table).cloned().unwrap_or_default()
    }
    pub fn file(&self, person: &str, name: &str) -> Value {
        self.files.borrow().get(&(person.to_owned(), name.to_owned())).cloned().unwrap_or(Value::Null)
    }
}

fn matches(row: &Value, filter: &Filter) -> bool {
    match filter {
        Filter::All | Filter::Owned => true,
        Filter::And { filters } => filters.iter().all(|f| matches(row, f)),
        Filter::Or { filters } => filters.iter().any(|f| matches(row, f)),
        Filter::Null { column, not } => row[column.as_str()].is_null() != *not,
        Filter::In { column, values } => values.contains(&row[column.as_str()]),
        Filter::Compare { column, op, value } => match op {
            Compare::Eq => &row[column.as_str()] == value,
            Compare::Ne => &row[column.as_str()] != value,
            _ => panic!("fake host does not model this comparison"),
        },
    }
}

/// The unique rules of the real tables.
fn clash(table: &str, a: &Value, b: &Value) -> bool {
    if a["owner_user_id"] != b["owner_user_id"] {
        return false;
    }
    match table {
        SOURCES => row_identity_key(a) == row_identity_key(b),
        PREFS => true,
        _ => false,
    }
}

fn defaults(table: &str, row: &mut Value, now: &str) {
    let mut put = |k: &str, v: Value| {
        if row.get(k).is_none() {
            row[k] = v;
        }
    };
    put("created_at", json!(now));
    put("updated_at", json!(now));
    if table == SOURCES {
        put("enabled", json!(true));
        put("photo_rule_state", json!("none"));
    }
}

impl Host for Src {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        let actor = self.actor.get();
        match (port, operation) {
            ("db", "query") => {}
            ("context", "read") => {
                let at = chrono::DateTime::from_timestamp_millis(self.clock.get()).unwrap();
                return Ok(json!({"actorUserId": actor, "now": at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}));
            }
            ("context", "uuid") => return Ok(json!({"id": self.next_id()})),
            ("kv", _) if resource == "source-photo-files" => return self.vault_call(actor, operation, &parameters),
            ("kv", "get") => {
                return Ok(self.files.borrow().get(&(actor.to_owned(), resource.to_owned())).cloned().unwrap_or(Value::Null))
            }
            ("kv", "set") => {
                self.files.borrow_mut().insert((actor.to_owned(), resource.to_owned()), parameters);
                return Ok(json!({}));
            }
            ("fetch", "get") => {
                self.advance(self.fetch_cost.get());
                let url = parameters["url"].as_str().unwrap_or("");
                return Ok(self.pages.borrow().get(url).cloned().unwrap_or_else(|| json!({"ok":false,"reason":"network"})));
            }
            ("browser", "render") => {
                assert_eq!(resource, "public-web");
                if self.no_browser.get() {
                    return Err(Error::new("Sports host call failed"));
                }
                let url = parameters["url"].as_str().unwrap_or("");
                return Ok(self.renders.borrow().get(url).cloned().unwrap_or_else(|| json!({"ok":false,"reason":"render_failed"})));
            }
            ("ai", "generate") => {
                assert_eq!(resource, "structured", "recipes ask for structured output");
                let mut replies = self.replies.borrow_mut();
                if replies.is_empty() {
                    return Err(Error::new("needs_config"));
                }
                return Ok(json!({"text": replies.remove(0)}));
            }
            _ => return Err(Error::new("Unexpected host call")),
        }
        let query: Query = serde_json::from_value(parameters)?;
        let now = self.stamp();
        let id = if query.kind == Kind::Insert { Some(self.next_id()) } else { None };
        let mut tables = self.tables.borrow_mut();
        match query.kind {
            Kind::Select => {
                let rows = tables.entry(resource.to_owned()).or_default();
                let mut found: Vec<Value> =
                    rows.iter().filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter)).cloned().collect();
                for order in query.order.iter().rev() {
                    found.sort_by(|a, b| {
                        let (x, y) = (a[order.column.as_str()].as_str().unwrap_or(""), b[order.column.as_str()].as_str().unwrap_or(""));
                        if order.descending { y.cmp(x) } else { x.cmp(y) }
                    });
                }
                Ok(json!(found.into_iter().take(query.limit.unwrap_or(1000) as usize).collect::<Vec<_>>()))
            }
            Kind::Insert => {
                let mut row = json!({"id": id.unwrap(), "owner_user_id": actor});
                for (k, v) in &query.values {
                    row[k.as_str()] = v.clone();
                }
                defaults(resource, &mut row, &now);
                if resource == ASSIGNMENTS {
                    let source = row["source_id"].clone();
                    let held = tables.entry(SOURCES.to_owned()).or_default().iter().any(|s| s["id"] == source && s["owner_user_id"] == actor);
                    if !held {
                        return Err(Error::new("foreign key"));
                    }
                }
                let rows = tables.entry(resource.to_owned()).or_default();
                if let Some(at) = rows.iter().position(|r| clash(resource, r, &row)) {
                    if let Conflict::Update { values, .. } = &query.conflict {
                        for (k, v) in values {
                            rows[at][k.as_str()] = v.clone();
                        }
                        return Ok(json!([rows[at].clone()]));
                    }
                    assert_eq!(query.conflict, Conflict::Ignore, "a clash needs the ignore or update rule");
                    return Ok(json!([]));
                }
                rows.push(row.clone());
                Ok(json!([row]))
            }
            Kind::Update => {
                assert!(!matches!(query.filter, Filter::All), "an update needs a filter");
                let rows = tables.entry(resource.to_owned()).or_default();
                let mut changed = vec![];
                for row in rows.iter_mut().filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter)) {
                    for (k, v) in &query.values {
                        row[k.as_str()] = v.clone();
                    }
                    row["updated_at"] = json!(now);
                    changed.push(row.clone());
                }
                Ok(json!(changed))
            }
            Kind::Delete => {
                assert!(!matches!(query.filter, Filter::All), "a delete needs a filter");
                let rows = tables.entry(resource.to_owned()).or_default();
                let (gone, kept): (Vec<Value>, Vec<Value>) =
                    rows.drain(..).partition(|r| r["owner_user_id"] == actor && matches(r, &query.filter));
                *rows = kept;
                if resource == SOURCES {
                    let ids: Vec<Value> = gone.iter().map(|g| g["id"].clone()).collect();
                    tables.entry(ASSIGNMENTS.to_owned()).or_default().retain(|a| !ids.contains(&a["source_id"]));
                }
                Ok(json!(gone))
            }
        }
    }
}
