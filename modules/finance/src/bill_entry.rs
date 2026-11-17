//! Recording a due bill as a manual expense and matching it to its occurrence in one save
//! (`app.finance_transactions`, `app.finance_accounts`, `app.finance_bill_occurrences`).
//!
//! The preview and the record share one set of checks. The record also replays by operation
//! identity, so repeating a save answers unchanged and a different one conflicts. The activity
//! row holds ids and the date only.
use crate::bills::{plans_of, Plan};
use crate::budget::{check, gate, read_review, stale, Book, OCCURRENCES};
use crate::budget_write::live_ids;
use crate::input::{self, is_uuid, ranged, refuse, required_string, Refusal, MAX_SAFE};
use crate::ledger::{digest, first, log_as, text, today, values, Outcome, ACCOUNTS, TRANSACTIONS};
use crate::recurrence;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};

struct Intent {
    id: String,
    plan: String,
    due: String,
    account: String,
    category: String,
    name: String,
    iso: String,
    date: String,
    cents: i64,
    cleared: bool,
}

fn intent(input: &Map<String, Value>, current: &str) -> std::result::Result<Intent, Refusal> {
    let plan = required_string(input, "planId", None)?.to_lowercase();
    let due = required_string(input, "dueDate", None)?;
    if !is_uuid(&plan) || !input::is_calendar_date(&due) {
        return Err(refuse("invalid_occurrence", "Choose a saved bill occurrence"));
    }
    let name = required_string(input, "name", Some(640))?.trim().to_owned();
    if name.is_empty() || name.chars().count() > 160 {
        return Err(input::invalid("Use the saved bill name"));
    }
    Ok(Intent {
        id: input::operation_id(input, "operationId")?,
        plan,
        due,
        account: required_string(input, "accountId", Some(128))?,
        category: required_string(input, "categoryId", Some(256))?,
        name,
        iso: input::currency(input)?,
        date: input::date(input, "date", current)?,
        cents: ranged(input, "amountCents", 1, MAX_SAFE)?,
        cleared: input::bool_(input, "cleared")?,
    })
}

struct Prepared {
    account: Value,
    category_name: Value,
    debt: bool,
    after: i64,
    planned: String,
    expected: i64,
    candidates: Vec<Value>,
}

fn prepare(book: &Book, iso: &str, plan: &Plan, i: &Intent, current: &str) -> std::result::Result<Prepared, Refusal> {
    if iso != i.iso {
        return Err(refuse("bill_entry_account", "Use the current working budget currency for bill entries"));
    }
    let mismatch = plan.account_id != i.account || plan.name != i.name || plan.iso != i.iso || plan.category_id != i.category || !plan.on_schedule(&i.due);
    if mismatch {
        return Err(refuse("invalid_occurrence", "Refresh the bill and use its saved account, category and name"));
    }
    let change = book.adjustments.iter().find(|a| a["plan_id"] == i.plan.as_str() && a["due_date"] == i.due.as_str());
    let planned = change.and_then(|a| a["planned_date"].as_str()).unwrap_or(&i.due).to_owned();
    if planned.as_str() > current {
        return Err(refuse("bill_not_due", "Record this bill only once it is due"));
    }
    if book.occurrences.iter().any(|o| o["plan_id"] == i.plan.as_str() && o["due_date"] == i.due.as_str()) {
        return Err(refuse("bill_already_reviewed", "Check this bill's existing review before recording an entry"));
    }
    let account_error = || refuse("bill_entry_account", "Choose an active manual account in the bill currency");
    let account = book.accounts.iter().find(|a| a["account_id"] == i.account.as_str()).ok_or_else(account_error)?;
    if account["source"] != "manual" || !account["archived_at"].is_null() || account["iso_currency"] != i.iso.as_str() {
        return Err(account_error());
    }
    let opening = account["opening_date"].as_str().unwrap_or("");
    if i.date.as_str() < opening || account["last_reconciled_date"].as_str().is_some_and(|l| i.date.as_str() <= l) {
        return Err(refuse("bill_entry_period", "Choose a date after the last reconciled statement and on or after opening"));
    }
    let future = book.txs.iter().any(|t| t["account_id"] == i.account.as_str() && t["date"].as_str().is_some_and(|d| d > current));
    if future || account["ledger_revision"].as_i64().is_none_or(|r| r >= MAX_SAFE) {
        return Err(refuse("bill_entry_account", "Review this account's ledger before adding an expense"));
    }
    if !live_ids(book).contains(&i.category) {
        return Err(refuse("invalid_category", "Choose a current expense category on the bill"));
    }
    let debt = matches!(account["type"].as_str(), Some("credit" | "loan"));
    let before = account["balance_cents"].as_i64().unwrap_or(0);
    let after = i128::from(before) + if debt { 1 } else { -1 } * i128::from(i.cents);
    if after.abs() > i128::from(MAX_SAFE) {
        return Err(refuse("bill_entry_overflow", "The resulting account balance exceeds supported precision"));
    }
    let (from, to) = recurrence::match_window(&i.date, &i.date);
    let candidates = book
        .txs
        .iter()
        .filter(|t| {
            t["account_id"] == i.account.as_str()
                && t["iso_currency"] == i.iso.as_str()
                && t["pending"] != true
                && t["amount_cents"].as_i64() == Some(i.cents)
                && t["date"].as_str().is_some_and(|d| d >= from.as_str() && d <= to.as_str())
                && !matches!(t["category_id"].as_str(), Some("income" | "transfers"))
        })
        .map(|t| json!({"id":t["id"],"date":t["date"],"name":t["name"],"amountCents":t["amount_cents"]}))
        .collect();
    let category_name = book.categories.iter().find(|c| c["id"] == i.category.as_str()).map_or(Value::Null, |c| c["name"].clone());
    Ok(Prepared {
        account: account.clone(),
        category_name,
        debt,
        after: after as i64,
        planned,
        expected: change.and_then(|a| a["amount_cents"].as_i64()).unwrap_or(plan.amount),
        candidates,
    })
}

/// `finance.bill.entry-preview`.
pub fn preview<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let current = today(host)?;
    let i = ask!(intent(input, &current));
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let plans = plans_of(&reviewed.book);
    let Some(plan) = plans.iter().find(|p| p.id == i.plan) else {
        return Ok(Err(refuse("invalid_occurrence", "Refresh the bill and use its saved account, category and name")));
    };
    let p = ask!(prepare(&reviewed.book, &reviewed.policy.iso, plan, &i, &current));
    Ok(Ok(json!({"status":"ok","revision":expected.revision,"fingerprint":expected.fingerprint,
        "accountName":p.account["name"],"categoryName":p.category_name,"debt":p.debt,"beforeCents":p.account["balance_cents"],
        "afterCents":p.after,"plannedDate":p.planned,"expectedCents":p.expected,"canRecord":p.candidates.is_empty(),
        "candidateCount":p.candidates.len(),"candidates":p.candidates.iter().take(20).collect::<Vec<_>>()})))
}

/// `finance.bill.entry-record`.
pub fn record<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let current = today(host)?;
    let i = ask!(intent(input, &current));
    let mut ordered = Map::new();
    for (k, v) in [("id", json!(i.id)), ("planId", json!(i.plan)), ("dueDate", json!(i.due)), ("accountId", json!(i.account)),
        ("categoryId", json!(i.category)), ("name", json!(i.name)), ("isoCurrency", json!(i.iso)), ("date", json!(i.date)),
        ("amountCents", json!(i.cents)), ("cleared", json!(i.cleared))] {
        ordered.insert(k.into(), v);
    }
    let hash = digest(&ordered)?;
    if let Some(prior) = first(host, TRANSACTIONS, Filter::eq("id", i.id.as_str()))? {
        let matched = first(host, OCCURRENCES, Filter::And { filters: vec![
            Filter::eq("plan_id", i.plan.as_str()), Filter::eq("due_date", i.due.as_str()),
            Filter::eq("state", "matched"), Filter::eq("transaction_id", i.id.as_str())] })?;
        let exact = prior["source"] == "manual" && prior["entry_digest"] == json!(hash) && prior["pending"] != true
            && prior["amount_cents"].as_i64().is_some_and(|a| a > 0)
            && !matches!(prior["category_id"].as_str(), Some("income" | "transfers"))
            && matched.is_some()
            && first(host, ACCOUNTS, Filter::eq("account_id", prior["account_id"].as_str().unwrap_or("")))?.is_some();
        return Ok(if exact {
            Ok(json!({"status":"ok","id":i.id,"unchanged":true}))
        } else {
            Err(refuse("bill_entry_conflict", "Check the saved entry and bill match before starting another operation"))
        });
    }
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let plans = plans_of(&reviewed.book);
    let Some(plan) = plans.iter().find(|p| p.id == i.plan) else {
        return Ok(Err(refuse("invalid_occurrence", "Refresh the bill and use its saved account, category and name")));
    };
    let p = ask!(prepare(&reviewed.book, &reviewed.policy.iso, plan, &i, &current));
    if !p.candidates.is_empty() {
        return Ok(Err(refuse("bill_entry_duplicate", "Review the existing posted expense before recording another")));
    }
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let at = text(host, "call", "read", "now")?;
    let revision = p.account["ledger_revision"].as_i64().unwrap_or(0);
    let changed = Client(host).query(
        ACCOUNTS,
        &Query::update(
            Filter::And { filters: vec![Filter::eq("account_id", i.account.as_str()), Filter::eq("source", "manual"), Filter::eq("ledger_revision", revision)] },
            values(vec![("balance_cents", json!(p.after)), ("ledger_revision", json!(revision + 1)), ("updated_at", json!(at))]),
        ),
    )?;
    if changed.is_empty() {
        return Err(Error::new("The account changed during the save"));
    }
    Client(host).query(TRANSACTIONS, &Query::insert(values(vec![
        ("id", json!(i.id)), ("account_id", json!(i.account)), ("date", json!(i.date)), ("name", json!(i.name)),
        ("amount_cents", json!(i.cents)), ("iso_currency", json!(i.iso)), ("category_id", json!(i.category)),
        ("notes", Value::Null), ("pending", json!(false)), ("categorized_by", json!("user")),
        ("review_state", json!("confirmed")), ("source", json!("manual")), ("entry_digest", json!(hash)), ("cleared", json!(i.cleared)),
    ])))?;
    Client(host).query(OCCURRENCES, &Query::insert(values(vec![
        ("plan_id", json!(i.plan)), ("due_date", json!(i.due)), ("state", json!("matched")),
        ("transaction_id", json!(i.id)), ("updated_at", json!(at)),
    ])))?;
    log_as(host, "user", "bill.record-entry", json!({"planId":i.plan,"dueDate":i.due,"transactionId":i.id,"accountId":i.account}), None)?;
    Ok(Ok(json!({"status":"ok","id":i.id,"unchanged":false})))
}
