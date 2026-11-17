//! Household sharing. A person flags a bank account as shared and the package keeps a projection
//! of it in two mirror tables (`app.finance_shared_accounts`, `app.finance_shared_transactions`).
//! The host lets any signed-in person read those tables and lets only the owner write them, so
//! the projection is the only thing another person can ever see.
//!
//! Only allowlisted columns are copied. Notes, review state, confidence, split revisions, balance
//! history and bank link details never reach a mirror row.
use crate::input::{self, refuse};
use crate::ledger::{first, log, text, values, Outcome, ACCOUNTS, TRANSACTIONS};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const MIRROR_ACCOUNTS: &str = "app.finance_shared_accounts";
pub const MIRROR_TRANSACTIONS: &str = "app.finance_shared_transactions";
const PAGE: u32 = 1000;

/// Every row a filter matches, read a page at a time.
pub(crate) fn pages<H: Host + ?Sized>(host: &H, table: &str, filter: Filter, order: &[&str]) -> Result<Vec<Value>> {
    let client = Client(host);
    let mut out = Vec::new();
    loop {
        let mut query = Query::select(filter.clone());
        query.order = order.iter().map(|c| Order { column: (*c).into(), descending: false }).collect();
        query.limit = Some(PAGE);
        query.offset = out.len() as u32;
        let page = client.query(table, &query)?;
        let more = page.len() == PAGE as usize;
        out.extend(page);
        if !more {
            return Ok(out);
        }
    }
}

pub(crate) fn actor<H: Host + ?Sized>(host: &H) -> Result<String> {
    text(host, "call", "read", "actorUserId")
}

fn others(actor: &str) -> Filter {
    Filter::Compare { column: "owner_user_id".into(), op: Compare::Ne, value: json!(actor) }
}

/// The columns of a mirrored account. The owner's flag, bank link and item are left out.
fn account_columns(row: &Value) -> BTreeMap<String, Value> {
    values(
        ["account_id", "name", "type", "subtype", "mask", "balance_cents", "iso_currency", "updated_at"]
            .iter()
            .map(|c| (*c, row[*c].clone()))
            .collect(),
    )
}

/// Split parts keep a category and an amount, nothing else.
fn parts(row: &Value) -> Value {
    let parts: Vec<Value> = row["splits"]
        .as_array()
        .map(|a| a.iter().map(|p| json!({"categoryId":p["categoryId"],"amountCents":p["amountCents"]})).collect())
        .unwrap_or_default();
    Value::Array(parts)
}

fn transaction_columns(row: &Value) -> BTreeMap<String, Value> {
    let mut out = values(
        [
            "id", "account_id", "date", "amount_cents", "iso_currency", "name", "merchant", "plaid_category", "category_id",
            "pending", "pending_transaction_id", "categorized_by", "transfer_id",
        ]
        .iter()
        .map(|c| (*c, row[*c].clone()))
        .collect(),
    );
    out.insert("splits".into(), parts(row));
    out
}

/// The mirror follows the owner's flagged accounts: rows that are missing or different are written
/// and rows that no longer belong are removed. Unflagged and removed accounts leave nothing behind.
pub fn sync_mirror<H: Host + ?Sized>(host: &H) -> Result<()> {
    let client = Client(host);
    let flagged = pages(host, ACCOUNTS, Filter::eq("shared_to_household", true), &["account_id"])?;
    let mirrored = pages(host, MIRROR_ACCOUNTS, Filter::Owned, &["account_id"])?;
    if flagged.is_empty() && mirrored.is_empty() {
        return Ok(());
    }
    let keep: Vec<&str> = flagged.iter().filter_map(|a| a["account_id"].as_str()).collect();
    for old in mirrored.iter().filter(|m| m["account_id"].as_str().is_none_or(|a| !keep.contains(&a))) {
        let id = old["account_id"].clone();
        client.query(MIRROR_TRANSACTIONS, &Query::delete(Filter::And { filters: vec![Filter::Owned, Filter::eq("account_id", id.clone())] }))?;
        client.query(MIRROR_ACCOUNTS, &Query::delete(Filter::And { filters: vec![Filter::Owned, Filter::eq("account_id", id)] }))?;
    }
    for account in &flagged {
        let id = account["account_id"].clone();
        let columns = account_columns(account);
        match mirrored.iter().find(|m| m["account_id"] == id) {
            Some(m) if account_columns(m) == columns => {}
            Some(_) => {
                client.query(MIRROR_ACCOUNTS, &Query::update(Filter::And { filters: vec![Filter::Owned, Filter::eq("account_id", id.clone())] }, columns))?;
            }
            None => {
                client.query(MIRROR_ACCOUNTS, &Query::insert(columns))?;
            }
        }
        sync_transactions(host, &id)?;
    }
    Ok(())
}

fn sync_transactions<H: Host + ?Sized>(host: &H, account: &Value) -> Result<()> {
    let client = Client(host);
    let own = pages(host, TRANSACTIONS, Filter::eq("account_id", account.clone()), &["id"])?;
    let held = pages(host, MIRROR_TRANSACTIONS, Filter::And { filters: vec![Filter::Owned, Filter::eq("account_id", account.clone())] }, &["id"])?;
    let held: BTreeMap<&str, &Value> = held.iter().filter_map(|r| Some((r["id"].as_str()?, r))).collect();
    for row in &own {
        let columns = transaction_columns(row);
        let id = row["id"].as_str().unwrap_or("");
        match held.get(id) {
            Some(m) if transaction_columns(m) == columns => {}
            Some(_) => {
                client.query(MIRROR_TRANSACTIONS, &Query::update(Filter::And { filters: vec![Filter::Owned, Filter::eq("id", id)] }, columns))?;
            }
            None => {
                client.query(MIRROR_TRANSACTIONS, &Query::insert(columns))?;
            }
        }
    }
    let live: Vec<&str> = own.iter().filter_map(|r| r["id"].as_str()).collect();
    for id in held.keys().filter(|id| !live.contains(id)) {
        client.query(MIRROR_TRANSACTIONS, &Query::delete(Filter::And { filters: vec![Filter::Owned, Filter::eq("id", *id)] }))?;
    }
    Ok(())
}

/// `finance.account.set-shared`. Shares or unshares one bank account with the household.
pub fn set_shared<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let id = ask!(input::required_string(input, "accountId", Some(256)));
    let shared = ask!(input::bool_(input, "shared"));
    let Some(account) = first(host, ACCOUNTS, Filter::eq("account_id", id.clone()))? else {
        return Ok(Err(refuse("unknown_account", "accountId is not on record")));
    };
    if shared && account["source"] == "manual" {
        return Ok(Err(refuse("manual_sharing_unavailable", "Manual accounts are private while household ledger sharing is being added")));
    }
    if (account["shared_to_household"] == true) != shared {
        Client(host).query(ACCOUNTS, &Query::update(Filter::eq("account_id", id.clone()), values(vec![("shared_to_household", json!(shared))])))?;
        log(host, "account.share", json!({"accountId":id,"shared":shared}))?;
    }
    sync_mirror(host)?;
    Ok(Ok(json!({"status":"ok","accountId":id,"shared":shared})))
}

/// Other people's shared accounts, as the household list shows them.
pub fn accounts<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>> {
    let rows = pages(host, MIRROR_ACCOUNTS, others(&actor(host)?), &["account_id", "owner_user_id"])?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "accountId": r["account_id"], "name": r["name"], "mask": r["mask"], "type": r["type"], "subtype": r["subtype"],
                "balanceCents": r["balance_cents"], "isoCurrency": r["iso_currency"], "updatedAt": r["updated_at"],
                "ownerUserId": r["owner_user_id"], "shared": true,
            })
        })
        .collect())
}

/// Other people's shared transactions dated in `[start, next)`, marked so readers can tell them
/// from the person's own rows.
pub fn month_rows<H: Host + ?Sized>(host: &H, start: &str, next: &str) -> Result<Vec<Value>> {
    let rows = window_rows(host, Some((start, next)))?;
    Ok(rows.into_iter().map(mark).collect())
}

/// Other people's shared transactions in a date window, or all of them.
pub(crate) fn window_rows<H: Host + ?Sized>(host: &H, window: Option<(&str, &str)>) -> Result<Vec<Value>> {
    let mut filters = vec![others(&actor(host)?)];
    if let Some((start, next)) = window {
        filters.push(Filter::Compare { column: "date".into(), op: Compare::Ge, value: json!(start) });
        filters.push(Filter::Compare { column: "date".into(), op: Compare::Lt, value: json!(next) });
    }
    pages(host, MIRROR_TRANSACTIONS, Filter::And { filters }, &["owner_user_id", "id"])
}

fn mark(mut row: Value) -> Value {
    row["_shared"] = json!(true);
    row
}

pub(crate) fn is_shared(row: &Value) -> bool {
    row["_shared"] == true
}

/// A shared row as a feed entry. It carries the owner and no private fields.
pub fn view(row: &Value) -> Value {
    json!({
        "id": row["id"], "accountId": row["account_id"], "date": row["date"], "amountCents": row["amount_cents"],
        "isoCurrency": row["iso_currency"], "name": row["name"], "merchant": row["merchant"],
        "plaidCategory": row["plaid_category"], "categoryId": row["category_id"], "pending": row["pending"] == true,
        "pendingTransactionId": row["pending_transaction_id"], "categorizedBy": row["categorized_by"],
        "splits": row["splits"], "transferId": row["transfer_id"], "ownerUserId": row["owner_user_id"], "shared": true,
    })
}
