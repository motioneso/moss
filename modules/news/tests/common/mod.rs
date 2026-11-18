#![allow(dead_code)]
//! An in-memory host that mimics the row rules the guest relies on. Every table is owner-only,
//! the unique rules of the real tables apply, and deletes return the rows removed. The
//! real-database tests in the host crate prove the same rules in Postgres.
use moss_module_sdk::{
    query::{Compare, Conflict, Filter, Kind, Query},
    Error, Host, Result, RouteRequest,
};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

pub const A: &str = "00000000-0000-4000-8000-00000000000a";
pub const B: &str = "00000000-0000-4000-8000-00000000000b";

pub struct Fake {
    pub actor: Cell<&'static str>,
    pub tables: RefCell<BTreeMap<String, Vec<Value>>>,
    /// Every host call as (port, operation, resource, parameters).
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
    pub db_failure: RefCell<Option<String>>,
    /// Answers for the public-web read, by exact address. An address not listed fails as `network`.
    pub pages: RefCell<BTreeMap<String, Value>>,
    /// Replies the model gives, first in first out. An empty queue makes the model call fail.
    pub model: RefCell<Vec<Result<String>>>,
    /// The person's key-value files, by (person, name).
    pub files: RefCell<BTreeMap<(String, String), Value>>,
    /// The host clock in milliseconds since the epoch.
    pub clock: Cell<i64>,
    /// Open jobs as (person, queue, key, parameters). Running one removes it.
    pub jobs: RefCell<Vec<(String, String, String, Value)>>,
    /// Jobs being executed right now as (person, queue). They still count as open, like the real queue.
    pub running: RefCell<Vec<(String, String)>>,
    /// Daily schedules as (person, queue, key) with the cron and zone.
    pub schedules: RefCell<BTreeMap<(String, String, String), Value>>,
    /// Notifications posted, as (person, parameters).
    pub notices: RefCell<Vec<(String, Value)>>,
    /// Runs once, just before the next model reply. Lets a test change things mid-run.
    pub before_model: RefCell<Option<Box<dyn Fn(&Fake)>>>,
    ids: Cell<u32>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            tables: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(vec![]),
            db_failure: RefCell::new(None),
            pages: RefCell::new(BTreeMap::new()),
            model: RefCell::new(vec![]),
            files: RefCell::new(BTreeMap::new()),
            clock: Cell::new(1_794_000_000_000),
            jobs: RefCell::new(vec![]),
            running: RefCell::new(vec![]),
            schedules: RefCell::new(BTreeMap::new()),
            notices: RefCell::new(vec![]),
            before_model: RefCell::new(None),
            ids: Cell::new(0),
        }
    }
    pub fn as_actor(&self, actor: &'static str) {
        self.actor.set(actor);
    }
    pub fn route(&self, method: &str, path: &str, params: &[(&str, &str)], body: Value) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: params.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            query: Default::default(),
            body,
        };
        let response = moss_news_module::route(self, request);
        (response.status, response.body)
    }
    fn next_id(&self) -> String {
        let n = self.ids.get();
        self.ids.set(n + 1);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    /// Puts a row in a table for a person, filling the id and a rising creation time.
    pub fn seed(&self, table: &str, owner: &str, mut row: Value) -> String {
        let id = self.next_id();
        row["id"] = json!(id);
        row["owner_user_id"] = json!(owner);
        let n = self.ids.get();
        row["created_at"] = json!(format!("2026-11-11T10:{:02}:{:02}.000+00:00", n / 60, n % 60));
        self.tables.borrow_mut().entry(table.into()).or_default().push(row);
        id
    }
    pub fn page(&self, url: &str, status: u16, content_type: &str, body: &str) {
        self.pages.borrow_mut().insert(
            url.into(),
            json!({"ok":true,"status":status,"finalUrl":url,"contentType":content_type,"body":body,"truncated":false,"hopCount":0,"encoding":"utf-8"}),
        );
    }
    /// A page that answers from another address after a redirect.
    pub fn moved(&self, from: &str, to: &str, content_type: &str, body: &str) {
        self.pages.borrow_mut().insert(
            from.into(),
            json!({"ok":true,"status":200,"finalUrl":to,"contentType":content_type,"body":body,"truncated":false,"hopCount":1,"encoding":"utf-8"}),
        );
    }
    pub fn fails(&self, url: &str, reason: &str) {
        self.pages.borrow_mut().insert(url.into(), json!({"ok":false,"reason":reason}));
    }
    pub fn model_says(&self, text: &str) {
        self.model.borrow_mut().push(Ok(text.into()));
    }
    pub fn model_calls(&self) -> usize {
        self.calls.borrow().iter().filter(|(p, _, _, _)| p == "ai").count()
    }
    pub fn fetched(&self) -> Vec<String> {
        self.calls
            .borrow()
            .iter()
            .filter(|(p, _, _, _)| p == "fetch")
            .map(|(_, _, _, v)| v["url"].as_str().unwrap_or("").to_owned())
            .collect()
    }
    /// Delivers the person's open job on a queue the way the host does, and returns the answer.
    pub fn run_job(&self, queue: &str) -> Option<String> {
        let actor = self.actor.get();
        let at = self.jobs.borrow().iter().position(|(who, q, _, _)| who == actor && q == queue)?;
        let (_, q, _, params) = self.jobs.borrow_mut().remove(at);
        let payload = json!({"queue": q, "parameters": params}).to_string();
        self.running.borrow_mut().push((actor.to_owned(), q.clone()));
        let answer = moss_news_module::handle(self, "job", &payload).expect("the job ran");
        self.running.borrow_mut().retain(|(who, name)| !(who == actor && *name == q));
        Some(answer)
    }
    /// Delivers a refresh job that the queue handed over before the request's own writes existed.
    pub fn run_job_unqueued(&self, queue: &str) -> String {
        let payload = json!({"queue": queue, "parameters": {"kind": "user_refresh"}}).to_string();
        moss_news_module::handle(self, "job", &payload).expect("the job ran")
    }
    pub fn open_jobs(&self, queue: &str) -> usize {
        let actor = self.actor.get();
        self.jobs.borrow().iter().filter(|(who, q, _, _)| who == actor && q == queue).count()
    }
    /// Runs the refresh queue until it is empty.
    pub fn refresh(&self) {
        while self.run_job("news-refresh").is_some() {}
    }
    pub fn rows(&self, table: &str) -> Vec<Value> {
        self.tables.borrow().get(table).cloned().unwrap_or_default()
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
            Compare::Gt => row[column.as_str()].as_str().unwrap_or("") > value.as_str().unwrap_or(""),
            _ => panic!("fake host does not model this comparison"),
        },
    }
}

/// The unique rules of the real tables.
fn clash(table: &str, a: &Value, b: &Value) -> bool {
    let same = |k: &str| a[k] == b[k];
    if !same("owner_user_id") {
        return false;
    }
    match table {
        "app.news_prefs" => same("kind") && same("key"),
        "app.news_source_exclusions" | "app.news_custom_sources" => same("canonical_domain"),
        "app.news_policy_verdicts" => same("canonical_domain"),
        "app.news_story_feedback" => same("story_ref"),
        "app.news_custom_topics" => {
            a["label"].as_str().map(str::to_lowercase) == b["label"].as_str().map(str::to_lowercase)
        }
        _ => true,
    }
}

impl Host for Fake {
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
            ("kv", "get") => {
                return Ok(self.files.borrow().get(&(actor.to_owned(), resource.to_owned())).cloned().unwrap_or(Value::Null))
            }
            ("kv", "set") => {
                self.files.borrow_mut().insert((actor.to_owned(), resource.to_owned()), parameters);
                return Ok(json!({}));
            }
            ("fetch", "get") => {
                let url = parameters["url"].as_str().unwrap_or("");
                return Ok(self.pages.borrow().get(url).cloned().unwrap_or_else(|| json!({"ok":false,"reason":"network"})));
            }
            ("ai", "generate") => {
                let hook = self.before_model.borrow_mut().take();
                if let Some(hook) = hook {
                    hook(self);
                }
                let mut queue = self.model.borrow_mut();
                if queue.is_empty() {
                    return Err(Error::new("No model"));
                }
                return queue.remove(0).map(|text| json!({"text": text}));
            }
            ("jobs", "list-open") => {
                let open: Vec<Value> = self
                    .jobs
                    .borrow()
                    .iter()
                    .filter(|(who, q, _, _)| who == actor && q == resource)
                    .map(|(_, _, key, params)| json!({"id": key, "state": "pending", "params": params}))
                    .chain(
                        self.running
                            .borrow()
                            .iter()
                            .filter(|(who, q)| who == actor && q == resource)
                            .map(|_| json!({"id": "running", "state": "running", "params": {}})),
                    )
                    .collect();
                return Ok(json!({"jobs": open}));
            }
            ("jobs", "enqueue-options") => {
                let key = parameters["idempotencyKey"].as_str().unwrap_or("").to_owned();
                let mut jobs = self.jobs.borrow_mut();
                if jobs.iter().any(|(who, q, k, _)| who == actor && q == resource && *k == key) {
                    return Ok(json!({}));
                }
                jobs.push((actor.into(), resource.into(), key.clone(), parameters["params"].clone()));
                return Ok(json!({"id": key}));
            }
            ("jobs", "schedule") => {
                let key = parameters["key"].as_str().unwrap_or("").to_owned();
                let id = format!("{actor}/{resource}/{key}");
                let mut all = self.schedules.borrow_mut();
                let at = (actor.to_owned(), resource.to_owned(), key);
                if !(parameters["keepExisting"] == json!(true) && all.contains_key(&at)) {
                    all.insert(at, json!({"cron": parameters["cron"], "timezone": parameters["timezone"], "params": parameters["params"]}));
                }
                return Ok(json!({"id": id}));
            }
            ("jobs", "unschedule") => {
                let id = parameters["id"].as_str().unwrap_or("");
                self.schedules.borrow_mut().retain(|(who, q, k), _| format!("{who}/{q}/{k}") != id);
                return Ok(json!({"cancelled": true}));
            }
            ("notify", "post") => {
                self.notices.borrow_mut().push((actor.into(), parameters));
                return Ok(json!({}));
            }
            _ => return Err(Error::new("Unexpected host call")),
        }
        if let Some(message) = self.db_failure.borrow().clone() {
            return Err(Error::new(message));
        }
        let query: Query = serde_json::from_value(parameters)?;
        let mut tables = self.tables.borrow_mut();
        let rows = tables.entry(resource.to_owned()).or_default();
        match query.kind {
            Kind::Select => {
                let mut found: Vec<Value> = rows
                    .iter()
                    .filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter))
                    .cloned()
                    .collect();
                for order in query.order.iter().rev() {
                    found.sort_by(|a, b| {
                        let (x, y) = (
                            a[order.column.as_str()].as_str().unwrap_or(""),
                            b[order.column.as_str()].as_str().unwrap_or(""),
                        );
                        if order.descending { y.cmp(x) } else { x.cmp(y) }
                    });
                }
                Ok(json!(found.into_iter().take(query.limit.unwrap_or(1000) as usize).collect::<Vec<_>>()))
            }
            Kind::Insert => {
                drop(tables);
                let id = self.next_id();
                let n = self.ids.get();
                let mut row = json!({"id": id, "owner_user_id": actor,
                    "created_at": format!("2026-11-11T10:{:02}:{:02}.000+00:00", n / 60, n % 60)});
                for (k, v) in &query.values {
                    row[k.as_str()] = v.clone();
                }
                let mut tables = self.tables.borrow_mut();
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
                let mut changed = vec![];
                for row in rows.iter_mut().filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter)) {
                    for (k, v) in &query.values {
                        row[k.as_str()] = v.clone();
                    }
                    changed.push(row.clone());
                }
                Ok(json!(changed))
            }
            Kind::Delete => {
                let (gone, kept): (Vec<Value>, Vec<Value>) =
                    rows.drain(..).partition(|r| r["owner_user_id"] == actor && matches(r, &query.filter));
                *rows = kept;
                Ok(json!(gone))
            }
        }
    }
}
