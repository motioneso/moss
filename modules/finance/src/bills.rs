//! Bill plans, their projected occurrences and the person's decisions on them
//! (`app.finance_bill_plans`, `app.finance_bill_occurrences`, `app.finance_bill_adjustments`).
//!
//! A write checks its review and every rule first, then bumps the revision and writes. A refusal
//! leaves every row as it was. Activity rows hold ids and dates only, never an amount or a name.
use crate::budget::{self, check, gate, load, read_review, require, stale, Book, OCCURRENCES, PLANS};
use crate::budget_write::live_ids;
use crate::input::{self, any_date, is_uuid, ranged, refuse, required_string, Refusal};
use crate::ledger::{log_as, today, values, Outcome};
use crate::recurrence::{self, Cadence, Schedule};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

pub const MAX_PLANS: usize = 500;
pub const MAX_OCCURRENCES: usize = 500;
const MAX_CENTS: i64 = 100_000_000;

#[derive(Clone)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub account_id: String,
    pub category_id: String,
    pub iso: String,
    pub amount: i64,
    pub anchor: String,
    pub cadence: Cadence,
    pub end: Option<String>,
}

impl Plan {
    pub fn schedule(&self) -> Schedule<'_> {
        Schedule { anchor: &self.anchor, cadence: self.cadence, end: self.end.as_deref() }
    }
    pub fn on_schedule(&self, due: &str) -> bool {
        recurrence::occurrences(&self.schedule(), due, due).is_some_and(|d| d.iter().any(|x| x == due))
    }
    pub fn json(&self) -> Value {
        json!({"id":self.id,"name":self.name,"accountId":self.account_id,"categoryId":self.category_id,"isoCurrency":self.iso,
            "amountCents":self.amount,"anchorDate":self.anchor,"cadence":cadence_name(self.cadence),"endDate":self.end})
    }
}

pub fn cadence_name(c: Cadence) -> &'static str {
    match c {
        Cadence::Once => "once",
        Cadence::Weekly => "weekly",
        Cadence::Fortnightly => "fortnightly",
        Cadence::Monthly => "monthly",
        Cadence::Yearly => "yearly",
    }
}

/// Saved plans in anchor-date order. A row the module cannot read is skipped.
pub fn plans_of(book: &Book) -> Vec<Plan> {
    let mut plans: Vec<Plan> = book
        .plans
        .iter()
        .filter_map(|r| {
            Some(Plan {
                id: r["id"].as_str()?.into(),
                name: r["name"].as_str()?.into(),
                account_id: r["account_id"].as_str()?.into(),
                category_id: r["category_id"].as_str()?.into(),
                iso: r["iso_currency"].as_str()?.into(),
                amount: r["amount_cents"].as_i64()?,
                anchor: r["anchor_date"].as_str()?.into(),
                cadence: Cadence::parse(r["cadence"].as_str()?)?,
                end: r["end_date"].as_str().map(Into::into),
            })
        })
        .collect();
    plans.sort_by(|a, b| (&a.anchor, &a.id).cmp(&(&b.anchor, &b.id)));
    plans
}

/// One projected occurrence of a plan.
pub struct Projection {
    pub plan_id: String,
    pub name: String,
    pub account_id: String,
    pub category_id: String,
    pub due: String,
    pub planned: String,
    pub expected: i64,
    pub adjusted: bool,
}

/// Plans with their saved one-off changes, projected over a window. None means a saved change
/// does not fit its plan, or the window holds more than 500 occurrences.
pub fn project(plans: &[Plan], adjustments: &[Value], from: &str, to: &str) -> Option<Vec<Projection>> {
    let mut changes: std::collections::BTreeMap<(&str, &str), (&str, i64)> = Default::default();
    for c in adjustments {
        let (plan_id, due, planned, cents) = (c["plan_id"].as_str()?, c["due_date"].as_str()?, c["planned_date"].as_str()?, c["amount_cents"].as_i64()?);
        let plan = plans.iter().find(|p| p.id == plan_id)?;
        if cents <= 0 || !plan.on_schedule(due) || changes.insert((plan_id, due), (planned, cents)).is_some() {
            return None;
        }
    }
    let mut out = Vec::new();
    for plan in plans {
        let mut dates: std::collections::BTreeSet<String> = recurrence::occurrences(&plan.schedule(), from, to)?.into_iter().collect();
        dates.extend(changes.keys().filter(|(p, _)| *p == plan.id).map(|(_, d)| (*d).to_owned()));
        for due in dates {
            let change = changes.get(&(plan.id.as_str(), due.as_str()));
            let planned = change.map_or(due.as_str(), |c| c.0);
            if planned < from || planned > to {
                continue;
            }
            out.push(Projection {
                plan_id: plan.id.clone(),
                name: plan.name.clone(),
                account_id: plan.account_id.clone(),
                category_id: plan.category_id.clone(),
                planned: planned.to_owned(),
                expected: change.map_or(plan.amount, |c| c.1),
                adjusted: change.is_some(),
                due,
            });
            if out.len() > MAX_OCCURRENCES {
                return None;
            }
        }
    }
    out.sort_by(|a, b| (&a.planned, &a.name, &a.due).cmp(&(&b.planned, &b.name, &b.due)));
    Some(out)
}

fn plan_id(input: &serde_json::Map<String, Value>, key: &str) -> std::result::Result<String, Refusal> {
    let value = required_string(input, key, None)?;
    if !is_uuid(&value) {
        return Err(input::invalid("A valid plan identity is required"));
    }
    Ok(value)
}

fn transaction_counts(t: &Value, plan: &Plan) -> bool {
    t["account_id"] == plan.account_id.as_str()
        && t["iso_currency"] == plan.iso.as_str()
        && t["pending"] != true
        && t["amount_cents"].as_i64().is_some_and(|a| a > 0)
        && !matches!(t["category_id"].as_str(), Some("income" | "transfers"))
}

/// `finance.bills.read`.
pub fn read<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let from = ask!(any_date(input, "from"));
    let to = ask!(any_date(input, "to"));
    if from > to || crate::envelope::day_number(&to) - crate::envelope::day_number(&from) > 366 {
        return Ok(Err(input::invalid("Choose a bill projection window of at most one year")));
    }
    let (match_from, match_to) = recurrence::match_window(&from, &to);
    if budget::policy_row(host)?.is_none() {
        return Ok(Ok(json!({"status":"ok","setupRequired":true})));
    }
    let policy = ask!(require(host)?);
    let book = load(host)?;
    let plans = plans_of(&book);
    if plans.len() > MAX_PLANS {
        return Ok(Err(input::invalid("Narrow the saved bill list before projecting more than 500 plans")));
    }
    let adjustments: Vec<Value> = book
        .adjustments
        .iter()
        .filter(|a| [&a["due_date"], &a["planned_date"]].iter().any(|d| d.as_str().is_some_and(|d| d >= from.as_str() && d <= to.as_str())))
        .cloned()
        .collect();
    let Some(projected) = project(&plans, &adjustments, &from, &to) else {
        return Ok(Err(refuse("invalid_bill_projection", "Use a shorter window or check saved bill changes before projecting this range")));
    };
    let due_extra: Vec<&str> = adjustments.iter().filter_map(|a| a["due_date"].as_str()).collect();
    let decision = |plan: &str, due: &str| {
        book.occurrences.iter().find(|o| o["plan_id"] == plan && o["due_date"] == due && {
            let d = o["due_date"].as_str().unwrap_or("");
            (d >= from.as_str() && d <= to.as_str()) || due_extra.contains(&d)
        })
    };
    let accounts: Vec<&Value> = book.accounts.iter().filter(|a| a["iso_currency"] == policy.iso.as_str()).collect();
    let live = live_ids(&book);
    let categories: Vec<Value> = budget::category_views(&book)
        .into_iter()
        .filter(|c| c["archived"] == false && c["id"] != "income" && c["id"] != "transfers")
        .map(|c| json!({"id":c["id"],"name":c["name"]}))
        .collect();
    let date = today(host)?;
    let tx_of = |id: &str| book.txs.iter().find(|t| t["id"] == id);
    let claimed: std::collections::BTreeSet<&str> = book.occurrences.iter().filter_map(|o| o["transaction_id"].as_str()).collect();
    let mut transactions: Vec<&Value> = book
        .txs
        .iter()
        .filter(|t| {
            t["date"].as_str().is_some_and(|d| d >= match_from.as_str() && d <= match_to.as_str())
                && t["pending"] != true
                && t["amount_cents"].as_i64().is_some_and(|a| a > 0)
                && t["iso_currency"] == policy.iso.as_str()
                && !matches!(t["category_id"].as_str(), Some("income" | "transfers"))
        })
        .collect();
    if transactions.len() > 1000 {
        return Ok(Err(input::invalid("Use a shorter window to review bill matches, including seven days either side")));
    }
    transactions.retain(|t| t["id"].as_str().is_some_and(|i| !claimed.contains(i)));
    let occurrences: Vec<Value> = projected
        .iter()
        .map(|o| {
            let decided = decision(&o.plan_id, &o.due);
            let account = accounts.iter().find(|a| a["account_id"] == o.account_id.as_str());
            let plan = plans.iter().find(|p| p.id == o.plan_id);
            let tx = decided.and_then(|d| d["transaction_id"].as_str()).and_then(tx_of);
            let valid = matches!((tx, plan), (Some(t), Some(p)) if transaction_counts(t, p));
            let state = match decided.map(|d| d["state"].as_str().unwrap_or("")) {
                Some("matched") if valid => "posted",
                Some("matched") => "review",
                Some(other) => other,
                None => "projected",
            };
            let open = account.is_some_and(|a| a["archived_at"].is_null()) && decided.is_none();
            json!({"planId":o.plan_id,"name":o.name,"accountId":o.account_id,"categoryId":o.category_id,"dueDate":o.due,
                "plannedDate":o.planned,"expectedCents":o.expected,"adjusted":o.adjusted,"canAdjust":open,
                "canRecordEntry": open && account.is_some_and(|a| a["source"] == "manual") && o.planned <= date && live.contains(&o.category_id),
                "state":state,"actualCents":tx.map(|t| t["amount_cents"].clone()),"transactionId":decided.map(|d| d["transaction_id"].clone())})
        })
        .collect();
    Ok(Ok(json!({"status":"ok","today":date,"matchFrom":match_from,"matchTo":match_to,"isoCurrency":policy.iso,
        "revision":policy.revision,"fingerprint":budget::fingerprint(&book),"plans":plans.iter().map(Plan::json).collect::<Vec<_>>(),
        "occurrences":occurrences,"supportsAdjustments":true,
        "accounts":accounts.iter().map(|a| json!({"accountId":a["account_id"],"name":a["name"]})).collect::<Vec<_>>(),
        "categories":categories,
        "transactions":transactions.iter().map(|t| json!({"id":t["id"],"accountId":t["account_id"],"date":t["date"],"name":t["name"],"amountCents":t["amount_cents"]})).collect::<Vec<_>>()})))
}

/// `finance.bill.create`.
pub fn create<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let id = ask!(plan_id(input, "id"));
    let name = ask!(required_string(input, "name", Some(640))).trim().to_owned();
    if name.is_empty() || name.chars().count() > 160 {
        return Ok(Err(input::invalid("Use a bill name between 1 and 160 characters")));
    }
    let account = ask!(required_string(input, "accountId", None));
    let category = ask!(required_string(input, "categoryId", None));
    let cents = ask!(ranged(input, "amountCents", 1, MAX_CENTS));
    let anchor = ask!(any_date(input, "anchorDate"));
    let cadence = ask!(required_string(input, "cadence", None));
    let Some(cadence) = Cadence::parse(&cadence) else {
        return Ok(Err(input::invalid("cadence must be one of once, weekly, fortnightly, monthly, yearly")));
    };
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    if reviewed.book.plans.len() >= MAX_PLANS {
        return Ok(Err(input::invalid("No more than 500 bill plans are supported")));
    }
    let iso = reviewed.policy.iso.clone();
    let account_ok = reviewed.book.accounts.iter().any(|a| a["account_id"] == account.as_str() && a["iso_currency"] == iso.as_str() && a["archived_at"].is_null());
    let fresh = !reviewed.book.plans.iter().any(|p| p["id"] == id.as_str());
    if !fresh || !account_ok || !live_ids(&reviewed.book).contains(&category) {
        return Ok(Err(stale()));
    }
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let now = crate::ledger::text(host, "call", "read", "now")?;
    Client(host).query(
        PLANS,
        &Query::insert(values(vec![
            ("id", json!(id)), ("name", json!(name)), ("account_id", json!(account)), ("category_id", json!(category)),
            ("iso_currency", json!(iso)), ("amount_cents", json!(cents)), ("anchor_date", json!(anchor)),
            ("cadence", json!(cadence_name(cadence))), ("created_at", json!(now)),
        ])),
    )?;
    log_as(host, "user", "bill.create", json!({"planId":id}), None)?;
    Ok(Ok(json!({"status":"ok","id":id})))
}

/// `finance.bill.decide`. Marks one occurrence skipped, or matched to one posted transaction.
pub fn decide<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let plan = ask!(plan_id(input, "planId"));
    let due = ask!(any_date(input, "dueDate"));
    let state = ask!(required_string(input, "state", None));
    if state != "skipped" && state != "matched" {
        return Ok(Err(input::invalid("state must be one of skipped, matched")));
    }
    let transaction = ask!(input::string(input, "transactionId", false, None));
    if (state == "matched") != transaction.as_deref().is_some_and(|t| !t.is_empty()) {
        return Ok(Err(input::invalid("Choose one posted transaction for a match, or skip without a transaction")));
    }
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let plans = plans_of(&reviewed.book);
    let Some(found) = plans.iter().find(|p| p.id == plan) else {
        return Ok(Err(input::invalid("Choose an occurrence in this bill's schedule")));
    };
    if !found.on_schedule(&due) {
        return Ok(Err(input::invalid("Choose an occurrence in this bill's schedule")));
    }
    let tx_ok = transaction.as_ref().is_none_or(|id| reviewed.book.txs.iter().any(|t| t["id"] == id.as_str() && transaction_counts(t, found)));
    let taken = reviewed.book.occurrences.iter().any(|o| (o["plan_id"] == plan.as_str() && o["due_date"] == due.as_str()) || (transaction.is_some() && o["transaction_id"].as_str() == transaction.as_deref()));
    if !tx_ok || taken || !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let now = crate::ledger::text(host, "call", "read", "now")?;
    Client(host).query(
        OCCURRENCES,
        &Query::insert(values(vec![
            ("plan_id", json!(plan)), ("due_date", json!(due)), ("state", json!(state)),
            ("transaction_id", json!(transaction)), ("updated_at", json!(now)),
        ])),
    )?;
    log_as(host, "user", "bill.decide", json!({"planId":plan,"state":state}), None)?;
    Ok(Ok(json!({"status":"ok","planId":plan,"dueDate":due})))
}

/// `finance.bill.stop`. Ends a plan on a date, keeping every earlier occurrence.
pub fn stop<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let id = ask!(plan_id(input, "id"));
    let end = ask!(any_date(input, "endDate"));
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let book = &reviewed.book;
    let later = |rows: &[Value], columns: &[&str]| rows.iter().any(|r| r["plan_id"] == id.as_str() && columns.iter().any(|c| r[*c].as_str().is_some_and(|d| d > end.as_str())));
    let shortens = book.plans.iter().any(|p| p["id"] == id.as_str() && p["end_date"].as_str().is_none_or(|e| end.as_str() < e));
    if !shortens || later(&book.occurrences, &["due_date"]) || later(&book.adjustments, &["due_date", "planned_date"]) || !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    Client(host).query(PLANS, &Query::update(Filter::eq("id", id.as_str()), values(vec![("end_date", json!(end))])))?;
    log_as(host, "user", "bill.stop", json!({"planId":id}), None)?;
    Ok(Ok(json!({"status":"ok","id":id})))
}

/// `finance.bill.clear`. Removes a decision so the occurrence is projected again.
pub fn clear<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let plan = ask!(plan_id(input, "planId"));
    let due = ask!(any_date(input, "dueDate"));
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let held = reviewed.book.occurrences.iter().any(|o| o["plan_id"] == plan.as_str() && o["due_date"] == due.as_str());
    if !held || !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let filter = Filter::And { filters: vec![Filter::eq("plan_id", plan.as_str()), Filter::eq("due_date", due.as_str())] };
    Client(host).query(OCCURRENCES, &Query::delete(filter))?;
    log_as(host, "user", "bill.clear", json!({"planId":plan}), None)?;
    Ok(Ok(json!({"status":"ok","planId":plan,"dueDate":due})))
}
