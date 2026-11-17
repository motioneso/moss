//! `finance.activity.list` and `finance.activity.undo`.
//!
//! Activity rows hold ids only. Wording is built when the list is read, from the names and
//! amounts that exist then, so no private text is ever stored in an activity row.
use crate::budget::CATEGORIES;
use crate::export::amount_input;
use crate::input::{self, refuse};
use crate::ledger::{first, log_as, text, values, Outcome, ACTIVITY, TRANSACTIONS};
use crate::rules::RULES;
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

/// Kinds a person can undo. Both name styles are accepted for category adds.
const UNDOABLE: [&str; 5] = ["transaction.categorize", "merchant-rule.set", "category.add", "category.create", "category.archive"];

fn month_name(month: &str) -> String {
    const NAMES: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let m: usize = month.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(0);
    match NAMES.get(m.wrapping_sub(1)) {
        Some(n) => format!("{n} {}", &month[..4]),
        None => month.to_owned(),
    }
}

fn category_name<H: Host + ?Sized>(host: &H, id: &Value) -> Result<String> {
    let Some(id) = id.as_str() else { return Ok("Uncategorized".into()) };
    Ok(first(host, CATEGORIES, Filter::eq("id", id))?.and_then(|c| c["name"].as_str().map(str::to_owned)).unwrap_or_else(|| id.to_owned()))
}

fn transaction_label<H: Host + ?Sized>(host: &H, id: &Value) -> Result<String> {
    let Some(row) = first(host, TRANSACTIONS, Filter::eq("id", id.as_str().unwrap_or("")))? else { return Ok("a transaction".into()) };
    let name = row["merchant"].as_str().filter(|m| !m.is_empty()).or(row["name"].as_str()).unwrap_or("a transaction");
    Ok(format!("{name}, {} {}", amount_input(row["amount_cents"].as_i64().unwrap_or(0)), row["iso_currency"].as_str().unwrap_or("")))
}

/// The sentence for one activity row.
pub fn summary<H: Host + ?Sized>(host: &H, row: &Value) -> Result<String> {
    let p = &row["params"];
    Ok(match row["kind"].as_str().unwrap_or("") {
        "account.create" => "Added a manual account".into(),
        "account.share" if p["shared"] == true => "Shared an account with the household".into(),
        "account.share" => "Stopped sharing an account with the household".into(),
        "transaction.create" => "Added a manual transaction".into(),
        "transaction.import" => {
            let n = p["entryCount"].as_i64().unwrap_or(0);
            format!("Imported {n} manual transaction{}", if n == 1 { "" } else { "s" })
        }
        "transaction.note" => "Changed a private transaction note".into(),
        "budget.configure" => format!("Chose {} budget currency", p["isoCurrency"].as_str().unwrap_or("a")),
        "budget.assign" => format!("Changed {} for {}", category_name(host, &p["categoryId"])?, month_name(p["month"].as_str().unwrap_or(""))),
        "budget.move" => format!("Moved money from {} to {}", category_name(host, &p["fromCategoryId"])?, category_name(host, &p["toCategoryId"])?),
        "transaction.categorize" => {
            let verb = if p["previousCategoryId"].is_null() { "Sorted" } else { "Changed" };
            let joiner = if verb == "Sorted" { "into" } else { "to" };
            format!("{verb} {} {joiner} {}", transaction_label(host, &p["transactionId"])?, category_name(host, &p["categoryId"])?)
        }
        "transaction.confirm" => format!("Confirmed {} as {}", transaction_label(host, &p["transactionId"])?, category_name(host, &p["categoryId"])?),
        "transaction.split" if p["parts"].as_i64().unwrap_or(0) > 1 => format!("Split a transaction between {} categories", p["parts"]),
        "transaction.split" => "Returned a transaction to one category".into(),
        "transaction.bulk-categorize" => format!("Sorted {} transactions into {}", p["count"], category_name(host, &p["categoryId"])?),
        "transaction.bulk-confirm" => format!("Confirmed {} transactions", p["count"]),
        "transaction.sort" => format!("Moss sorted {} transactions", p["count"]),
        "merchant-rule.set" => {
            let merchant = first(host, RULES, Filter::eq("id", p["ruleId"].as_str().unwrap_or("")))?
                .and_then(|r| r["payee_key"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "a merchant".into());
            if p["enabled"] == 0 {
                format!("Disabled merchant rule: {merchant}")
            } else {
                format!("Made a rule: {merchant} goes to {}", category_name(host, &p["categoryId"])?)
            }
        }
        "category.add" | "category.create" => format!("Added the category {}", category_name(host, &p["categoryId"])?),
        "category.edit" | "category.update" => format!("Changed the category {}", category_name(host, &p["categoryId"])?),
        "category.archive" => format!("Archived the category {}", category_name(host, &p["categoryId"])?),
        "bank.connect" => "Connected a bank".into(),
        "bank.reconnect" => "Reconnected a bank".into(),
        "bank.sync-failed" => "A bank sync failed".into(),
        _ => "Changed something in Finance".into(),
    })
}

fn stamp(input: &serde_json::Map<String, Value>, key: &str) -> std::result::Result<String, input::Refusal> {
    let value = input::required_string(input, key, Some(64))?;
    if value.len() < 10 || !value.as_bytes()[..4].iter().all(u8::is_ascii_digit) {
        return Err(input::invalid(format!("{key} must be a timestamp")));
    }
    Ok(value)
}

/// `finance.activity.list`. Newest first.
pub fn list<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let from = ask!(stamp(input, "from"));
    let to = ask!(stamp(input, "to"));
    let limit = match input.get("limit") {
        None | Some(Value::Null) => 200,
        Some(v) => match crate::reports::whole(v).filter(|n| (1..=200).contains(n)) {
            Some(n) => n,
            None => return Ok(Err(input::invalid("limit must be an integer from 1 to 200"))),
        },
    };
    let mut query = Query::select(Filter::And {
        filters: vec![
            Filter::Compare { column: "at".into(), op: Compare::Ge, value: json!(from) },
            Filter::Compare { column: "at".into(), op: Compare::Le, value: json!(to) },
        ],
    });
    query.order = vec![Order { column: "at".into(), descending: true }, Order { column: "id".into(), descending: false }];
    query.limit = Some(limit as u32);
    let rows = Client(host).query(ACTIVITY, &query)?;
    let mut out = Vec::new();
    for row in &rows {
        let undone = !row["undone_at"].is_null();
        out.push(json!({
            "id": row["id"], "at": row["at"], "actor": row["actor"], "summary": summary(host, row)?,
            "undone": undone, "undoable": !undone && !row["undo"].is_null() && UNDOABLE.contains(&row["kind"].as_str().unwrap_or("")),
        }));
    }
    Ok(Ok(json!({"status":"ok","activity":out})))
}

fn changed() -> input::Refusal {
    refuse("changed_since", "Something changed since then, so this can no longer be undone")
}

fn dead_category() -> input::Refusal {
    refuse("invalid_category", "The earlier category is no longer available")
}

fn previous(row: &Value) -> Value {
    row["undo"]["previousCategoryId"].clone()
}

fn live<H: Host + ?Sized>(host: &H, id: &str) -> Result<bool> {
    crate::transactions::live_category(host, id)
}

fn undo_categorize<H: Host + ?Sized>(host: &H, row: &Value) -> Result<Outcome> {
    let (p, before) = (&row["params"], previous(row));
    let Some(tx) = first(host, TRANSACTIONS, Filter::And { filters: vec![Filter::eq("id", p["transactionId"].as_str().unwrap_or("")), Filter::eq("account_id", p["accountId"].as_str().unwrap_or(""))] })? else {
        return Ok(Err(refuse("not_found", "That transaction no longer exists")));
    };
    if tx["category_id"] != p["categoryId"] {
        return Ok(Err(changed()));
    }
    if let Some(old) = before.as_str().filter(|o| !live(host, o).unwrap_or(false)) {
        let _ = old;
        return Ok(Err(dead_category()));
    }
    let none = before.is_null();
    let set = values(vec![
        ("category_id", before.clone()),
        ("categorized_by", if none { Value::Null } else { json!("user") }),
        ("review_state", json!(if none { "needs_look" } else { "confirmed" })),
        ("ai_confidence", Value::Null),
    ]);
    let updated = Client(host).query(
        TRANSACTIONS,
        &Query::update(Filter::And { filters: vec![Filter::eq("id", tx["id"].clone()), Filter::eq("category_id", tx["category_id"].clone())] }, set),
    )?;
    if updated.is_empty() {
        return Ok(Err(changed()));
    }
    let reversal = json!({"transactionId":p["transactionId"],"accountId":p["accountId"],"month":p["month"],"categoryId":before,"previousCategoryId":p["categoryId"]});
    log_as(host, "user", "transaction.categorize", reversal, None)?;
    Ok(Ok(json!(null)))
}

fn undo_rule<H: Host + ?Sized>(host: &H, row: &Value) -> Result<Outcome> {
    let (p, before) = (&row["params"], previous(row));
    let id = p["ruleId"].as_str().unwrap_or("");
    let Some(rule) = first(host, RULES, Filter::eq("id", id))? else { return Ok(Err(changed())) };
    if rule["category_id"] != p["categoryId"] || rule["enabled"] != true {
        return Ok(Err(changed()));
    }
    let own = Filter::And { filters: vec![Filter::eq("id", id), Filter::eq("category_id", p["categoryId"].clone())] };
    let reversal = |category: &Value, enabled: i32| json!({"ruleId":id,"categoryId":category,"enabled":enabled,"previousCategoryId":p["categoryId"]});
    match before.as_str() {
        Some(old) => {
            if !live(host, old)? {
                return Ok(Err(dead_category()));
            }
            let now = text(host, "call", "read", "now")?;
            let done = Client(host).query(RULES, &Query::update(own, values(vec![("category_id", before.clone()), ("updated_at", json!(now))])))?;
            if done.is_empty() {
                return Ok(Err(changed()));
            }
            log_as(host, "user", "merchant-rule.set", reversal(&before, 1), None)?;
        }
        None => {
            if Client(host).query(RULES, &Query::delete(own))?.is_empty() {
                return Ok(Err(changed()));
            }
            log_as(host, "user", "merchant-rule.set", reversal(&p["categoryId"], 0), None)?;
        }
    }
    Ok(Ok(json!(null)))
}

fn undo_category_add<H: Host + ?Sized>(host: &H, row: &Value) -> Result<Outcome> {
    let id = row["params"]["categoryId"].as_str().or(row["undo"]["categoryId"].as_str()).unwrap_or("").to_owned();
    let live_row = Filter::And { filters: vec![Filter::eq("id", id.clone()), Filter::Null { column: "archived_at".into(), not: false }] };
    if first(host, CATEGORIES, live_row.clone())?.is_none() || crate::archive::in_use(host, &id)? {
        return Ok(Err(changed()));
    }
    let now = text(host, "call", "read", "now")?;
    Client(host).query(CATEGORIES, &Query::update(live_row, values(vec![("archived_at", json!(now))])))?;
    log_as(host, "user", "category.archive", json!({"categoryId":id}), None)?;
    Ok(Ok(json!(null)))
}

fn undo_category_archive<H: Host + ?Sized>(host: &H, row: &Value) -> Result<Outcome> {
    let id = row["undo"]["categoryId"].as_str().or(row["params"]["categoryId"].as_str()).unwrap_or("").to_owned();
    let archived = Filter::And { filters: vec![Filter::eq("id", id.clone()), Filter::Null { column: "archived_at".into(), not: true }] };
    let done = Client(host).query(CATEGORIES, &Query::update(archived, values(vec![("archived_at", Value::Null)])))?;
    if done.is_empty() {
        return Ok(Err(changed()));
    }
    log_as(host, "user", "category.update", json!({"categoryId":id}), None)?;
    Ok(Ok(json!(null)))
}

/// `finance.activity.undo`. Reverses one activity row when nothing has changed since.
pub fn undo<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let id = ask!(input::required_string(input, "activityId", Some(64)));
    let Some(row) = first(host, ACTIVITY, Filter::eq("id", id.clone()))? else {
        return Ok(Err(refuse("not_found", "That activity was not found")));
    };
    if !row["undone_at"].is_null() {
        return Ok(Ok(json!({"status":"ok","undone":true,"alreadyUndone":true})));
    }
    let kind = row["kind"].as_str().unwrap_or("");
    if row["undo"].is_null() || !UNDOABLE.contains(&kind) {
        return Ok(Err(refuse("not_undoable", "This change cannot be undone")));
    }
    let result = match kind {
        "transaction.categorize" => undo_categorize(host, &row)?,
        "merchant-rule.set" => undo_rule(host, &row)?,
        "category.archive" => undo_category_archive(host, &row)?,
        _ => undo_category_add(host, &row)?,
    };
    if let Err(refusal) = result {
        return Ok(Err(refusal));
    }
    let now = text(host, "call", "read", "now")?;
    Client(host).query(
        ACTIVITY,
        &Query::update(Filter::And { filters: vec![Filter::eq("id", id), Filter::Null { column: "undone_at".into(), not: false }] }, values(vec![("undone_at", json!(now))])),
    )?;
    Ok(Ok(json!({"status":"ok","undone":true})))
}
