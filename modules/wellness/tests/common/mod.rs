#![allow(dead_code)]
//! An in-memory host that mimics the rules the guest relies on. The check-in table is owner-only
//! and fills the defaults the real table fills. The real-database tests in the host crate prove
//! the same rules in Postgres.
use moss_module_sdk::{
    query::{Compare, Filter, Kind, Query},
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
    /// Saved account choices, by (person, name).
    pub preferences: RefCell<BTreeMap<(String, String), Value>>,
    /// The package's saved values, by (person, namespace).
    pub stored: RefCell<BTreeMap<(String, String), Value>>,
    /// Queued jobs as (queue, request).
    pub queued: RefCell<Vec<(String, Value)>>,
    /// What the host clock reads. Tests move it.
    pub clock: RefCell<String>,
    pub queue_failure: Cell<bool>,
    ids: Cell<u32>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            tables: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(vec![]),
            db_failure: RefCell::new(None),
            preferences: RefCell::new(BTreeMap::new()),
            stored: RefCell::new(BTreeMap::new()),
            queued: RefCell::new(vec![]),
            clock: RefCell::new("2026-11-11T18:00:00.000Z".into()),
            queue_failure: Cell::new(false),
            ids: Cell::new(0),
        }
    }
    pub fn as_actor(&self, actor: &'static str) {
        self.actor.set(actor);
    }
    pub fn route(&self, method: &str, path: &str, params: &[(&str, &str)], body: Value) -> (u16, Value) {
        self.route_query(method, path, params, &[], body)
    }
    pub fn route_query(
        &self,
        method: &str,
        path: &str,
        params: &[(&str, &str)],
        query: &[(&str, &str)],
        body: Value,
    ) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: params.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            query: query.iter().map(|(k, v)| ((*k).into(), json!(v))).collect(),
            body,
        };
        let response = moss_wellness_module::route(self, request);
        (response.status, response.body)
    }
    fn next_id(&self) -> String {
        let n = self.ids.get();
        self.ids.set(n + 1);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    pub fn set_clock(&self, now: &str) {
        *self.clock.borrow_mut() = now.into();
    }
    /// Runs the queue worker for every queued export, as the real worker would.
    pub fn run_queued(&self) {
        let jobs: Vec<(String, Value)> = self.queued.borrow_mut().drain(..).collect();
        for (queue, request) in jobs {
            let payload = json!({"queue": queue, "parameters": request["params"]});
            moss_wellness_module::handle(self, "job", &payload.to_string()).expect("job runs");
        }
    }
    pub fn rows(&self, table: &str) -> Vec<Value> {
        self.tables.borrow().get(table).cloned().unwrap_or_default()
    }
}

fn matches(row: &Value, filter: &Filter) -> bool {
    let text = |column: &str| row[column].as_str().unwrap_or("").to_owned();
    match filter {
        Filter::All | Filter::Owned => true,
        Filter::And { filters } => filters.iter().all(|f| matches(row, f)),
        Filter::Or { filters } => filters.iter().any(|f| matches(row, f)),
        Filter::Null { column, not } => row[column.as_str()].is_null() != *not,
        Filter::In { column, values } => values.contains(&row[column.as_str()]),
        Filter::Compare { column, op, value } => {
            let (a, b) = (text(column), value.as_str().unwrap_or("").to_owned());
            match op {
                Compare::Eq => &row[column.as_str()] == value,
                Compare::Ne => &row[column.as_str()] != value,
                Compare::Gt => a > b,
                Compare::Ge => a >= b,
                Compare::Lt => a < b,
                Compare::Le => a <= b,
                _ => panic!("fake host does not model this comparison"),
            }
        }
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        let actor = self.actor.get();
        match (port, operation) {
            ("db", "query") => {}
            ("context", "read") => return Ok(json!({"actorUserId": actor, "now": *self.clock.borrow()})),
            ("context", "uuid") => return Ok(json!({"id": self.next_id()})),
            ("kv", "get") => {
                let saved = self.stored.borrow().get(&(actor.to_owned(), resource.to_owned())).cloned();
                return Ok(saved.unwrap_or(Value::Null));
            }
            ("kv", "set") => {
                let mut all = self.stored.borrow_mut();
                all.insert((actor.to_owned(), resource.to_owned()), parameters);
                let size: usize = all.iter().filter(|((who, _), _)| who == actor).map(|(_, v)| v.to_string().len()).sum();
                if size > 8 * 1024 * 1024 {
                    return Err(Error::new("The module's key-value store is full"));
                }
                return Ok(json!({"saved": true}));
            }
            ("kv", "delete") => {
                self.stored.borrow_mut().remove(&(actor.to_owned(), resource.to_owned()));
                return Ok(json!({"removed": true}));
            }
            ("jobs", "enqueue-options") => {
                if self.queue_failure.get() {
                    return Err(Error::new("queue down"));
                }
                self.queued.borrow_mut().push((resource.to_owned(), parameters));
                return Ok(json!({"queued": true}));
            }
            ("context", "local-date") => {
                return Ok(json!({"timezone":"America/Los_Angeles","date":"2026-11-11","offsetMinutes":-480,
                    "start":"2026-11-11T08:00:00.000Z","nextStart":"2026-11-12T08:00:00.000Z","now":"2026-11-11T18:00:00.000Z"}))
            }
            ("kv", "preference.read") => {
                let saved = self.preferences.borrow().get(&(actor.to_owned(), resource.to_owned())).cloned();
                return Ok(json!({"value": saved.unwrap_or(Value::Null)}));
            }
            ("kv", "preference.write") => {
                self.preferences
                    .borrow_mut()
                    .insert((actor.to_owned(), resource.to_owned()), parameters["value"].clone());
                return Ok(json!({"value": parameters["value"]}));
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
                        let (x, y) = (&a[order.column.as_str()], &b[order.column.as_str()]);
                        let ord = x.as_str().unwrap_or("").cmp(y.as_str().unwrap_or(""));
                        if order.descending { ord.reverse() } else { ord }
                    });
                }
                Ok(json!(found.into_iter().take(query.limit.unwrap_or(1000) as usize).collect::<Vec<_>>()))
            }
            Kind::Insert => {
                let id = self.next_id();
                let n = self.ids.get();
                // Moments rise one microsecond at a time, and two check-ins can share one moment.
                let at = format!("2026-11-11T18:00:{:02}.123456Z", n / 2);
                let mut row = json!({"id": id, "owner_user_id": actor, "checked_in_at": at, "created_at": at,
                    "wheel_version": "v2", "feeling_secondary": null, "feeling_tertiary": null,
                    "sensations": [], "intensity": null, "energy": null, "note": null,
                    "identified_via": "wheel", "local_date": null, "timezone_offset": 0});
                if resource.ends_with("therapy_notes") {
                    row = json!({"id": row["id"], "owner_user_id": actor, "created_at": at, "updated_at": at,
                        "linked_checkin_id": null, "linked_emotion": null});
                }
                for (k, v) in &query.values {
                    row[k.as_str()] = v.clone();
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
