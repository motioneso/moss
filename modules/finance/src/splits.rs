//! Splitting one posted transaction across categories (`app.finance_transactions.splits`).
use crate::input::{self, refuse, Refusal};
use crate::ledger::{first, log, values, Outcome, TRANSACTIONS};
use crate::text::is_calendar_month;
use crate::transactions::{and, live_category, same, splits_of};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

pub const MAX_PARTS: usize = 20;
const PART_LIMIT: i64 = 100_000_000;

fn stale() -> Refusal {
    refuse("stale_transaction", "The transaction changed; refresh and try again")
}

fn list(input: &serde_json::Map<String, Value>, key: &str) -> std::result::Result<Vec<Value>, Refusal> {
    let items = input.get(key).and_then(Value::as_array).ok_or_else(|| input::invalid(format!("{key} must be a list")))?;
    if items.is_empty() || items.len() > MAX_PARTS {
        return Err(input::invalid(format!("{key} must hold 1 to {MAX_PARTS} items")));
    }
    Ok(items.clone())
}

/// `finance.transactions.splits`. Replaces the allocation of one row.
pub fn apply<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let id = ask!(input::required_string(input, "transactionId", Some(256)));
    let account = ask!(input::required_string(input, "accountId", Some(128)));
    let month = ask!(input::required_string(input, "month", None));
    if !is_calendar_month(&month) {
        return Ok(Err(input::invalid("month must be a valid YYYY-MM")));
    }
    let amount = ask!(input::int(input, "expectedAmountCents"));
    let currency = ask!(input::required_string(input, "expectedCurrency", Some(8)));
    let revision = ask!(input::int(input, "expectedRevision"));
    if revision < 0 {
        return Ok(Err(input::invalid("expectedRevision must not be negative")));
    }
    let categories = ask!(list(input, "categoryIds"));
    let amounts = ask!(list(input, "amountsCents"));
    if categories.len() != amounts.len() {
        return Ok(Err(input::invalid("categoryIds and amountsCents must have the same length")));
    }
    let mut parts = Vec::new();
    let mut total: i64 = 0;
    for (category, cents) in categories.iter().zip(&amounts) {
        let (Some(category), Some(cents)) = (category.as_str(), cents.as_i64()) else {
            return Ok(Err(input::invalid("Each part needs a category and a whole number of cents")));
        };
        if cents.abs() > PART_LIMIT {
            return Ok(Err(input::invalid("A part is outside the supported range")));
        }
        if !live_category(host, category)? {
            return Ok(Err(refuse("invalid_category", "Choose a current category")));
        }
        total += cents;
        parts.push(json!({"categoryId": category, "amountCents": cents}));
    }
    let Some(row) = first(host, TRANSACTIONS, and(vec![Filter::eq("id", id.clone()), Filter::eq("account_id", account.clone())]))? else {
        return Ok(Err(refuse("not_found", "That transaction was not found")));
    };
    if row["date"].as_str().is_none_or(|d| !d.starts_with(&month)) {
        return Ok(Err(refuse("not_found", "That transaction was not found")));
    }
    if !row["transfer_id"].is_null() {
        return Ok(Err(refuse("linked_transfer", "Linked transfers are managed from the transfer")));
    }
    if row["pending"] == true {
        return Ok(Err(refuse("pending_transaction", "Split a transaction after it posts")));
    }
    if row["amount_cents"] != json!(amount) || row["iso_currency"] != json!(currency) || row["split_revision"].as_i64().unwrap_or(0) != revision {
        return Ok(Err(stale()));
    }
    if total != amount {
        return Ok(Err(refuse("split_total_mismatch", "The parts must add up to the transaction amount")));
    }
    let now: Vec<(String, i64)> = parts.iter().map(|p| (p["categoryId"].as_str().unwrap_or("").to_owned(), p["amountCents"].as_i64().unwrap_or(0))).collect();
    if splits_of(&row) == now {
        return Ok(Ok(json!({"status":"ok","unchanged":true})));
    }
    let changed = Client(host).query(
        TRANSACTIONS,
        &Query::update(
            and(vec![Filter::eq("id", id.clone()), Filter::eq("account_id", account.clone()), same("split_revision", &row["split_revision"]), same("splits", &row["splits"])]),
            values(vec![
                ("splits", json!(parts)),
                ("split_revision", json!(revision + 1)),
                ("category_id", Value::Null),
                ("review_state", json!("confirmed")),
            ]),
        ),
    )?;
    if changed.is_empty() {
        return Ok(Err(stale()));
    }
    log(host, "transaction.split", json!({"transactionId":id,"accountId":account,"month":month,"parts":parts.len()}))?;
    Ok(Ok(json!({"status":"ok","parts":parts.len()})))
}
