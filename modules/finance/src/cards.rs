//! Credit card payment reserves (`app.finance_card_policies`, `app.finance_card_assignments`).
//!
//! A reserved card keeps cash aside for the part of its debt that came from funded envelope
//! spending. The derivation reads the posted ledger and the ordinary envelopes and never writes.
//! Activity rows hold the account id and month only.
use crate::budget::{self, check, gate, read_month, read_review, stale, Context, CARD_ASSIGNMENTS, CARD_POLICIES};
use crate::envelope::{allocations, safe, Month};
use crate::flex::{self, Policy as FlexPolicy, FLEX_POOL};
use crate::input::{self, refuse, Refusal};
use crate::ledger::{log_as, text, today, values, Outcome};
use moss_module_sdk::{
    query::{Conflict, Query},
    Client, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// One card's reserve for one month.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub account_id: String,
    pub starting_debt: i64,
    pub owed: i64,
    pub assigned: i64,
    pub funded: i64,
    pub refunds: i64,
    pub payments: i64,
    pub unfunded: i64,
    pub available: i64,
}

impl State {
    pub fn json(&self) -> Value {
        json!({"accountId":self.account_id,"startingDebtCents":self.starting_debt,"owedCents":self.owed,"assignedCents":self.assigned,
            "fundedCents":self.funded,"refundsCents":self.refunds,"paymentsCents":self.payments,"unfundedCents":self.unfunded,"availableCents":self.available})
    }
}

/// A proposed policy and assignment, applied in a preview before anything is saved.
pub struct Change {
    pub enroll: Option<(String, String)>,
    pub assignment: (String, String, i64),
}

type Failure = String;

fn positive(value: i128) -> i128 {
    value.max(0)
}

fn money(value: i128) -> std::result::Result<i64, Failure> {
    safe(value).map_err(|_| "A card amount is too large".to_owned())
}

/// Signed proportional split of `numerator` over `parts`. Ties keep input order.
pub fn allocate(parts: &[i64], numerator: i64, denominator: i64) -> std::result::Result<Vec<i64>, Failure> {
    let (n, d) = (i128::from(numerator).abs(), i128::from(denominator).abs());
    if d == 0 {
        return Ok(vec![0; parts.len()]);
    }
    if n > d {
        return Err("Card debt movement exceeds the transaction amount".into());
    }
    let raw: Vec<i128> = parts.iter().map(|p| i128::from(*p) * n).collect();
    let mut result: Vec<i128> = raw.iter().map(|r| r / d).collect();
    let mut remaining = i128::from(numerator) - result.iter().sum::<i128>();
    let mut order: Vec<(usize, i128)> = raw.iter().enumerate().map(|(i, r)| (i, r % d)).collect();
    order.sort_by(|a, b| b.1.abs().cmp(&a.1.abs()).then(a.0.cmp(&b.0)));
    for (i, remainder) in order {
        if remaining > 0 && remainder > 0 {
            result[i] += 1;
            remaining -= 1;
        } else if remaining < 0 && remainder < 0 {
            result[i] -= 1;
            remaining += 1;
        }
    }
    if remaining != 0 {
        return Err("Card allocations do not balance".into());
    }
    result.into_iter().map(money).collect()
}

pub struct Input<'a> {
    pub accounts: &'a [Value],
    /// Posted rows from budget accounts, in the budget currency, up to `through`.
    pub rows: &'a [Value],
    pub policies: &'a [(String, String)],
    pub assignments: &'a [(String, String, i64)],
    pub ordinary: &'a BTreeMap<String, Month>,
    pub flex: &'a [FlexPolicy],
    pub excluded: &'a BTreeSet<String>,
    pub through: &'a str,
}

struct Part {
    account: String,
    category: String,
    cents: i128,
}

fn text_of<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or("")
}

pub fn derive(input: &Input) -> std::result::Result<BTreeMap<String, Vec<State>>, Failure> {
    if input.policies.is_empty() {
        return Ok(input.ordinary.keys().map(|m| (m.clone(), Vec::new())).collect());
    }
    let policy_month: BTreeMap<&str, &str> = input.policies.iter().map(|(a, m)| (a.as_str(), m.as_str())).collect();
    let accounts: BTreeMap<&str, &Value> = input.accounts.iter().filter_map(|a| Some((a["account_id"].as_str()?, a))).collect();
    let mut balances: BTreeMap<String, i128> = BTreeMap::new();
    for account_id in policy_month.keys() {
        let ok = accounts.get(account_id).filter(|a| a["source"] == "manual" && a["type"] == "credit");
        let Some(opening) = ok.and_then(|a| a["opening_balance_cents"].as_i64()) else {
            return Err("Payment reserves require a manual credit card with an opening balance".into());
        };
        balances.insert((*account_id).to_owned(), i128::from(opening));
    }
    let mut rows: Vec<&Value> = input.rows.iter().filter(|r| r["pending"] != true && text_of(r, "date") <= input.through).collect();
    rows.sort_by(|a, b| (text_of(a, "date"), text_of(a, "id")).cmp(&(text_of(b, "date"), text_of(b, "id"))));
    let mut pairs: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    let mut by_month: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for row in &rows {
        if let Some(t) = row["transfer_id"].as_str() {
            pairs.entry(t).or_default().push(row);
        }
        by_month.entry(text_of(row, "date")[..7].to_owned()).or_default().push(row);
    }
    let months: BTreeSet<&String> = input
        .ordinary
        .keys()
        .chain(by_month.keys())
        .chain(input.assignments.iter().map(|a| &a.1))
        .collect();
    let policy_months: BTreeSet<String> = input.policies.iter().map(|p| p.1.clone()).collect();
    let months: BTreeSet<String> = months.into_iter().cloned().chain(policy_months).collect();
    let mut result = BTreeMap::new();
    let mut carry: BTreeMap<String, i128> = BTreeMap::new();
    for month in &months {
        let mut current: BTreeMap<String, State> = BTreeMap::new();
        for (account, effective) in &policy_month {
            if *effective <= month.as_str() {
                let start = positive(balances[*account]);
                current.insert((*account).to_owned(), State { account_id: (*account).to_owned(), starting_debt: money(start)?, ..State::default() });
            }
        }
        let pool = flex::for_month(input.flex, month).filter(|p| p.active);
        let mut parts: Vec<Part> = Vec::new();
        for row in by_month.get(month).into_iter().flatten() {
            let account_id = text_of(row, "account_id");
            if !policy_month.contains_key(account_id) {
                continue;
            }
            let account = accounts[account_id];
            let opening = account["opening_date"].as_str();
            if row["iso_currency"] != account["iso_currency"] || opening.is_some_and(|o| text_of(row, "date") < o) {
                return Err("Repair the card ledger currency or opening date before reserving payment cash".into());
            }
            let amount = i128::from(row["amount_cents"].as_i64().unwrap_or(0));
            let before = balances[account_id];
            let after = before + amount;
            money(after)?;
            balances.insert(account_id.to_owned(), after);
            let Some(state) = current.get_mut(account_id) else { continue };
            if input.excluded.contains(text_of(row, "id")) {
                let pair = row["transfer_id"].as_str().and_then(|t| pairs.get(t));
                let sound = pair.is_some_and(|p| {
                    p.len() == 2
                        && p[0]["account_id"] != p[1]["account_id"]
                        && p.iter().all(|r| {
                            crate::transactions::splits_of(r).is_empty() && r["iso_currency"] == row["iso_currency"] && r["date"] == row["date"] && r["source"] == "manual"
                        })
                        && p[0]["amount_cents"].as_i64().unwrap_or(0) + p[1]["amount_cents"].as_i64().unwrap_or(0) == 0
                });
                if !sound {
                    return Err("Repair unlinked card transfers before using payment reserves".into());
                }
                state.payments = money(i128::from(state.payments) - amount)?;
                continue;
            }
            let split = allocations(&budget::row_of(row));
            let cents: Vec<i64> = split.iter().map(|p| p.1).collect();
            let debt = allocate(&cents, money(positive(after) - positive(before))?, money(amount)?)?;
            for (index, (category, _)) in split.iter().enumerate() {
                let Some(id) = category.as_deref().filter(|c| *c != "income" && *c != "transfers") else { continue };
                let category = if pool.is_some_and(|p| p.flex_ids.iter().any(|f| f == id)) { FLEX_POOL } else { id };
                parts.push(Part { account: account_id.to_owned(), category: category.to_owned(), cents: i128::from(debt[index]) });
            }
        }
        let mut groups: BTreeMap<&str, Vec<&Part>> = BTreeMap::new();
        for part in &parts {
            groups.entry(part.category.as_str()).or_default().push(part);
            if part.cents < 0 {
                let card = current.get_mut(&part.account).ok_or("Card state missing")?;
                card.refunds = money(i128::from(card.refunds) + part.cents)?;
            }
        }
        for (id, group) in groups {
            let ordinary = input.ordinary.get(month).and_then(|m| m.categories.get(id));
            let charges: Vec<&&Part> = group.iter().filter(|p| p.cents > 0).collect();
            let total: i128 = charges.iter().map(|p| p.cents).sum();
            let debt: i128 = group.iter().map(|p| p.cents).sum();
            let refunds = debt - total;
            let activity = i128::from(ordinary.map_or(0, |o| o.activity));
            let budget_cents = i128::from(ordinary.map_or(0, |o| o.available)) + activity;
            let capacity = positive(budget_cents - (activity - debt) - refunds);
            let funded = capacity.min(total);
            let mut shares: Vec<i128> = charges.iter().map(|p| if total > 0 { p.cents * funded / total } else { 0 }).collect();
            let mut remainder = funded - shares.iter().sum::<i128>();
            let mut order: Vec<(usize, i128)> = charges.iter().enumerate().map(|(i, p)| (i, if total > 0 { p.cents * funded % total } else { 0 })).collect();
            order.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            for (i, _) in order {
                if remainder > 0 {
                    shares[i] += 1;
                    remainder -= 1;
                }
            }
            for (i, part) in charges.iter().enumerate() {
                let card = current.get_mut(&part.account).ok_or("Card state missing")?;
                card.funded = money(i128::from(card.funded) + shares[i])?;
                card.unfunded = money(i128::from(card.unfunded) + part.cents - shares[i])?;
            }
        }
        for card in current.values_mut() {
            card.owed = money(positive(balances[&card.account_id]))?;
            let assigned: i128 = input.assignments.iter().filter(|a| a.0 == card.account_id && a.1 == *month).map(|a| i128::from(a.2)).sum();
            card.assigned = money(assigned)?;
            let available = carry.get(&card.account_id).copied().unwrap_or(0) + assigned + i128::from(card.funded) + i128::from(card.refunds) - i128::from(card.payments);
            card.available = money(available)?;
            carry.insert(card.account_id.clone(), positive(available));
        }
        result.insert(month.clone(), current.into_values().collect());
    }
    Ok(result)
}

/// Ready money once reserves are set aside. Reserved cards count only their positive balance,
/// and every reserve and its unfunded debt comes off the total.
pub fn ready(accounts: &[(String, i128)], ordinary: &Month, cards: &[State], future_reserved: i64) -> std::result::Result<i64, Failure> {
    let selected: BTreeSet<&str> = cards.iter().map(|c| c.account_id.as_str()).collect();
    let mut ready = -i128::from(future_reserved);
    for (id, signed) in accounts {
        ready += if selected.contains(id.as_str()) { positive(*signed) } else { *signed };
    }
    for (id, category) in &ordinary.categories {
        if crate::envelope::is_envelope(id) {
            ready -= i128::from(category.available);
        }
    }
    for card in cards {
        ready -= i128::from(card.available) + i128::from(card.unfunded);
    }
    money(ready)
}

pub fn card_error(message: &str) -> Refusal {
    refuse("card_ledger_review_required", message.to_owned())
}

struct Plan {
    before: Context,
    change: Change,
    view: Value,
}

fn prepare<H: Host + ?Sized>(host: &H, reviewed: &budget::Reviewed, input: &Map<String, Value>) -> Result<std::result::Result<Plan, Refusal>> {
    let month = ask!(read_month(input));
    let date = today(host)?;
    if month != date[..7] {
        return Ok(Err(refuse("current_month_required", "Review card-payment cash in the current month; past months are preserved")));
    }
    let account_id = ask!(input::required_string(input, "accountId", Some(160)));
    let action = ask!(input::required_string(input, "action", None));
    if action != "enroll" && action != "fund" {
        return Ok(Err(input::invalid("action must be one of enroll, fund")));
    }
    let cents = ask!(input::ranged(input, "availableCents", 0, input::MAX_SAFE));
    let book = &reviewed.book;
    let iso = &reviewed.policy.iso;
    let account = book.accounts.iter().find(|a| a["account_id"] == account_id.as_str());
    let before = budget::context(host, book, iso, &month, &date)?;
    if let Some(message) = &before.card_error {
        return Ok(Err(card_error(message)));
    }
    let Some(ready_before) = before.ready else {
        return Ok(Err(input::invalid("Review your budget currency and account balances first")));
    };
    let Some(account) = account.filter(|a| a["source"] == "manual" && a["type"] == "credit" && a["iso_currency"] == iso.as_str()) else {
        return Ok(Err(input::invalid("Choose an owned manual credit card in the budget currency")));
    };
    let closed = !account["archived_at"].is_null();
    let existing = before.cards.iter().find(|c| c.account_id == account_id);
    if action == "enroll" && (existing.is_some() || closed) {
        return Ok(Err(input::invalid("This card is already enrolled or closed; refresh Budget")));
    }
    if action == "fund" && existing.is_none() {
        return Ok(Err(input::invalid("Set up payment reserves for this card first")));
    }
    let assigned = match existing {
        None => cents,
        Some(e) => ask!(safe(i128::from(e.assigned) + i128::from(cents) - i128::from(e.available)).map_err(|_| input::invalid("Amount exceeds supported precision"))),
    };
    if closed && existing.is_some_and(|e| cents > e.available) {
        return Ok(Err(input::invalid("Release excess cash from a closed card; reopen it before increasing reserves")));
    }
    let change = Change { enroll: (action == "enroll").then(|| (account_id.clone(), month.clone())), assignment: (account_id.clone(), month.clone(), assigned) };
    let after = budget::context_full(host, book, iso, &month, &date, None, Some(&change))?;
    if let Some(message) = &after.card_error {
        return Ok(Err(card_error(message)));
    }
    let Some(ready_after) = after.ready else { return Ok(Err(stale())) };
    if ready_after < ready_before.min(0) {
        return Ok(Err(refuse("insufficient_ready", "Choose less payment cash or release other assignments before saving")));
    }
    let payment = after.cards.iter().find(|c| c.account_id == account_id).map(State::json).unwrap_or(Value::Null);
    let effective = book
        .card_policies
        .iter()
        .find(|p| p["account_id"] == account_id.as_str())
        .and_then(|p| p["effective_month"].as_str().map(str::to_owned))
        .unwrap_or_else(|| month.clone());
    let view = json!({
        "status":"ok","month":month,"accountId":account_id,"action":action,"isoCurrency":iso,"revision":reviewed.policy.revision,
        "fingerprint":reviewed.fingerprint,"readyBeforeCents":ready_before,"readyAfterCents":ready_after,"payment":payment,"effectiveMonth":effective,
    });
    Ok(Ok(Plan { before, change, view }))
}

/// `finance.card-reserve.preview`.
pub fn preview<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let reviewed = ask!(budget::current(host)?);
    Ok(prepare(host, &reviewed, input)?.map(|p| p.view))
}

/// `finance.card-reserve.save`.
pub fn save<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let plan = ask!(prepare(host, &reviewed, input)?);
    let _ = &plan.before;
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let now = text(host, "call", "read", "now")?;
    let (account, month, cents) = &plan.change.assignment;
    if let Some((policy_account, effective)) = &plan.change.enroll {
        Client(host).query(CARD_POLICIES, &Query::insert(values(vec![("account_id", json!(policy_account)), ("effective_month", json!(effective)), ("created_at", json!(now))])))?;
    }
    let mut upsert = Query::insert(values(vec![("account_id", json!(account)), ("month", json!(month)), ("assigned_cents", json!(cents))]));
    upsert.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "account_id".into(), "month".into()],
        values: values(vec![("assigned_cents", json!(cents))]),
    };
    Client(host).query(CARD_ASSIGNMENTS, &upsert)?;
    let kind = if plan.change.enroll.is_some() { "card.enroll" } else { "card.cash-set" };
    log_as(host, "user", kind, json!({"accountId":account,"month":month}), None)?;
    Ok(Ok(json!({"status":"ok","accountId":account,"month":month})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::Cat;

    #[test]
    fn allocation_splits_a_debt_change_and_always_balances() {
        assert_eq!(allocate(&[300, 200], 250, 500).unwrap(), vec![150, 100]);
        assert_eq!(allocate(&[1, 1, 1], 2, 3).unwrap().iter().sum::<i64>(), 2);
        assert_eq!(allocate(&[1, 1, 1], 2, 3).unwrap(), vec![1, 1, 0]);
        assert_eq!(allocate(&[5], 0, 0).unwrap(), vec![0]);
        assert!(allocate(&[5], 9, 5).is_err());
        // A refund splits the same way, with the opposite sign.
        assert_eq!(allocate(&[-300, -200], -250, -500).unwrap(), vec![-150, -100]);
    }

    fn row(id: &str, account: &str, date: &str, amount: i64, category: &str) -> Value {
        json!({"id":id,"account_id":account,"date":date,"amount_cents":amount,"iso_currency":"USD","category_id":category,"pending":false,"transfer_id":null,"splits":null,"source":"manual"})
    }
    fn card() -> Value {
        json!({"account_id":"card","source":"manual","type":"credit","iso_currency":"USD","opening_balance_cents":0,"opening_date":"2026-01-01"})
    }
    fn month(entries: &[(&str, i64, i64)]) -> Month {
        Month { tbb: 0, categories: entries.iter().map(|(id, assigned, activity)| ((*id).to_owned(), Cat { assigned: *assigned, activity: *activity, available: assigned - activity })).collect() }
    }

    #[test]
    fn funded_spending_is_reserved_and_unfunded_spending_is_not() {
        let accounts = vec![card()];
        let rows = vec![row("a", "card", "2026-11-03", 6_000, "groceries")];
        let ordinary = BTreeMap::from([("2026-11".to_owned(), month(&[("groceries", 4_000, 6_000)]))]);
        let policies = vec![("card".to_owned(), "2026-11".to_owned())];
        let assignments = vec![("card".to_owned(), "2026-11".to_owned(), 500)];
        let out = derive(&Input { accounts: &accounts, rows: &rows, policies: &policies, assignments: &assignments, ordinary: &ordinary, flex: &[], excluded: &BTreeSet::new(), through: "2026-11-30" }).unwrap();
        let card = &out["2026-11"][0];
        // The envelope held 4000 before the 6000 charge, so only 4000 of it is funded.
        assert_eq!((card.owed, card.funded, card.unfunded, card.assigned, card.available), (6_000, 4_000, 2_000, 500, 4_500));
    }

    #[test]
    fn a_card_without_an_opening_balance_is_refused() {
        let accounts = vec![json!({"account_id":"card","source":"manual","type":"credit","iso_currency":"USD"})];
        let ordinary = BTreeMap::new();
        let policies = vec![("card".to_owned(), "2026-11".to_owned())];
        let err = derive(&Input { accounts: &accounts, rows: &[], policies: &policies, assignments: &[], ordinary: &ordinary, flex: &[], excluded: &BTreeSet::new(), through: "2026-11-30" });
        assert!(err.is_err());
    }

    #[test]
    fn ready_money_counts_reserved_cards_by_their_positive_balance_only() {
        let ordinary = month(&[("groceries", 1_000, 0)]);
        let cards = vec![State { account_id: "card".into(), available: 300, unfunded: 200, ..State::default() }];
        // Checking holds 10000. The card owes 700, so its signed balance is -700 and counts as 0.
        let accounts = vec![("checking".to_owned(), 10_000), ("card".to_owned(), -700)];
        assert_eq!(ready(&accounts, &ordinary, &cards, 100).unwrap(), 10_000 - 100 - 1_000 - 300 - 200);
        assert_eq!(ready(&accounts, &ordinary, &[], 0).unwrap(), 10_000 - 700 - 1_000);
    }
}
