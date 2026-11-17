//! Assistant tools. The host enforces the account's approval policy before a write tool arrives.
use crate::transactions::Merchant;
use crate::{accounts, bill_adjust, bill_entry, bill_suggest, bills, budget, budget_write, categories, connect, csv_import, cards, draft, flex, input::Refusal, ledger, rules, sort_run, splits, sync, targets, transactions};
use moss_module_sdk::{Error, Host, Response, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub tool: String,
    #[serde(default)]
    pub parameters: Value,
}

/// A refusal leaves as plain data holding a code and a fixed message, never the request text.
pub fn refusal(refusal: &Refusal) -> Value {
    json!({"status":"error","code":refusal.code,"message":refusal.message})
}
pub fn status(refusal: &Refusal) -> u16 {
    status_code(refusal.code)
}
fn status_code(code: &str) -> u16 {
    match code {
        "manual_conflict" | "manual_reconciled_period" | "stale_import" | "stale_transaction" | "stale_transactions"
        | "stale_rules" | "stale_budget" | "stale_previous" | "duplicate_name" | "split_transaction" | "linked_transfer" | "amount_mismatch"
        | "new_merchant" | "merchant_seen" | "bill_entry_conflict" | "bill_entry_duplicate" | "bill_already_reviewed"
        | "stale_target_guidance" | "flex_member" | "flex_active" | "flex_target" | "future_assignments" | "open_draft" | "insufficient_ready" => 409,
        "manual_unavailable" | "not_found" => 404,
        "bank_unavailable" => 502,
        _ => 400,
    }
}
/// The HTTP status for a refusal body made by `refusal`.
pub fn status_of(body: &Value) -> u16 {
    status_code(body["code"].as_str().unwrap_or(""))
}
fn settle(outcome: ledger::Outcome) -> Value {
    outcome.unwrap_or_else(|r| refusal(&r))
}

pub fn execute<H: Host + ?Sized>(host: &H, request: Request) -> Result<Value> {
    match request.tool.as_str() {
        "finance.accounts.list" => accounts::list(host),
        "finance.manual.context" => accounts::context(host),
        "finance.manual.account-create" => Ok(settle(ledger::create_account(host, &request.parameters)?)),
        "finance.manual.entry-create" => Ok(settle(ledger::create_entry(host, &request.parameters)?)),
        "finance.connect.start" => Ok(settle(connect::start(host)?)),
        "finance.connect.poll" => connect::poll(host, false),
        "finance.sync.run-now" => sync::run(host),
        "finance.transactions.query" => Ok(settle(transactions::query(host, &request.parameters)?)),
        "finance.transactions.categorize" => Ok(settle(transactions::categorize(host, &request.parameters, Merchant::Seen)?)),
        "finance.transactions.categorize-new" => Ok(settle(transactions::categorize(host, &request.parameters, Merchant::New)?)),
        "finance.transactions.category-set" => Ok(settle(transactions::set_category(host, &request.parameters)?)),
        "finance.transactions.review-apply" => Ok(settle(transactions::review_apply(host, &request.parameters)?)),
        "finance.transactions.bulk-categorize" => Ok(settle(transactions::bulk_categorize(host, &request.parameters)?)),
        "finance.transactions.bulk-confirm" => Ok(settle(transactions::bulk_confirm(host, &request.parameters)?)),
        "finance.transactions.notes.read" => Ok(settle(transactions::notes_read(host, &request.parameters)?)),
        "finance.transactions.notes.save" => Ok(settle(transactions::notes_save(host, &request.parameters)?)),
        "finance.transactions.splits" => Ok(settle(splits::apply(host, &request.parameters)?)),
        "finance.rule.set" => Ok(settle(rules::set(host, &request.parameters)?)),
        "finance.rules.list" => Ok(settle(rules::list(host, &request.parameters)?)),
        "finance.rules.preview" => Ok(settle(rules::preview(host, &request.parameters)?)),
        "finance.rules.update" => Ok(settle(rules::update(host, &request.parameters)?)),
        "finance.categories.upsert" => Ok(settle(categories::upsert(host, &request.parameters)?)),
        "finance.import.parse" => Ok(settle(csv_import::parse_file(&request.parameters))),
        "finance.import.preview" => Ok(settle(csv_import::preview(host, &request.parameters)?)),
        "finance.import.apply" => Ok(settle(csv_import::apply(host, &request.parameters)?)),
        "finance.sorting.run" => Ok(settle(sort_run::run(host)?)),
        "finance.budget.status" => Ok(settle(budget::status(host, &request.parameters)?)),
        "finance.budget.configure" => Ok(settle(budget_write::configure(host, &request.parameters)?)),
        "finance.budget.assign" => Ok(settle(budget_write::assign(host, &request.parameters)?)),
        "finance.budget.move" => Ok(settle(budget_write::move_money(host, &request.parameters)?)),
        "finance.budget.apply" => Ok(settle(budget_write::apply(host, &request.parameters)?)),
        "finance.budget.draft.build" => Ok(settle(draft::build(host)?)),
        "finance.budget.draft.get" => Ok(settle(draft::get(host)?)),
        "finance.budget.draft.update" => Ok(settle(draft::update(host, &request.parameters)?)),
        "finance.budget.draft.start" => Ok(settle(draft::start(host, &request.parameters)?)),
        "finance.bills.read" => Ok(settle(bills::read(host, &request.parameters)?)),
        "finance.bills.suggestions" => Ok(settle(bill_suggest::read(host, &request.parameters)?)),
        "finance.bills.suggestions.dismiss" => Ok(settle(bill_suggest::dismiss(host, &request.parameters)?)),
        "finance.bill.create" => Ok(settle(bills::create(host, &request.parameters)?)),
        "finance.bill.decide" => Ok(settle(bills::decide(host, &request.parameters)?)),
        "finance.bill.stop" => Ok(settle(bills::stop(host, &request.parameters)?)),
        "finance.bill.clear" => Ok(settle(bills::clear(host, &request.parameters)?)),
        "finance.bill.adjust" => Ok(settle(bill_adjust::save(host, &request.parameters)?)),
        "finance.bill.adjust-reset" => Ok(settle(bill_adjust::reset(host, &request.parameters)?)),
        "finance.bill.entry-preview" => Ok(settle(bill_entry::preview(host, &request.parameters)?)),
        "finance.bill.entry-record" => Ok(settle(bill_entry::record(host, &request.parameters)?)),
        "finance.target.set" => Ok(settle(targets::set(host, &request.parameters)?)),
        "finance.target.remove" => Ok(settle(targets::remove(host, &request.parameters)?)),
        "finance.targets.fund" => Ok(settle(targets::fund(host, &request.parameters)?)),
        "finance.flex.preview" => Ok(settle(flex::preview(host, &request.parameters)?)),
        "finance.flex.configure" => Ok(settle(flex::configure(host, &request.parameters)?)),
        "finance.flex.assign" => Ok(settle(flex::assign(host, &request.parameters)?)),
        "finance.card-reserve.preview" => Ok(settle(cards::preview(host, &request.parameters)?)),
        "finance.card-reserve.save" => Ok(settle(cards::save(host, &request.parameters)?)),
        _ => Err(Error::new("Unknown Finance tool")),
    }
}

/// A route answers with the outcome of the same code the tool runs.
pub fn route_write(outcome: Result<ledger::Outcome>) -> Result<Response> {
    Ok(match outcome? {
        Ok(body) => Response::new(200, body),
        Err(r) => Response::new(status(&r), refusal(&r)),
    })
}
