#![allow(dead_code)]
//! An in-memory host that mimics the rules the guest relies on. Tables are owner-only, fill the
//! defaults the real tables fill, and refuse a repeated primary key unless the query ignores it.
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
pub const OP1: &str = "11111111-1111-4111-8111-111111111111";
pub const OP2: &str = "22222222-2222-4222-8222-222222222222";
pub const OP3: &str = "33333333-3333-4333-8333-333333333333";

pub struct Fake {
    pub actor: Cell<&'static str>,
    pub tables: RefCell<BTreeMap<String, Vec<Value>>>,
    /// Every host call as (port, operation, resource, parameters).
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
    pub db_failure: RefCell<Option<String>>,
    /// Whether the account has granted the assistant's write a one-use approval.
    pub approved: Cell<bool>,
    pub today: RefCell<String>,
    /// Policy tier per action family, as the account has set it.
    /// Test switch that removes the owner-only protection, to prove isolation tests can fail.
    pub bypass_owner: Cell<bool>,
    pub tiers: RefCell<BTreeMap<String, String>>,
    ids: Cell<u32>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            actor: Cell::new(A),
            tables: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(vec![]),
            db_failure: RefCell::new(None),
            approved: Cell::new(false),
            today: RefCell::new("2026-11-11".into()),
            bypass_owner: Cell::new(false),
            tiers: RefCell::new(BTreeMap::new()),
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
            params: BTreeMap::new(),
            query: BTreeMap::new(),
            body,
        };
        let response = moss_finance_module::route(self, request);
        (response.status, response.body)
    }
    pub fn get(&self, path: &str, query: Value) -> (u16, Value) {
        let request = RouteRequest {
            method: "GET".into(),
            path: path.into(),
            params: BTreeMap::new(),
            query: query.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            body: Value::Null,
        };
        let response = moss_finance_module::route(self, request);
        (response.status, response.body)
    }
    pub fn tool(&self, tool: &str, parameters: Value) -> Value {
        let payload = json!({"tool":tool,"parameters":parameters}).to_string();
        serde_json::from_str(&moss_finance_module::handle(self, "tool", &payload).unwrap()).unwrap()
    }
    pub fn rows(&self, table: &str) -> Vec<Value> {
        self.tables.borrow().get(table).cloned().unwrap_or_default()
    }
    pub fn seed(&self, table: &str, owner: &str, mut row: Value) {
        row["owner_user_id"] = json!(owner);
        self.tables.borrow_mut().entry(table.into()).or_default().push(row);
    }
    pub fn account(&self, kind: &str, id: &str, date: &str, opening: i64) -> Value {
        let (s, b) = self.route("POST", "/finance/manual/accounts", json!({
            "operationId": id, "name": "Everyday", "accountType": kind, "isoCurrency": "USD",
            "openingDate": date, "openingBalanceCents": opening}));
        assert_eq!(s, 200, "{b}");
        b
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
            Compare::Lt | Compare::Le | Compare::Gt | Compare::Ge => {
                let ord = order(&row[column.as_str()], value);
                match op {
                    Compare::Lt => ord.is_lt(),
                    Compare::Le => ord.is_le(),
                    Compare::Gt => ord.is_gt(),
                    _ => ord.is_ge(),
                }
            }
            Compare::LowerEq => row[column.as_str()].as_str().is_some_and(|t| t.to_lowercase() == value.as_str().unwrap_or("")),
            Compare::Like | Compare::ILike => panic!("fake host does not model pattern matching"),
        },
    }
}

fn order(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (a.as_i64(), b.as_i64()) {
        (Some(x), Some(y)) => x.cmp(&y),
        _ => a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")),
    }
}

/// Tables any signed-in person can read, as the host's household-read class allows.
fn household(table: &str) -> bool {
    table == "app.finance_shared_accounts" || table == "app.finance_shared_transactions"
}

fn has_owned(filter: &Filter) -> bool {
    match filter {
        Filter::Owned => true,
        Filter::And { filters } | Filter::Or { filters } => filters.iter().any(has_owned),
        _ => false,
    }
}

fn keys(table: &str) -> &'static [&'static str] {
    match table {
        "app.finance_accounts" | "app.finance_shared_accounts" => &["account_id"],
        "app.finance_shared_transactions" => &["id"],
        "app.finance_transactions" | "app.finance_activity" | "app.finance_merchant_rules" | "app.finance_categories" => &["id"],
        "app.finance_imports" => &["id"],
        "app.finance_budget_assignments" => &["month", "category_id"],
        "app.finance_budget_drafts" => &["id"],
        "app.finance_budget_draft_lines" => &["draft_id", "category_key"],
        "app.finance_balance_snapshots" => &["account_id", "day"],
        "app.finance_targets" => &["category_id", "effective_month"],
        "app.finance_bill_plans" => &["id"],
        "app.finance_bill_occurrences" | "app.finance_bill_adjustments" => &["plan_id", "due_date"],
        "app.finance_bill_suggestion_dismissals" => &["account_id", "payee_key", "cadence", "amount_cents"],
        "app.finance_flex_policies" => &["month"],
        "app.finance_card_policies" => &["account_id"],
        "app.finance_card_assignments" => &["account_id", "month"],
        // One policy row per owner.
        "app.finance_budget_policy" => &["owner_user_id"],
        _ => &[],
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        let actor = self.actor.get();
        match (port, operation) {
            ("db", "query") => {}
            ("context", "local-date") => {
                return Ok(json!({"timezone":"America/Los_Angeles","date":self.today.borrow().clone(),"offsetMinutes":-480}))
            }
            ("context", "read") => return Ok(json!({"actorUserId":actor,"now":"2026-11-11T18:00:00.000Z"})),
            ("context", "uuid") => {
                let n = self.ids.get();
                self.ids.set(n + 1);
                return Ok(json!({"id":format!("00000000-0000-4000-8000-{n:012x}")}));
            }
            ("action-policy", "route-read") => {
                let tier = self.tiers.borrow().get(resource).cloned().unwrap_or_else(|| "ask_each_time".into());
                return Ok(json!({"tier":tier}));
            }
            ("tools", "run") => {
                if !self.approved.get() {
                    return Err(Error::new("This tool needs the account's approval"));
                }
                self.approved.set(false);
                let payload = json!({"tool":resource,"parameters":parameters["parameters"]}).to_string();
                let out = moss_finance_module::handle(self, "tool", &payload)?;
                return Ok(serde_json::from_str(&out)?);
            }
            _ => return Err(Error::new("Unexpected host call")),
        }
        if let Some(message) = self.db_failure.borrow().clone() {
            return Err(Error::new(message));
        }
        let query: Query = serde_json::from_value(parameters)?;
        let bypass = self.bypass_owner.get();
        let owns = |r: &Value| bypass || r["owner_user_id"] == actor;
        let mut tables = self.tables.borrow_mut();
        let rows = tables.entry(resource.to_owned()).or_default();
        match query.kind {
            Kind::Select => {
                let mut found: Vec<Value> =
                    rows.iter().filter(|r| (owns(r) || household(resource)) && (!has_owned(&query.filter) || r["owner_user_id"] == actor) && matches(r, &query.filter)).cloned().collect();
                for order in query.order.iter().rev() {
                    found.sort_by(|a, b| {
                        let ord = a[order.column.as_str()].to_string().cmp(&b[order.column.as_str()].to_string());
                        if order.descending { ord.reverse() } else { ord }
                    });
                }
                Ok(json!(found.into_iter().skip(query.offset as usize).take(query.limit.unwrap_or(1000) as usize).collect::<Vec<_>>()))
            }
            Kind::Insert => {
                let mut row = match resource {
                    "app.finance_accounts" => json!({"item_id":null,"official_name":null,"mask":null,"shared_to_household":false,
                        "ledger_revision":0,"archived_at":null,"last_reconciled_date":null}),
                    "app.finance_transactions" => json!({"merchant":null,"cleared":false,"splits":[],"split_revision":0,"transfer_id":null,
                        "reconciled_at":null,"ai_confidence":null,"plaid_category":null,"category_id":null,"notes":null,
                        "categorized_by":null,"pending_transaction_id":null,"review_state":"confirmed","pending":false}),
                    "app.finance_merchant_rules" => json!({"enabled":true}),
                    "app.finance_categories" => json!({"archived_at":null,"is_income":false}),
                    "app.finance_budget_policy" => json!({"revision":0,"taxonomy_ready":false}),
                    "app.finance_budget_drafts" => json!({"started_at":null}),
                    "app.finance_budget_draft_lines" => json!({"adjusted_cents":null,"adjusted_by":null,"dropped":false}),
                    _ => json!({}),
                };
                row["owner_user_id"] = json!(actor);
                for (k, v) in &query.values {
                    row[k.as_str()] = v.clone();
                }
                let key = keys(resource);
                let hit = rows.iter().position(|r| !key.is_empty() && r["owner_user_id"] == actor && key.iter().all(|k| r[*k] == row[*k]));
                if let Some(at) = hit {
                    return match query.conflict {
                        Conflict::Ignore => Ok(json!([])),
                        Conflict::Update { columns, values } => {
                            // The conflict target must be the table's key, as Postgres requires.
                            let mut target: Vec<&str> = columns.iter().map(String::as_str).filter(|c| *c != "owner_user_id").collect();
                            let mut expected: Vec<&str> = key.iter().copied().filter(|c| *c != "owner_user_id").collect();
                            target.sort();
                            expected.sort();
                            assert_eq!(target, expected, "conflict target is not the primary key of {resource}");
                            assert!(!values.contains_key("owner_user_id"), "an upsert may not change the owner");
                            for (k, v) in &values {
                                rows[at][k.as_str()] = v.clone();
                            }
                            Ok(json!([rows[at].clone()]))
                        }
                        Conflict::Error => Err(Error::new("duplicate key value violates unique constraint")),
                    };
                }
                rows.push(row.clone());
                Ok(json!([row]))
            }
            Kind::Update => {
                let mut changed = vec![];
                for row in rows.iter_mut().filter(|r| owns(r) && matches(r, &query.filter)) {
                    for (k, v) in &query.values {
                        row[k.as_str()] = v.clone();
                    }
                    changed.push(row.clone());
                }
                Ok(json!(changed))
            }
            Kind::Delete => {
                let mut gone = vec![];
                rows.retain(|r| {
                    let hit = owns(r) && matches(r, &query.filter);
                    if hit {
                        gone.push(r.clone());
                    }
                    !hit
                });
                Ok(json!(gone))
            }
        }
    }
}
