//! Moving or re-pricing one bill occurrence (`app.finance_bill_adjustments`).
//!
//! An adjustment is keyed by the occurrence's original due date, so the schedule never shifts.
//! The activity row holds the plan id and due date only.
use crate::bills::plans_of;
use crate::budget::{check, gate, read_review, stale, ADJUSTMENTS};
use crate::input::{self, is_uuid, ranged, refuse, required_string, Refusal};
use crate::ledger::{log_as, text, values, Outcome};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Map, Value};

fn identity(input: &Map<String, Value>) -> std::result::Result<(String, String), Refusal> {
    let bad = || refuse("invalid_occurrence", "Choose a saved scheduled bill occurrence");
    let plan = required_string(input, "planId", None)?;
    let due = required_string(input, "dueDate", None)?;
    if !is_uuid(&plan) || !input::is_calendar_date(&due) {
        return Err(bad());
    }
    Ok((plan, due))
}

/// The plan's account must be open and in the budget currency, and the occurrence undecided.
fn adjustable(book: &crate::budget::Book, iso: &str, plan: &str, due: &str) -> bool {
    let plans = plans_of(book);
    let Some(found) = plans.iter().find(|p| p.id == plan) else { return false };
    let account_open = book.accounts.iter().any(|a| a["account_id"] == found.account_id.as_str() && a["archived_at"].is_null() && a["iso_currency"] == iso && found.iso == iso);
    account_open && found.on_schedule(due) && !book.occurrences.iter().any(|o| o["plan_id"] == plan && o["due_date"] == due)
}

/// `finance.bill.adjust`.
pub fn save<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let (plan, due) = ask!(identity(input));
    let planned = ask!(required_string(input, "plannedDate", None));
    if !input::is_calendar_date(&planned) {
        return Ok(Err(refuse("invalid_date", "Choose a valid planned date")));
    }
    let cents = ask!(ranged(input, "amountCents", 1, 100_000_000));
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    if !adjustable(&reviewed.book, &reviewed.policy.iso, &plan, &due) || !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let now = text(host, "call", "read", "now")?;
    let mut upsert = Query::insert(values(vec![
        ("plan_id", json!(plan)), ("due_date", json!(due)), ("planned_date", json!(planned)),
        ("amount_cents", json!(cents)), ("updated_at", json!(now)),
    ]));
    upsert.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "plan_id".into(), "due_date".into()],
        values: values(vec![("planned_date", json!(planned)), ("amount_cents", json!(cents)), ("updated_at", json!(now))]),
    };
    Client(host).query(ADJUSTMENTS, &upsert)?;
    log_as(host, "user", "bill.adjust", json!({"planId":plan}), None)?;
    Ok(Ok(json!({"status":"ok","planId":plan,"dueDate":due})))
}

/// `finance.bill.adjust-reset`.
pub fn reset<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let (plan, due) = ask!(identity(input));
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let saved = reviewed.book.adjustments.iter().any(|a| a["plan_id"] == plan.as_str() && a["due_date"] == due.as_str());
    if !saved || !adjustable(&reviewed.book, &reviewed.policy.iso, &plan, &due) || !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let filter = Filter::And { filters: vec![Filter::eq("plan_id", plan.as_str()), Filter::eq("due_date", due.as_str())] };
    Client(host).query(ADJUSTMENTS, &Query::delete(filter))?;
    log_as(host, "user", "bill.adjust-reset", json!({"planId":plan}), None)?;
    Ok(Ok(json!({"status":"ok","planId":plan,"dueDate":due})))
}
