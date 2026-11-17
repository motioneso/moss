#![allow(dead_code)]
//! An in-memory host that mimics the row rules the Meals guest relies on. Every table is
//! owner-only, the unique rules of the real tables apply, and deletes return the rows removed.
//! The real-database tests in the host crate prove the same rules in Postgres.
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
    /// When set, the host's tool port refuses to run a tool.
    pub tools_refuse: Cell<bool>,
    ids: Cell<u32>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            tables: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(vec![]),
            db_failure: RefCell::new(None),
            tools_refuse: Cell::new(false),
            ids: Cell::new(0),
        }
    }
    pub fn as_actor(&self, actor: &'static str) {
        self.actor.set(actor);
    }
    pub fn route(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: Default::default(),
            query: Default::default(),
            body,
        };
        let response = moss_meals_module::route(self, request);
        (response.status, response.body)
    }
    /// Runs one tool through the same entry point the installed component uses.
    pub fn tool(&self, tool: &str, parameters: Value) -> Value {
        let payload = json!({"tool":tool,"parameters":parameters}).to_string();
        let answer = moss_meals_module::handle(self, "tool", &payload).expect("tool answer");
        serde_json::from_str(&answer).unwrap()
    }
    /// The data a tool returned, failing the test when it returned an error.
    pub fn ok(&self, tool: &str, parameters: Value) -> Value {
        let answer = self.tool(tool, parameters);
        assert!(answer["data"]["error"].is_null(), "{answer}");
        answer["data"].clone()
    }
    /// The error a tool returned as (code, message).
    pub fn refused(&self, tool: &str, parameters: Value) -> (String, String) {
        let answer = self.tool(tool, parameters);
        let data = &answer["data"];
        (
            data["code"].as_str().expect("an error code").to_owned(),
            data["error"].as_str().expect("an error message").to_owned(),
        )
    }
    fn next_id(&self) -> String {
        let n = self.ids.get();
        self.ids.set(n + 1);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
    fn stamp(&self) -> String {
        let n = self.ids.get();
        format!("2026-11-11T10:{:02}:{:02}.000+00:00", n / 60, n % 60)
    }
    pub fn rows(&self, table: &str) -> Vec<Value> {
        self.tables.borrow().get(table).cloned().unwrap_or_default()
    }
    /// Puts a row in a table for a person, as the real table would on insert.
    pub fn seed(&self, table: &str, owner: &str, values: Value) {
        let mut row = defaults(table, &self.stamp());
        row["owner_user_id"] = json!(owner);
        for (k, v) in values.as_object().unwrap() {
            row[k.as_str()] = v.clone();
        }
        self.ids.set(self.ids.get() + 1);
        self.tables.borrow_mut().entry(table.into()).or_default().push(row);
    }
}

/// The column defaults of the real tables.
fn defaults(table: &str, at: &str) -> Value {
    match table {
        "app.meals_kitchens" => json!({"units_system":"us","default_pantry_mode":"prefer","created_at":at,"updated_at":at}),
        "app.meals_household_members" => json!({"is_self":false,"linked_account_email":null,
            "calorie_target":null,"protein_target_g":null,"carb_target_g":null,"fat_target_g":null,
            "meal_pattern":["breakfast","lunch","dinner"],"restrictions":[],"preferences":[],
            "sort_order":0,"created_at":at,"updated_at":at}),
        "app.meals_meal_slot_rules" => json!({"solo_weekdays":[],"usual_time":null,"created_at":at,"updated_at":at}),
        "app.meals_favourites" => json!({"created_at":at}),
        other => panic!("fake host does not know {other}"),
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
    let same = |k: &str| a[k] == b[k];
    if !same("owner_user_id") {
        return false;
    }
    match table {
        "app.meals_kitchens" => true,
        "app.meals_household_members" => same("member_id") || (same("kitchen_id") && a["is_self"] == true && b["is_self"] == true),
        "app.meals_meal_slot_rules" => same("kitchen_id") && same("slot_name"),
        _ => same("member_id") && same("recipe_id"),
    }
}

fn order_of(x: &Value, y: &Value) -> std::cmp::Ordering {
    match (x.as_i64(), y.as_i64(), x.as_bool(), y.as_bool()) {
        (Some(x), Some(y), _, _) => x.cmp(&y),
        (_, _, Some(x), Some(y)) => x.cmp(&y),
        _ => x.as_str().unwrap_or("").cmp(y.as_str().unwrap_or("")),
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        let actor = self.actor.get();
        match (port, operation) {
            ("db", "query") => {}
            ("context", "read") => {
                let at = chrono::DateTime::from_timestamp_millis(1_794_000_000_000).unwrap();
                return Ok(json!({"actorUserId": actor, "now": at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}));
            }
            ("context", "uuid") => return Ok(json!({"id": self.next_id()})),
            ("tools", "run") if !self.tools_refuse.get() => return Ok(json!({"data":{"ran":resource}})),
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
                        let ord = order_of(&a[order.column.as_str()], &b[order.column.as_str()]);
                        if order.descending { ord.reverse() } else { ord }
                    });
                }
                Ok(json!(found.into_iter().take(query.limit.unwrap_or(1000) as usize).collect::<Vec<_>>()))
            }
            Kind::Insert => {
                drop(tables);
                let stamp = self.stamp();
                self.ids.set(self.ids.get() + 1);
                let mut row = defaults(resource, &stamp);
                row["owner_user_id"] = json!(actor);
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
