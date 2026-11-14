#![allow(dead_code)]
//! An in-memory host that mimics the row rules the guest relies on. Follows belong to one
//! person, the two unique rules of the real table apply, and saved settings are one value per
//! person and key. The real-database tests in the host crate prove the same rules in Postgres.
pub mod both;
pub mod espn;
use moss_module_sdk::{
    query::{Compare, Conflict, Filter, Kind, Query},
    Error, Host, Result, RouteRequest,
};
use moss_sports_module::{identity::Team, teams::TeamList};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

pub const A: &str = "00000000-0000-4000-8000-00000000000a";
pub const B: &str = "00000000-0000-4000-8000-00000000000b";

pub struct Fake {
    pub actor: Cell<&'static str>,
    pub follows: RefCell<Vec<Value>>,
    /// Saved settings as (person, resource, value).
    pub settings: RefCell<Vec<(String, String, Value)>>,
    /// Every host call as (port, operation, resource, parameters).
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
    /// When set, every database call fails with this message.
    pub db_failure: RefCell<Option<String>>,
    ids: Cell<u32>,
    clock: Cell<u32>,
}

/// A fixed team list for tests that need one.
pub struct Teams(pub Vec<(String, Vec<Team>)>);
impl TeamList for Teams {
    fn teams(&self, competition_key: &str) -> Vec<Team> {
        self.0.iter().find(|(k, _)| k == competition_key).map(|(_, t)| t.clone()).unwrap_or_default()
    }
}

pub fn team(key: &str, abbreviation: Option<&str>, name: &str, id: Option<&str>) -> Team {
    Team {
        team_key: key.into(),
        abbreviation: abbreviation.map(str::to_owned),
        name: name.into(),
        source_team_id: id.map(str::to_owned),
    }
}

impl Fake {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            follows: RefCell::new(vec![]),
            settings: RefCell::new(vec![]),
            calls: RefCell::new(vec![]),
            db_failure: RefCell::new(None),
            ids: Cell::new(0),
            clock: Cell::new(0),
        }
    }
    pub fn as_actor(&self, actor: &'static str) {
        self.actor.set(actor);
    }
    pub fn route(&self, method: &str, path: &str, params: &[(&str, &str)], body: Value) -> (u16, Value) {
        self.route_with(&moss_sports_module::teams::Unavailable, method, path, params, body)
    }
    pub fn route_with(
        &self,
        teams: &dyn TeamList,
        method: &str,
        path: &str,
        params: &[(&str, &str)],
        body: Value,
    ) -> (u16, Value) {
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
    /// A follow saved before permanent ids, as the old table could hold one.
    pub fn seed_old_team(&self, owner: &str, competition: &str, team_key: &str) -> String {
        let id = self.next_id();
        let row = self.row(&id, owner, competition, json!(team_key), Value::Null);
        self.follows.borrow_mut().push(row);
        id
    }
    fn next_id(&self) -> String {
        let n = self.ids.get();
        self.ids.set(n + 1);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    fn row(&self, id: &str, owner: &str, competition: &str, team_key: Value, source: Value) -> Value {
        let tick = self.clock.get();
        self.clock.set(tick + 1);
        json!({
            "id": id, "owner_user_id": owner, "competition_key": competition, "team_key": team_key,
            "source_team_id": source, "created_at": format!("2026-11-11T10:00:{tick:02}.000+00:00")
        })
    }
    pub fn setting(&self, person: &str, resource: &str) -> Option<Value> {
        self.settings.borrow().iter().find(|(p, r, _)| p == person && r == resource).map(|(_, _, v)| v.clone())
    }
    pub fn put_setting(&self, person: &str, resource: &str, value: Value) {
        let mut all = self.settings.borrow_mut();
        all.retain(|(p, r, _)| !(p == person && r == resource));
        all.push((person.into(), resource.into(), value));
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

fn clash(a: &Value, b: &Value) -> bool {
    let same = |k: &str| a[k] == b[k];
    same("owner_user_id")
        && same("competition_key")
        && ((a["team_key"].is_null() && b["team_key"].is_null())
            || (!a["source_team_id"].is_null() && same("source_team_id")))
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        let actor = self.actor.get();
        match (port, operation) {
            ("kv", "preference.read") => {
                Ok(json!({"value":self.setting(actor, resource).unwrap_or(Value::Null)}))
            }
            ("kv", "preference.write") => {
                self.put_setting(actor, resource, parameters["value"].clone());
                Ok(json!({"value":parameters["value"]}))
            }
            ("db", "query") => {
                if let Some(message) = self.db_failure.borrow().clone() {
                    return Err(Error::new(message));
                }
                let query: Query = serde_json::from_value(parameters)?;
                let mut follows = self.follows.borrow_mut();
                match query.kind {
                    Kind::Select => {
                        let mut rows: Vec<Value> = follows
                            .iter()
                            .filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter))
                            .cloned()
                            .collect();
                        for order in query.order.iter().rev() {
                            rows.sort_by(|a, b| {
                                let (x, y) = (
                                    a[order.column.as_str()].as_str().unwrap_or(""),
                                    b[order.column.as_str()].as_str().unwrap_or(""),
                                );
                                if order.descending { y.cmp(x) } else { x.cmp(y) }
                            });
                        }
                        let rows: Vec<Value> = rows.into_iter().take(query.limit.unwrap_or(1000) as usize).collect();
                        Ok(json!(rows))
                    }
                    Kind::Insert => {
                        let v = |k: &str| query.values.get(k).cloned().unwrap_or(Value::Null);
                        let id = self.next_id();
                        let row = self.row(&id, actor, v("competition_key").as_str().unwrap(), v("team_key"), v("source_team_id"));
                        if follows.iter().any(|r| clash(r, &row)) {
                            assert_eq!(query.conflict, Conflict::Ignore, "a clash needs the ignore rule");
                            return Ok(json!([]));
                        }
                        follows.push(row.clone());
                        Ok(json!([row]))
                    }
                    Kind::Update => {
                        let mut changed = vec![];
                        for row in follows.iter_mut().filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter)) {
                            for (k, v) in &query.values {
                                row[k.as_str()] = v.clone();
                            }
                            changed.push(row.clone());
                        }
                        Ok(json!(changed))
                    }
                    Kind::Delete => {
                        let (gone, kept): (Vec<Value>, Vec<Value>) = follows
                            .drain(..)
                            .partition(|r| r["owner_user_id"] == actor && matches(r, &query.filter));
                        *follows = kept;
                        Ok(json!(gone))
                    }
                }
            }
            _ => Err(Error::new("Unexpected host call")),
        }
    }
}
