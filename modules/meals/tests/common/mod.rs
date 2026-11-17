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
use std::collections::{BTreeMap, VecDeque};

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
    /// The model's answers, taken in order. An empty queue makes the model call fail.
    pub model: RefCell<VecDeque<std::result::Result<String, String>>>,
    /// When set, the host's job queue refuses to take a job.
    pub queue_refuses: Cell<bool>,
    /// Jobs taken as (queue, parameters, idempotency key).
    pub queued: RefCell<Vec<(String, Value, String)>>,
    /// Minutes east of UTC at an instant, for the person's time zone.
    pub zone: Cell<fn(i64) -> i64>,
    ids: Cell<u32>,
}

/// A zone with a fixed offset of eight hours west of UTC.
pub fn pacific_standard(_: i64) -> i64 {
    -480
}

/// A zone that skips 02:00-03:00 on 2026-03-08 and repeats 01:00-02:00 on 2026-11-01, as the
/// United States Pacific zone does.
pub fn pacific(ms: i64) -> i64 {
    let spring = 1_772_964_000_000; // 2026-03-08T10:00:00Z
    let autumn = 1_793_523_600_000; // 2026-11-01T09:00:00Z
    if (spring..autumn).contains(&ms) {
        -420
    } else {
        -480
    }
}

impl Fake {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            tables: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(vec![]),
            db_failure: RefCell::new(None),
            tools_refuse: Cell::new(false),
            model: RefCell::new(VecDeque::new()),
            queue_refuses: Cell::new(false),
            queued: RefCell::new(vec![]),
            zone: Cell::new(pacific_standard),
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
        self.tables
            .borrow_mut()
            .entry(table.into())
            .or_default()
            .push(row);
    }
}

/// The column defaults of the real tables.
fn defaults(table: &str, at: &str) -> Value {
    match table {
        "app.meals_kitchens" => {
            json!({"units_system":"us","default_pantry_mode":"prefer","created_at":at,"updated_at":at})
        }
        "app.meals_household_members" => json!({"is_self":false,"linked_account_email":null,
            "calorie_target":null,"protein_target_g":null,"carb_target_g":null,"fat_target_g":null,
            "meal_pattern":["breakfast","lunch","dinner"],"restrictions":[],"preferences":[],
            "sort_order":0,"created_at":at,"updated_at":at}),
        "app.meals_meal_slot_rules" => {
            json!({"solo_weekdays":[],"usual_time":null,"created_at":at,"updated_at":at})
        }
        "app.meals_favourites" => json!({"created_at":at}),
        "app.meals_ratings" => json!({"rated_at":at}),
        "app.meals_shopping_lists" => json!({"plan_id":null,"created_at":at,"updated_at":at}),
        "app.meals_shopping_list_items" => json!({"line_key":null,"quantity":null,"unit":null,
            "purchase_quantity":null,"purchase_unit":null,"store_section":"other","manual":false,
            "covered_by_pantry":false,"not_in_plan":false,"converted_from":[],"source_meal_ids":[],
            "checked_at":null,"bought_at":null,"created_at":at,"updated_at":at}),
        "app.meals_pantry_items" => {
            json!({"quantity":null,"unit":null,"source":"manual","created_at":at,"updated_at":at})
        }
        "app.meals_staples" => json!({"created_at":at}),
        "app.meals_undo_actions" => json!({"undone_at":null,"created_at":at}),
        "app.meals_log_entries" => {
            json!({"serving_note":null,"estimate_revision":1,"created_at":at,"updated_at":at})
        }
        "app.meals_log_estimates" => json!({"calories_kcal":null,"protein_g":null,
            "carbohydrates_g":null,"fat_g":null,"fiber_g":null,"sugar_g":null,"sodium_mg":null,
            "missing_details":null,"clarification_question":null,"created_at":at}),
        "app.meals_log_estimate_items" => json!({"portion_note":null,"calories_kcal":null,
            "protein_g":null,"carbohydrates_g":null,"fat_g":null,"fiber_g":null,"sugar_g":null,
            "sodium_mg":null,"created_at":at}),
        "app.meals_swap_choices" => json!({"status":"pending","recipe_id":null,"generation":1,"created_at":at,"updated_at":at}),
        "app.meals_plans" | "app.meals_plan_days" | "app.meals_planned_meals"
        | "app.meals_planned_meal_eaters" | "app.meals_recipes"
        | "app.meals_recipe_ingredients" => json!({"created_at":at}),
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
            Compare::Ge => order_of(&row[column.as_str()], value).is_ge(),
            Compare::Le => order_of(&row[column.as_str()], value).is_le(),
            Compare::Gt => order_of(&row[column.as_str()], value).is_gt(),
            Compare::Lt => order_of(&row[column.as_str()], value).is_lt(),
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
        "app.meals_household_members" => {
            same("member_id")
                || (same("kitchen_id") && a["is_self"] == true && b["is_self"] == true)
        }
        "app.meals_meal_slot_rules" => same("kitchen_id") && same("slot_name"),
        "app.meals_favourites" | "app.meals_ratings" => same("member_id") && same("recipe_id"),
        "app.meals_shopping_lists" => same("list_id"),
        "app.meals_shopping_list_items" => {
            same("line_id")
                || (same("list_id")
                    && !a["line_key"].is_null()
                    && same("line_key")
                    && a["bought_at"].is_null()
                    && b["bought_at"].is_null())
        }
        "app.meals_pantry_items" => same("item_id"),
        "app.meals_planned_meal_eaters" => same("meal_id") && same("member_id"),
        "app.meals_swap_choices" => same("choice_id"),
        "app.meals_staples" => same("staple_id") || (same("kitchen_id") && same("name_key")),
        "app.meals_undo_actions" => same("action_id"),
        "app.meals_log_entries" => same("entry_id") || same("idempotency_key"),
        "app.meals_log_estimates" => same("entry_id") && same("revision"),
        "app.meals_log_estimate_items" => {
            same("entry_id") && same("revision") && same("item_index")
        }
        _ => false,
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
        let actor = self.actor.get();
        match (port, operation) {
            ("db", "query") => {}
            ("context", "read") => {
                let at = chrono::DateTime::from_timestamp_millis(1_794_000_000_000).unwrap();
                return Ok(
                    json!({"actorUserId": actor, "now": at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}),
                );
            }
            ("context", "uuid") => return Ok(json!({"id": self.next_id()})),
            ("context", "local-date") => {
                let at = parameters["instant"].as_str().and_then(moss_meals_module::util::epoch_ms);
                let at = at.ok_or_else(|| Error::new("Unreadable instant"))?;
                let days = parameters["offsetDays"].as_i64().unwrap_or(0);
                let offset = (self.zone.get())(at);
                let local = moss_meals_module::moments::iso_from_ms(at + offset * 60_000 + days * 86_400_000);
                return Ok(json!({"date": &local[..10], "offsetMinutes": offset}));
            }
            ("ai", "generate") => {
                return match self.model.borrow_mut().pop_front() {
                    Some(Ok(text)) => Ok(json!({"text": text})),
                    _ => Err(Error::new("The model is unavailable")),
                };
            }
            ("jobs", "enqueue-options") => {
                if self.queue_refuses.get() {
                    return Err(Error::new("The job queue is unavailable"));
                }
                let key = parameters["idempotencyKey"].as_str().unwrap_or_default().to_owned();
                self.queued
                    .borrow_mut()
                    .push((resource.to_owned(), parameters["params"].clone(), key));
                return Ok(json!({}));
            }
            ("tools", "run") if !self.tools_refuse.get() => {
                return Ok(json!({"data":{"ran":resource}}))
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
                        let ord = order_of(&a[order.column.as_str()], &b[order.column.as_str()]);
                        if order.descending {
                            ord.reverse()
                        } else {
                            ord
                        }
                    });
                }
                Ok(json!(found
                    .into_iter()
                    .take(query.limit.unwrap_or(1000) as usize)
                    .collect::<Vec<_>>()))
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
                    assert_eq!(
                        query.conflict,
                        Conflict::Ignore,
                        "a clash needs the ignore or update rule"
                    );
                    return Ok(json!([]));
                }
                rows.push(row.clone());
                Ok(json!([row]))
            }
            Kind::Update => {
                let mut changed = vec![];
                for row in rows
                    .iter_mut()
                    .filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter))
                {
                    for (k, v) in &query.values {
                        row[k.as_str()] = v.clone();
                    }
                    changed.push(row.clone());
                }
                Ok(json!(changed))
            }
            Kind::Delete => {
                let (gone, kept): (Vec<Value>, Vec<Value>) = rows
                    .drain(..)
                    .partition(|r| r["owner_user_id"] == actor && matches(r, &query.filter));
                *rows = kept;
                // A deleted entry takes its estimates and their items with it, as the real
                // tables' cascading keys do.
                if resource == "app.meals_log_entries" {
                    for child in ["app.meals_log_estimates", "app.meals_log_estimate_items"] {
                        if let Some(children) = tables.get_mut(child) {
                            children.retain(|c| {
                                !gone.iter().any(|g| {
                                    g["owner_user_id"] == c["owner_user_id"]
                                        && g["entry_id"] == c["entry_id"]
                                })
                            });
                        }
                    }
                }
                Ok(json!(gone))
            }
        }
    }
}
