//! Budget reads and the review gate (`app.finance_budget_*`, `app.finance_balance_snapshots`).
//!
//! A review is the policy revision plus a fingerprint of every row the budget depends on. A write
//! must present the review it was shown. The guest compares both, then bumps the revision with an
//! update that matches only the revision it read, so two writers holding one review cannot both
//! save. The fingerprint is a change detector and never grants anything.
use crate::accounts::iso;
use crate::envelope::{self, Assignments, Month, Row};
use crate::input::{self, refuse, Refusal, CURRENCIES, MAX_SAFE};
use crate::ledger::{first, today, values, Outcome, ACCOUNTS, TRANSACTIONS};
use crate::text::{hash32, is_calendar_month, is_hash32, month_window};
use crate::transactions::splits_of;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub const POLICY: &str = "app.finance_budget_policy";
pub const ASSIGNMENTS: &str = "app.finance_budget_assignments";
pub const DRAFTS: &str = "app.finance_budget_drafts";
pub const LINES: &str = "app.finance_budget_draft_lines";
pub const CATEGORIES: &str = "app.finance_categories";
pub const SNAPSHOTS: &str = "app.finance_balance_snapshots";
pub const ITEMS: &str = "app.finance_items";
pub const TARGETS: &str = "app.finance_targets";
pub const PLANS: &str = "app.finance_bill_plans";
pub const OCCURRENCES: &str = "app.finance_bill_occurrences";
pub const ADJUSTMENTS: &str = "app.finance_bill_adjustments";
pub const FLEX: &str = "app.finance_flex_policies";
pub const CARD_POLICIES: &str = "app.finance_card_policies";
pub const CARD_ASSIGNMENTS: &str = "app.finance_card_assignments";
pub const READY_TO_ASSIGN: &str = "ready_to_assign";
pub const BOUND: i64 = 100_000_000;

pub fn stale() -> Refusal {
    refuse("stale_budget", "The budget or ledger changed. Refresh and review the amounts again before saving.")
}

/// A review the person was shown.
pub struct Review {
    pub revision: i64,
    pub fingerprint: String,
}

pub fn read_review(input: &Map<String, Value>) -> std::result::Result<Review, Refusal> {
    let revision = input::int(input, "expectedRevision")?;
    if revision < 0 {
        return Err(input::invalid("expectedRevision must be an integer from 0 to 9007199254740991"));
    }
    let fingerprint = input::required_string(input, "expectedFingerprint", None)?;
    if !is_hash32(&fingerprint) {
        return Err(input::invalid("expectedFingerprint must be 32 lowercase hex characters"));
    }
    Ok(Review { revision, fingerprint })
}

pub fn read_month(input: &Map<String, Value>) -> std::result::Result<String, Refusal> {
    let month = input::required_string(input, "month", None)?;
    if !is_calendar_month(&month) {
        return Err(input::invalid("month must be YYYY-MM"));
    }
    Ok(month)
}

pub fn amount(input: &Map<String, Value>, key: &str) -> std::result::Result<i64, Refusal> {
    let value = input::int(input, key)?;
    if value.abs() > BOUND {
        return Err(input::invalid(format!("{key} must be an integer from -{BOUND} to {BOUND}")));
    }
    Ok(value)
}

/// Every row of the person's budget data, read once per call.
pub struct Book {
    pub accounts: Vec<Value>,
    pub txs: Vec<Value>,
    pub assignments: Vec<Value>,
    pub drafts: Vec<Value>,
    pub lines: Vec<Value>,
    pub categories: Vec<Value>,
    pub snapshots: Vec<Value>,
    pub targets: Vec<Value>,
    pub plans: Vec<Value>,
    pub occurrences: Vec<Value>,
    pub adjustments: Vec<Value>,
    pub flex: Vec<Value>,
    pub card_policies: Vec<Value>,
    pub card_assignments: Vec<Value>,
}

pub(crate) fn paged<H: Host + ?Sized>(host: &H, table: &str, order: &[&str]) -> Result<Vec<Value>> {
    let client = Client(host);
    let mut out = Vec::new();
    loop {
        let mut query = Query::select(Filter::All);
        query.order = order.iter().map(|c| moss_module_sdk::query::Order { column: (*c).into(), descending: false }).collect();
        query.limit = Some(1000);
        query.offset = out.len() as u32;
        let page = client.query(table, &query)?;
        let more = page.len() == 1000;
        out.extend(page);
        if !more {
            return Ok(out);
        }
    }
}

pub fn load<H: Host + ?Sized>(host: &H) -> Result<Book> {
    Ok(Book {
        accounts: paged(host, ACCOUNTS, &["account_id"])?,
        txs: paged(host, TRANSACTIONS, &["id"])?,
        assignments: paged(host, ASSIGNMENTS, &["month", "category_id"])?,
        drafts: paged(host, DRAFTS, &["id"])?,
        lines: paged(host, LINES, &["draft_id", "category_key"])?,
        categories: paged(host, CATEGORIES, &["id"])?,
        snapshots: paged(host, SNAPSHOTS, &["account_id", "day"])?,
        targets: paged(host, TARGETS, &["category_id", "effective_month"])?,
        plans: paged(host, PLANS, &["id"])?,
        occurrences: paged(host, OCCURRENCES, &["plan_id", "due_date"])?,
        adjustments: paged(host, ADJUSTMENTS, &["plan_id", "due_date"])?,
        flex: paged(host, FLEX, &["month"])?,
        card_policies: paged(host, CARD_POLICIES, &["account_id"])?,
        card_assignments: paged(host, CARD_ASSIGNMENTS, &["account_id", "month"])?,
    })
}

/// A hash of the columns the budget reads. Notes, names and merchants are left out.
pub fn fingerprint(book: &Book) -> String {
    let pick = |rows: &[Value], columns: &[&str]| -> Vec<Vec<Value>> {
        rows.iter().map(|r| columns.iter().map(|c| r[*c].clone()).collect()).collect()
    };
    let document = json!([
        pick(&book.accounts, &["account_id", "type", "subtype", "balance_cents", "iso_currency", "source", "opening_date", "opening_balance_cents", "archived_at", "ledger_revision"]),
        pick(&book.txs, &["id", "account_id", "date", "amount_cents", "iso_currency", "category_id", "pending", "splits", "transfer_id", "review_state"]),
        pick(&book.snapshots, &["account_id", "day", "balance_cents"]),
        pick(&book.assignments, &["month", "category_id", "assigned_cents"]),
        pick(&book.drafts, &["id", "status", "basis_from", "basis_to", "monthly_income_cents"]),
        pick(&book.lines, &["draft_id", "category_key", "group_name", "category_name", "basis_monthly_cents", "proposed_cents", "adjusted_cents", "adjusted_by", "dropped"]),
        pick(&book.categories, &["id", "group_name", "name", "sort_order", "is_income", "archived_at"]),
        pick(&book.targets, &["category_id", "effective_month", "kind", "amount_cents", "due_date", "weekday"]),
        pick(&book.plans, &["id", "account_id", "category_id", "iso_currency", "amount_cents", "anchor_date", "cadence", "end_date"]),
        pick(&book.occurrences, &["plan_id", "due_date", "state", "transaction_id"]),
        pick(&book.adjustments, &["plan_id", "due_date", "planned_date", "amount_cents"]),
        pick(&book.flex, &["month", "active", "flex_ids", "non_monthly_ids"]),
        pick(&book.card_policies, &["account_id", "effective_month"]),
        pick(&book.card_assignments, &["account_id", "month", "assigned_cents"]),
    ]);
    hash32(&document.to_string())
}

pub struct Policy {
    pub iso: String,
    pub revision: i64,
}

pub fn policy_row<H: Host + ?Sized>(host: &H) -> Result<Option<Value>> {
    first(host, POLICY, Filter::All)
}

/// The working currency and revision, or the refusal that says what to do first.
pub fn require<H: Host + ?Sized>(host: &H) -> Result<std::result::Result<Policy, Refusal>> {
    let Some(row) = policy_row(host)? else {
        return Ok(Err(refuse("budget_currency_required", "Choose and review the working currency on Budget first")));
    };
    if row["taxonomy_ready"] != true {
        return Ok(Err(refuse("storage_upgrade_required", "Finish Finance category migration before budgeting")));
    }
    Ok(Ok(Policy {
        iso: row["iso_currency"].as_str().ok_or_else(|| Error::new("Invalid policy"))?.to_owned(),
        revision: row["revision"].as_i64().ok_or_else(|| Error::new("Invalid policy"))?,
    }))
}

/// The state a write is about to change, once the review it presented is confirmed current.
pub struct Reviewed {
    pub policy: Policy,
    pub book: Book,
    pub fingerprint: String,
}

pub fn check<H: Host + ?Sized>(host: &H, expected: &Review) -> Result<std::result::Result<Reviewed, Refusal>> {
    let policy = match require(host)? {
        Ok(p) => p,
        Err(r) => return Ok(Err(r)),
    };
    let book = load(host)?;
    let fingerprint = fingerprint(&book);
    if policy.revision != expected.revision || fingerprint != expected.fingerprint {
        return Ok(Err(stale()));
    }
    Ok(Ok(Reviewed { policy, book, fingerprint }))
}

/// Bumps the revision. It matches only the revision that was read, so a second writer holding the
/// same review changes nothing and must refuse before it writes a row.
pub fn gate<H: Host + ?Sized>(host: &H, reviewed: &Reviewed) -> Result<bool> {
    if reviewed.policy.revision >= MAX_SAFE {
        return Ok(false);
    }
    let changed = Client(host).query(
        POLICY,
        &Query::update(
            Filter::And {
                filters: vec![
                    Filter::eq("revision", reviewed.policy.revision),
                    Filter::eq("taxonomy_ready", true),
                ],
            },
            values(vec![("revision", json!(reviewed.policy.revision + 1))]),
        ),
    )?;
    Ok(!changed.is_empty())
}

pub fn row_of(v: &Value) -> Row {
    let payee = v["merchant"].as_str().filter(|m| !m.is_empty()).or(v["name"].as_str()).unwrap_or("").trim().to_lowercase();
    Row {
        id: v["id"].as_str().unwrap_or("").into(),
        account_id: v["account_id"].as_str().unwrap_or("").into(),
        date: v["date"].as_str().unwrap_or("").into(),
        amount: v["amount_cents"].as_i64().unwrap_or(0),
        category: v["category_id"].as_str().map(Into::into),
        splits: splits_of(v),
        linked: !v["transfer_id"].is_null(),
        payee,
    }
}

fn is_debt(kind: &str) -> bool {
    kind == "credit" || kind == "loan"
}
pub fn sign(kind: &str) -> i128 {
    if is_debt(kind) { -1 } else { 1 }
}
pub fn counts_toward_ready(account: &Value) -> bool {
    match account["type"].as_str() {
        Some("depository" | "credit") => true,
        Some("other") => account["subtype"] == "cash",
        _ => false,
    }
}
pub fn budget_account(account: &Value, currency: &str) -> bool {
    account["iso_currency"] == currency && counts_toward_ready(account)
}

/// Posted rows in the budget currency from budget accounts, dated up to `through`.
pub fn budget_rows(book: &Book, currency: &str, through: &str) -> Vec<Row> {
    let ids: BTreeSet<&str> =
        book.accounts.iter().filter(|a| budget_account(a, currency)).filter_map(|a| a["account_id"].as_str()).collect();
    book.txs
        .iter()
        .filter(|t| t["account_id"].as_str().is_some_and(|a| ids.contains(a)) && t["iso_currency"] == currency && t["pending"] != true && t["date"].as_str().is_some_and(|d| d <= through))
        .map(row_of)
        .collect()
}

pub fn ledgers(book: &Book) -> Assignments {
    let mut out = Assignments::new();
    for row in &book.assignments {
        let (Some(month), Some(id)) = (row["month"].as_str(), row["category_id"].as_str()) else { continue };
        out.entry(month.to_owned()).or_default().insert(id.to_owned(), row["assigned_cents"].as_i64().unwrap_or(0));
    }
    out
}

/// Category rows as the screen reads them: the stored group id and the table group.
pub fn category_views(book: &Book) -> Vec<Value> {
    let mut rows: Vec<&Value> = book.categories.iter().collect();
    rows.sort_by(|a, b| (a["sort_order"].as_i64(), a["id"].as_str()).cmp(&(b["sort_order"].as_i64(), b["id"].as_str())));
    rows.into_iter()
        .map(|c| {
            let table = c["group_name"].as_str().unwrap_or("Everyday");
            let legacy = match (c["id"].as_str(), table) {
                (Some("transfers"), _) => "transfers",
                (_, "Bills") => "fixed",
                (_, "Fun") => "personal",
                (_, "Savings") => "savings-goals",
                (_, "Income") => "income",
                _ => "everyday",
            };
            json!({"id":c["id"],"name":c["name"],"group":legacy,"archived":!c["archived_at"].is_null(),
                "tableGroup": if c["id"] == "transfers" { "Everyday" } else { table }})
        })
        .collect()
}

pub fn last_day(month: &str) -> String {
    let (_, next) = month_window(month);
    let year: i32 = next[..4].parse().unwrap_or(0);
    let m: u32 = next[5..7].parse().unwrap_or(1);
    let (y, m) = if m == 1 { (year - 1, 12) } else { (year, m - 1) };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m as usize - 1];
    format!("{y:04}-{m:02}-{days:02}")
}

/// Everything one month's budget screen and the move check read.
pub struct Context {
    pub month: Month,
    pub ready: Option<i64>,
    pub unavailable: Option<&'static str>,
    pub future_reserved: i64,
    pub funding: Vec<Value>,
    pub excluded_accounts: usize,
    pub pending: usize,
    pub needs_look: usize,
}

fn funding_balance(book: &Book, account: &Value, month: &str, current: &str, cutoff: &str) -> Option<(i64, Value)> {
    if month == &current[..7] {
        return Some((account["balance_cents"].as_i64()?, iso(&account["updated_at"])));
    }
    if month > &current[..7] {
        return None;
    }
    let manual = account["source"] == "manual" && !account["opening_date"].is_null() && !account["opening_balance_cents"].is_null();
    if manual {
        let id = account["account_id"].as_str()?;
        let movement: i128 = book
            .txs
            .iter()
            .filter(|t| t["account_id"] == id && t["pending"] != true && t["date"].as_str().is_some_and(|d| d <= cutoff))
            .map(|t| i128::from(t["amount_cents"].as_i64().unwrap_or(0)))
            .sum();
        let opening = i128::from(account["opening_balance_cents"].as_i64()?);
        let balance = opening - sign(account["type"].as_str().unwrap_or("")) * movement;
        return Some((envelope::safe(balance).ok()?, json!(cutoff)));
    }
    book.snapshots
        .iter()
        .filter(|s| s["account_id"] == account["account_id"] && s["day"].as_str().is_some_and(|d| d <= cutoff))
        .max_by(|a, b| a["day"].as_str().cmp(&b["day"].as_str()))
        .and_then(|s| Some((s["balance_cents"].as_i64()?, s["day"].clone())))
}

pub fn context<H: Host + ?Sized>(host: &H, book: &Book, iso: &str, month: &str, date: &str) -> Result<Context> {
    let rows = budget_rows(book, iso, date);
    let excluded = envelope::transfer_ids(&rows);
    let mut ledgers = ledgers(book);
    ledgers.entry(month.to_owned()).or_default();
    let mut months = envelope::derive(&ledgers, &rows, &excluded)?;
    let state = months.remove(month).ok_or_else(|| Error::new("Month missing"))?;

    let current = &date[..7];
    let cutoff = if month == current { date.to_owned() } else { last_day(month) };
    let funding_accounts: Vec<&Value> = book.accounts.iter().filter(|a| budget_account(a, iso)).collect();
    let (mut funding, mut missing, mut signed) = (Vec::new(), false, 0i128);
    for account in &funding_accounts {
        if account["source"] == "manual" && account["opening_date"].as_str().is_some_and(|o| o > cutoff.as_str()) {
            continue;
        }
        let kind = account["type"].as_str().unwrap_or("");
        let balance = funding_balance(book, account, month, date, &cutoff);
        let bank_stale = account["source"] != "manual"
            && match account["item_id"].as_str() {
                Some(item) => first(host, ITEMS, Filter::eq("item_id", item))?.is_none_or(|i| i["status"] != "connected"),
                None => true,
            };
        match &balance {
            Some((cents, _)) => signed += sign(kind) * i128::from(*cents),
            None => missing = true,
        }
        funding.push(json!({
            "accountId": account["account_id"], "name": account["name"], "type": account["type"], "subtype": account["subtype"],
            "isoCurrency": account["iso_currency"], "asOf": balance.as_ref().map_or(Value::Null, |b| b.1.clone()),
            "balanceCents": balance.map_or(Value::Null, |b| json!(sign(kind) as i64 * b.0)), "stale": bank_stale,
        }));
    }
    let unavailable = if month > current { Some("future_month") } else if missing { Some("missing_history") } else { None };
    let future_reserved = if month == current {
        let sum: i128 = ledgers
            .iter()
            .filter(|(m, _)| m.as_str() > month)
            .flat_map(|(_, l)| l.iter())
            .filter(|(id, _)| envelope::is_envelope(id))
            .map(|(_, c)| i128::from((*c).max(0)))
            .sum();
        envelope::safe(sum)?
    } else {
        0
    };
    let ready = match unavailable {
        Some(_) => None,
        None => Some(envelope::safe(i128::from(envelope::ready(signed, &state.categories)?) - i128::from(future_reserved))?),
    };
    let ids: BTreeSet<&str> = funding_accounts.iter().filter_map(|a| a["account_id"].as_str()).collect();
    let in_month = |t: &Value| t["date"].as_str().is_some_and(|d| d.starts_with(month));
    let pending = book.txs.iter().filter(|t| t["account_id"].as_str().is_some_and(|a| ids.contains(a)) && t["iso_currency"] == iso && t["pending"] == true && in_month(t)).count();
    let counted: BTreeSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let needs_look = book
        .txs
        .iter()
        .filter(|t| in_month(t) && t["review_state"] == "needs_look" && t["id"].as_str().is_some_and(|i| counted.contains(i)))
        .count();
    Ok(Context {
        month: state,
        ready,
        unavailable,
        future_reserved,
        funding,
        excluded_accounts: book.accounts.len() - funding_accounts.len(),
        pending,
        needs_look,
    })
}

/// `finance.budget.status`.
pub fn status<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(input));
    let date = today(host)?;
    let book = load(host)?;
    let categories = category_views(&book);
    let Some(row) = policy_row(host)? else {
        let ledgers = ledgers(&book);
        let legacy: Vec<Value> = ledgers
            .iter()
            .map(|(m, l)| json!({"month":m,"totalCents":l.values().map(|c| i128::from(*c)).sum::<i128>().to_string()}))
            .collect();
        let mut currencies: Vec<&str> = book.accounts.iter().filter_map(|a| a["iso_currency"].as_str()).collect();
        currencies.sort_unstable();
        currencies.dedup();
        let latest = book.drafts.iter().max_by_key(|d| d["created_at"].as_str().unwrap_or("").to_owned());
        return Ok(Ok(json!({
            "month": month, "legacyMonths": legacy, "legacyDraft": latest.is_some_and(|d| d["status"] == "open"),
            "setupRequired": true, "storageReady": true, "legacyMonthCount": ledgers.len(), "currencies": CURRENCIES,
            "accountCurrencies": currencies, "hasBank": !book.accounts.is_empty(), "hasBudget": !ledgers.is_empty(),
            "isoCurrency": null, "currentMonth": &date[..7], "categories": categories, "targets": [], "targetFunding": [],
            "targetFundingOverspent": false, "flexDetail": [], "flexChoices": [],
        })));
    };
    if row["taxonomy_ready"] != true {
        return Ok(Err(refuse("storage_upgrade_required", "Finish Finance category migration before budgeting")));
    }
    let iso = row["iso_currency"].as_str().unwrap_or("").to_owned();
    let revision = row["revision"].as_i64().unwrap_or(0);
    let ctx = context(host, &book, &iso, &month, &date)?;
    let computed_at = crate::ledger::text(host, "call", "read", "now")?;
    let cats: Map<String, Value> = ctx
        .month
        .categories
        .iter()
        .map(|(id, c)| (id.clone(), json!({"assignedCents":c.assigned,"activityCents":c.activity,"availableCents":c.available})))
        .collect();
    let choices: Vec<Value> = categories
        .iter()
        .filter(|c| c["archived"] == false && c["id"] != "income" && c["id"] != "transfers")
        .map(|c| json!({"id":c["id"],"name":c["name"],"group":c["group"]}))
        .collect();
    Ok(Ok(json!({
        "month": month, "setupRequired": false, "flex": null, "cardPayments": [], "cardChoices": [], "cardStorageReady": false,
        "flexDetail": [], "isoCurrency": iso, "revision": revision, "fingerprint": fingerprint(&book), "currentMonth": &date[..7],
        "hasBank": !book.accounts.is_empty(), "hasBudget": !book.assignments.is_empty(),
        "state": {"computedAt": computed_at, "tbbCents": ctx.month.tbb, "categories": cats},
        "readyToAssignCents": ctx.ready, "readyUnavailable": ctx.unavailable, "futureReservedCents": ctx.future_reserved,
        "excludedAccountCount": ctx.excluded_accounts, "pendingCount": ctx.pending, "needsLookCount": ctx.needs_look,
        "accounts": ctx.funding, "categories": categories, "targets": [], "targetFundingOverspent": false,
        "targetFunding": [], "flexChoices": choices,
    })))
}
