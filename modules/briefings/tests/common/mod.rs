#![allow(dead_code)]
//! An in-memory host that mimics the row rules the guest relies on. Definitions are visible to
//! their owner and to a person they are shared with. Runs are visible to the owner only. The
//! real-database tests in the host crate prove the same rules against Postgres.
use moss_module_sdk::{
    query::{Compare, Filter, Kind, Query},
    Host, Result, RouteRequest,
};
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};

pub const A: &str = "00000000-0000-4000-8000-00000000000a";
pub const B: &str = "00000000-0000-4000-8000-00000000000b";
pub const NOW: &str = "2026-11-11T10:00:00.000Z";

pub struct Fake {
    pub actor: Cell<&'static str>,
    pub definitions: RefCell<Vec<Value>>,
    pub runs: RefCell<Vec<Value>>,
    /// (definition id, person, level) rows of the share table.
    pub shares: RefCell<Vec<(String, String, String)>>,
    /// Every job call as (operation, queue, parameters).
    pub jobs: RefCell<Vec<(String, String, Value)>>,
    /// The account's saved time zone per person. A missing entry makes the lookup fail.
    pub zones: RefCell<Vec<(String, String)>>,
    pub calls: RefCell<Vec<String>>,
    ids: Cell<u32>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            definitions: RefCell::new(vec![]),
            runs: RefCell::new(vec![]),
            shares: RefCell::new(vec![]),
            jobs: RefCell::new(vec![]),
            zones: RefCell::new(vec![]),
            calls: RefCell::new(vec![]),
            ids: Cell::new(0),
        }
    }
    pub fn as_actor(&self, actor: &'static str) {
        self.actor.set(actor);
    }
    pub fn zone(&self, person: &str, zone: &str) {
        self.zones.borrow_mut().push((person.into(), zone.into()));
    }
    pub fn share(&self, definition: &str, person: &str, level: &str) {
        self.shares.borrow_mut().push((definition.into(), person.into(), level.into()));
    }
    pub fn route(&self, method: &str, path: &str, params: &[(&str, &str)], body: Value) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: params.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            query: Default::default(),
            body,
        };
        let response = moss_briefings_module::route(self, request);
        (response.status, response.body)
    }
    pub fn seed_run(&self, definition: &str, owner: &str, id: &str, created: &str, metadata: Value) {
        self.runs.borrow_mut().push(json!({
            "id": id, "definition_id": definition, "owner_user_id": owner, "status": "succeeded",
            "run_kind": "manual", "briefing_type": "morning", "summary_text": "Today you have two meetings.",
            "source_metadata": metadata, "created_at": created
        }));
    }
    fn level(&self, row: &Value, level: &str) -> bool {
        let actor = self.actor.get();
        row["owner_user_id"] == actor
            || self.shares.borrow().iter().any(|(d, p, l)| {
                row["id"] == json!(d) && p == actor && (level == "view" || l == "manage")
            })
    }
    fn next_id(&self) -> String {
        let n = self.ids.get();
        self.ids.set(n + 1);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
}

fn matches(row: &Value, filter: &Filter) -> bool {
    match filter {
        Filter::All => true,
        Filter::Owned => true,
        Filter::And { filters } => filters.iter().all(|f| matches(row, f)),
        Filter::Or { filters } => filters.iter().any(|f| matches(row, f)),
        Filter::Null { column, not } => row[column.as_str()].is_null() != *not,
        Filter::In { column, values } => values.contains(&row[column.as_str()]),
        Filter::Compare { column, op, value } => {
            let left = &row[column.as_str()];
            match op {
                Compare::Eq => left == value,
                Compare::Ne => left != value,
                _ => panic!("fake host does not model this comparison"),
            }
        }
    }
}

fn order_by(rows: &mut [Value], query: &Query) {
    for order in query.order.iter().rev() {
        rows.sort_by(|a, b| {
            let (x, y) = (a[order.column.as_str()].as_str().unwrap_or(""), b[order.column.as_str()].as_str().unwrap_or(""));
            if order.descending { y.cmp(x) } else { x.cmp(y) }
        });
    }
}

impl Fake {
    fn query(&self, table: &str, query: Query) -> Vec<Value> {
        let actor = self.actor.get();
        match (table, query.kind.clone()) {
            ("app.briefing_definitions", Kind::Select) => {
                let mut rows: Vec<Value> = self
                    .definitions
                    .borrow()
                    .iter()
                    .filter(|r| self.level(r, "view") && matches(r, &query.filter))
                    .cloned()
                    .collect();
                order_by(&mut rows, &query);
                rows.into_iter().take(query.limit.unwrap_or(1000) as usize).collect()
            }
            ("app.briefing_definitions", Kind::Insert) => {
                let mut row = Map::new();
                row.insert("owner_user_id".into(), json!(actor));
                for (k, v) in &query.values {
                    row.insert(k.clone(), v.clone());
                }
                let row = Value::Object(row);
                self.definitions.borrow_mut().push(row.clone());
                vec![row]
            }
            ("app.briefing_definitions", Kind::Update) => {
                let mut out = vec![];
                for row in self.definitions.borrow_mut().iter_mut() {
                    if self.level(row, "manage") && matches(row, &query.filter) {
                        for (k, v) in &query.values {
                            row[k.as_str()] = v.clone();
                        }
                        out.push(row.clone());
                    }
                }
                out
            }
            ("app.briefing_runs", Kind::Select) => {
                let mut rows: Vec<Value> = self
                    .runs
                    .borrow()
                    .iter()
                    .filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter))
                    .cloned()
                    .collect();
                order_by(&mut rows, &query);
                rows.into_iter().skip(query.offset as usize).take(query.limit.unwrap_or(1000) as usize).collect()
            }
            other => panic!("unexpected query {other:?}"),
        }
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push(format!("{port}.{operation}.{resource}"));
        match (port, operation) {
            ("context", "read") => Ok(json!({"now": NOW, "actorUserId": self.actor.get()})),
            ("context", "uuid") => Ok(json!({"id": self.next_id()})),
            ("context", "local-date") => {
                let actor = self.actor.get();
                match self.zones.borrow().iter().find(|(p, _)| p == actor) {
                    Some((_, zone)) => Ok(json!({"timezone": zone})),
                    None => Err(moss_module_sdk::Error::new("No saved time zone")),
                }
            }
            ("jobs", "schedule") => {
                let key = parameters["key"].as_str().unwrap_or("").to_owned();
                self.jobs.borrow_mut().push(("schedule".into(), resource.into(), parameters));
                Ok(json!({"id": format!("job-{key}")}))
            }
            ("jobs", "unschedule") => {
                self.jobs.borrow_mut().push(("unschedule".into(), resource.into(), parameters));
                Ok(json!({}))
            }
            ("db", "query") => {
                let query: Query = serde_json::from_value(parameters)?;
                Ok(Value::Array(self.query(resource, query)))
            }
            _ => panic!("unexpected host call {port}.{operation}"),
        }
    }
}
