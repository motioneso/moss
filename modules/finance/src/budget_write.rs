//! Budget writes: configure, assign, move and apply (`app.finance_budget_*`).
//!
//! Every write checks its review first, then every other rule, and only then bumps the revision
//! and writes. A refusal therefore leaves every row as it was. A host failure after the first
//! write ends the invocation, and the host rolls the whole transaction back.
//!
//! Activity rows hold the month and category ids only. They carry no amounts.
use crate::budget::{self, amount, check, gate, ledgers, read_month, read_review, stale, ASSIGNMENTS, BOUND, CATEGORIES, DRAFTS, POLICY, READY_TO_ASSIGN};
use crate::input::{self, refuse, Refusal};
use crate::ledger::{log_as, text, today, values, Outcome};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub const MAX_BATCH: usize = 20;

/// The 16 categories every new budget starts with: id, table group, name.
pub const SEED: [(&str, &str, &str); 16] = [
    ("rent-mortgage", "Bills", "Rent & mortgage"),
    ("utilities", "Bills", "Utilities"),
    ("insurance", "Bills", "Insurance"),
    ("subscriptions", "Bills", "Subscriptions & services"),
    ("groceries", "Everyday", "Groceries"),
    ("dining", "Everyday", "Dining & coffee"),
    ("transport", "Everyday", "Transport"),
    ("shopping", "Everyday", "Shopping"),
    ("fuel", "Everyday", "Fuel"),
    ("entertainment", "Fun", "Entertainment"),
    ("health", "Fun", "Health"),
    ("personal-care", "Fun", "Personal care"),
    ("travel", "Fun", "Travel"),
    ("savings", "Savings", "Savings"),
    ("income", "Income", "Income"),
    ("transfers", "Everyday", "Transfers"),
];

/// `finance.budget.configure`. Chooses the working currency once and starts the saved category list.
pub fn configure<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let currency = ask!(input::currency(input));
    let acknowledge = ask!(input::bool_(input, "acknowledgeLegacy"));
    if let Some(row) = budget::policy_row(host)? {
        return Ok(if row["iso_currency"] == json!(currency) {
            Ok(json!({"status":"ok","isoCurrency":currency,"unchanged":true}))
        } else {
            Err(refuse("budget_currency_fixed", "A working currency is already selected; refresh Budget"))
        });
    }
    let client = Client(host);
    let book = budget::load(host)?;
    let open_draft = book.drafts.iter().any(|d| d["status"] == "open");
    if !acknowledge && (!book.assignments.is_empty() || open_draft) {
        return Ok(Err(refuse("legacy_review_required", "Review how your existing assignment amounts will be interpreted")));
    }
    let at = text(host, "call", "read", "now")?;
    let mut insert = Query::insert(values(vec![
        ("iso_currency", json!(currency)),
        ("created_at", json!(at)),
        ("revision", json!(0)),
        ("taxonomy_ready", json!(true)),
    ]));
    insert.conflict = Conflict::Ignore;
    if client.query(POLICY, &insert)?.is_empty() {
        return Err(Error::new("The budget policy changed during the save"));
    }
    // Categories outside the seed list stay for history but are archived.
    let seeded: BTreeSet<&str> = SEED.iter().map(|s| s.0).collect();
    let stray: Vec<Value> = book
        .categories
        .iter()
        .filter(|c| c["archived_at"].is_null() && c["id"].as_str().is_some_and(|i| !seeded.contains(i)))
        .map(|c| c["id"].clone())
        .collect();
    if !stray.is_empty() {
        client.query(
            CATEGORIES,
            &Query::update(Filter::In { column: "id".into(), values: stray }, values(vec![("archived_at", json!(at))])),
        )?;
    }
    let base = book.categories.iter().filter_map(|c| c["sort_order"].as_i64()).max().map_or(0, |m| m + 1);
    for (position, (id, group, name)) in SEED.iter().enumerate() {
        let is_income = *group == "Income";
        let mut upsert = Query::insert(values(vec![
            ("id", json!(id)),
            ("group_name", json!(group)),
            ("name", json!(name)),
            ("sort_order", json!(base + position as i64)),
            ("is_income", json!(is_income)),
        ]));
        upsert.conflict = Conflict::Update {
            columns: vec!["owner_user_id".into(), "id".into()],
            values: values(vec![("name", json!(name)), ("group_name", json!(group)), ("is_income", json!(is_income)), ("archived_at", Value::Null)]),
        };
        client.query(CATEGORIES, &upsert)?;
    }
    client.query(
        DRAFTS,
        &Query::update(Filter::eq("status", "open"), values(vec![("status", json!("discarded"))])),
    )?;
    log_as(host, "user", "budget.configure", json!({"isoCurrency":currency}), None)?;
    Ok(Ok(json!({"status":"ok","isoCurrency":currency,"unchanged":false})))
}

/// Categories money can be budgeted into.
pub fn live_ids(book: &budget::Book) -> BTreeSet<String> {
    book.categories
        .iter()
        .filter(|c| c["archived_at"].is_null() && c["id"] != "income" && c["id"] != "transfers")
        .filter_map(|c| c["id"].as_str().map(str::to_owned))
        .collect()
}

pub struct Item {
    pub category: String,
    pub amount: i64,
    pub previous: i64,
}

/// Sets each category's total for the month. Nothing is written unless every item passes.
pub fn apply_items<H: Host + ?Sized>(host: &H, month: &str, items: &[Item], expected: &budget::Review, actor: &str) -> Result<Outcome> {
    let reviewed = match check(host, expected)? {
        Ok(r) => r,
        Err(r) => return Ok(Err(r)),
    };
    let live = live_ids(&reviewed.book);
    let ledger = ledgers(&reviewed.book).remove(month).unwrap_or_default();
    for item in items {
        if !live.contains(&item.category) {
            return Ok(Err(refuse("invalid_category", "categoryId is not a live category")));
        }
        if ledger.get(&item.category).copied().unwrap_or(0) != item.previous {
            return Ok(Err(refuse("stale_previous", "previousCents does not match the stored total; read finance.budget.status again")));
        }
    }
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    for item in items {
        set_total(host, month, &item.category, item.amount)?;
        if item.amount != item.previous {
            log_as(host, actor, "budget.assign", json!({"month":month,"categoryId":item.category}), None)?;
        }
    }
    Ok(Ok(json!({"status":"ok","applied":items.len()})))
}

pub fn set_total<H: Host + ?Sized>(host: &H, month: &str, category: &str, cents: i64) -> Result<()> {
    let mut upsert = Query::insert(values(vec![("month", json!(month)), ("category_id", json!(category)), ("assigned_cents", json!(cents))]));
    upsert.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "month".into(), "category_id".into()],
        values: values(vec![("assigned_cents", json!(cents))]),
    };
    Client(host).query(ASSIGNMENTS, &upsert)?;
    Ok(())
}

/// `finance.budget.assign`.
pub fn assign<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(input));
    let category = ask!(input::required_string(input, "categoryId", None));
    let cents = ask!(amount(input, "amountCents"));
    let previous = ask!(amount(input, "previousCents"));
    let expected = ask!(read_review(input));
    let item = Item { category: category.clone(), amount: cents, previous };
    Ok(apply_items(host, &month, &[item], &expected, "moss")?.map(|_| {
        json!({"status":"ok","month":month,"categoryId":category,"amountCents":cents,
            "before":{"assignedCents":previous},"after":{"assignedCents":cents}})
    }))
}

fn as_list<'a>(command: &'a Map<String, Value>, key: &str) -> Option<&'a Vec<Value>> {
    command.get(key).and_then(Value::as_array)
}

/// `finance.budget.apply`. One category or a batch of up to 20, saved as the person typed them.
pub fn apply<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(command) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(command));
    if command.get("categoryIds").is_none_or(|v| !v.is_array()) {
        let category = ask!(input::required_string(command, "categoryId", None));
        let cents = ask!(amount(command, "amountCents"));
        let previous = ask!(amount(command, "previousCents"));
        let expected = ask!(read_review(command));
        let item = Item { category: category.clone(), amount: cents, previous };
        return Ok(apply_items(host, &month, &[item], &expected, "user")?.map(|_| json!({"status":"ok","month":month,"categoryId":category,"amountCents":cents})));
    }
    let (ids, amounts, previous) = (as_list(command, "categoryIds"), as_list(command, "amountsCents"), as_list(command, "previousAmountsCents"));
    let (Some(ids), Some(amounts), Some(previous)) = (ids, amounts, previous) else {
        return Ok(Err(input::invalid("categoryIds, amountsCents and previousAmountsCents must be equal-length, 1 to 20 items")));
    };
    if ids.is_empty() || ids.len() > MAX_BATCH || ids.len() != amounts.len() || ids.len() != previous.len() {
        return Ok(Err(input::invalid("categoryIds, amountsCents and previousAmountsCents must be equal-length, 1 to 20 items")));
    }
    let number = |v: &Value| -> std::result::Result<i64, Refusal> { amount(&Map::from_iter([("value".to_owned(), v.clone())]), "value") };
    let mut items = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let Some(id) = id.as_str() else {
            return Ok(Err(input::invalid("each batch item needs a category id and an integer amount")));
        };
        items.push(Item { category: id.to_owned(), amount: ask!(number(&amounts[index])), previous: ask!(number(&previous[index])) });
    }
    if items.iter().map(|i| &i.category).collect::<BTreeSet<_>>().len() != items.len() {
        return Ok(Err(input::invalid("categoryIds must be unique")));
    }
    let expected = ask!(read_review(command));
    apply_items(host, &month, &items, &expected, "user")
}

/// `finance.budget.move`. Moves money between two categories, or from ready to assign into one.
pub fn move_money<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(input));
    let from = ask!(input::required_string(input, "fromCategoryId", None));
    let to = ask!(input::required_string(input, "toCategoryId", None));
    let cents = ask!(input::int(input, "amountCents"));
    if !(1..=BOUND).contains(&cents) {
        return Ok(Err(input::invalid(format!("amountCents must be an integer from 1 to {BOUND}"))));
    }
    if to == READY_TO_ASSIGN {
        return Ok(Err(refuse("invalid_category", "toCategoryId must be a category")));
    }
    if from == to {
        return Ok(Err(refuse("invalid_category", "fromCategoryId and toCategoryId must differ")));
    }
    let expected = ask!(read_review(input));
    let reviewed = match check(host, &expected)? {
        Ok(r) => r,
        Err(r) => return Ok(Err(r)),
    };
    let date = today(host)?;
    let ctx = budget::context(host, &reviewed.book, &reviewed.policy.iso, &month, &date)?;
    let live = live_ids(&reviewed.book);
    if !live.contains(&to) || (from != READY_TO_ASSIGN && !live.contains(&from)) {
        return Ok(Err(refuse("invalid_category", "a category id is not a live category or is funded through the flexible pool")));
    }
    let assigned = |id: &str| ctx.month.categories.get(id).map_or(0, |c| c.assigned);
    let from_before = (from != READY_TO_ASSIGN).then(|| assigned(&from));
    let to_before = assigned(&to);
    let available = match from_before {
        None => ctx.ready,
        Some(before) => Some(ctx.month.categories.get(&from).map_or(before, |c| c.available)),
    };
    let Some(available) = available else {
        return Ok(Err(refuse("funding_unavailable", "Ready to assign is unavailable for this month")));
    };
    if cents > available {
        return Ok(Err(match from_before {
            None => refuse("not_enough_ready", "amountCents is more than is ready to assign"),
            Some(_) => refuse("not_enough_available", "amountCents is more than the source holds"),
        }));
    }
    let from_after = from_before.map(|b| crate::envelope::safe(i128::from(b) - i128::from(cents))).transpose()?;
    let to_after = crate::envelope::safe(i128::from(to_before) + i128::from(cents))?;
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    if let Some(after) = from_after {
        set_total(host, &month, &from, after)?;
    }
    set_total(host, &month, &to, to_after)?;
    log_as(host, "moss", "budget.move", json!({"month":month,"fromCategoryId":from,"toCategoryId":to}), None)?;
    Ok(Ok(json!({"status":"ok","month":month,"fromCategoryId":from,"toCategoryId":to,"amountCents":cents,
        "before":{"fromAssignedCents":from_before,"toAssignedCents":to_before},
        "after":{"fromAssignedCents":from_after,"toAssignedCents":to_after}})))
}
