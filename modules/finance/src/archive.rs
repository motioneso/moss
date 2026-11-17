//! `finance.category.archive`. Retires a category that holds no budget money.
//!
//! The category stays in the table with an archive time, so old transactions keep its name. The
//! activity row carries the category id as its undo record.
use crate::budget::{self, ASSIGNMENTS, CATEGORIES};
use crate::input::{self, refuse};
use crate::ledger::{first, log_as, text, today, values, Outcome};
use crate::shared::pages;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

/// Categories the budget itself relies on.
const PROTECTED: [&str; 2] = ["income", "transfers"];

/// Any budget money in the category now or in a future month.
fn holds_money<H: Host + ?Sized>(host: &H, id: &str, iso: &str, day: &str) -> Result<bool> {
    let book = budget::load(host)?;
    let month = &day[..7];
    let context = budget::context(host, &book, iso, month, day)?;
    if context.month.categories.get(id).is_some_and(|c| c.assigned != 0 || c.available != 0) {
        return Ok(true);
    }
    Ok(budget::ledgers(&book).iter().any(|(m, l)| m.as_str() > month && l.get(id).is_some_and(|c| *c != 0)))
}

pub fn archive<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let id = ask!(input::required_string(input, "id", Some(256)));
    if PROTECTED.contains(&id.as_str()) {
        return Ok(Err(refuse("protected_category", "Income and transfers cannot be archived")));
    }
    let policy = match budget::require(host)? {
        Ok(p) => p,
        Err(r) => return Ok(Err(r)),
    };
    let live = Filter::And { filters: vec![Filter::eq("id", id.clone()), Filter::Null { column: "archived_at".into(), not: false }] };
    if first(host, CATEGORIES, live.clone())?.is_none() {
        return Ok(Err(refuse("invalid_category", "That category was not found")));
    }
    if holds_money(host, &id, &policy.iso, &today(host)?)? {
        return Ok(Err(refuse("has_assignments", "Move or clear the budgeted money before archiving this category")));
    }
    let now = text(host, "call", "read", "now")?;
    Client(host).query(CATEGORIES, &Query::update(live, values(vec![("archived_at", json!(now))])))?;
    log_as(host, "moss", "category.archive", json!({"categoryId":id}), Some(json!({"categoryId":id})))?;
    Ok(Ok(json!({"status":"ok","categoryId":id,"before":{"archived":false},"after":{"archived":true}})))
}

/// True when any budget row or transaction (whole or split) still uses the category.
pub fn in_use<H: Host + ?Sized>(host: &H, id: &str) -> Result<bool> {
    if first(host, ASSIGNMENTS, Filter::eq("category_id", id))?.is_some() {
        return Ok(true);
    }
    if first(host, crate::ledger::TRANSACTIONS, Filter::eq("category_id", id))?.is_some() {
        return Ok(true);
    }
    let split = pages(host, crate::ledger::TRANSACTIONS, Filter::Null { column: "splits".into(), not: true }, &["id"])?;
    Ok(split.iter().any(|t| crate::transactions::splits_of(t).iter().any(|p| p.0 == id)))
}
