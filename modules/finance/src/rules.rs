//! Merchant rules (`app.finance_merchant_rules`). A rule sends every future row from one payee to
//! one category. It never rewrites rows that already exist.
use crate::input::{self, refuse, Refusal};
use crate::ledger::{first, log_as, text, values, Outcome};
use crate::text::{hash32, is_calendar_month, is_hash32, month_window, normalize_payee, revision, RULE_PAYEE_MAX_CHARS};
use crate::transactions::{and, live_category, same, Actor};
use moss_module_sdk::{
    query::{Compare, Conflict, Filter, Order, Query},
    Client, Host, Result,
};
use serde_json::{json, Map, Value};

pub const RULES: &str = "app.finance_merchant_rules";
const CATEGORIES: &str = "app.finance_categories";
const TRANSACTIONS: &str = crate::ledger::TRANSACTIONS;
const WHERE: &str = "You can see or undo it in Finance settings: the Merchant rules list, or Activity.";
const PREVIEW_LIMIT: usize = 20;

fn rule_revision(row: &Value) -> String {
    revision(row, &["category_id", "enabled", "updated_at"])
}

fn view(row: &Value) -> Value {
    json!({
        "id": row["id"], "payeeKey": row["payee_key"], "categoryId": row["category_id"],
        "enabled": row["enabled"] == true, "writeRevision": rule_revision(row),
    })
}

struct Key {
    merchant: String,
    key: String,
}

fn read_key(input: &Map<String, Value>) -> std::result::Result<Key, Refusal> {
    let merchant = input::required_string(input, "merchant", Some(200))?.trim_matches(input::is_js_space).to_owned();
    let key = normalize_payee(&merchant);
    if key.is_empty() {
        return Err(refuse("invalid_merchant", "Enter a merchant name that has letters in it"));
    }
    if key.chars().count() > RULE_PAYEE_MAX_CHARS {
        return Err(refuse("rule_payee_too_long", "That merchant name is too long for a rule"));
    }
    Ok(Key { merchant, key })
}

fn category_name<H: Host + ?Sized>(host: &H, id: &str) -> Result<String> {
    if let Some(live) = crate::accounts::categories(host)?.into_iter().find(|c| c.id == id) {
        return Ok(live.name);
    }
    Ok(first(host, CATEGORIES, Filter::eq("id", id))?
        .and_then(|r| r["name"].as_str().map(str::to_owned))
        .unwrap_or_else(|| id.to_owned()))
}

pub(crate) struct Made {
    pub id: String,
    pub before: Value,
    pub unchanged: bool,
}

/// Creates or changes the rule for one payee. `enabled` and `expected` are only set by the
/// rules screen.
pub(crate) fn upsert<H: Host + ?Sized>(
    host: &H,
    key: &str,
    category: &str,
    enabled: Option<bool>,
    expected: Option<&str>,
    actor: Actor,
) -> Result<std::result::Result<Made, Refusal>> {
    if !live_category(host, category)? {
        return Ok(Err(refuse("invalid_category", "Choose a current category")));
    }
    let id = hash32(key);
    let existing = first(host, RULES, Filter::eq("id", id.clone()))?;
    if let Some(expected) = expected {
        if !is_hash32(expected) {
            return Ok(Err(refuse("invalid_revision", "The revision is not valid")));
        }
        if existing.as_ref().map(rule_revision).as_deref() != Some(expected) {
            return Ok(Err(refuse("stale_rules", "The rule changed; refresh and try again")));
        }
    }
    let now = text(host, "call", "read", "now")?;
    let on = enabled.unwrap_or(true);
    let before = existing.as_ref().map_or(Value::Null, |r| r["category_id"].clone());
    let who = if actor == Actor::Moss { "moss" } else { "user" };
    let unchanged = match &existing {
        Some(r) => r["category_id"] == category && (r["enabled"] == true) == on,
        None => false,
    };
    if !unchanged {
        match &existing {
            Some(r) => {
                let changed = Client(host).query(
                    RULES,
                    &Query::update(
                        and(vec![Filter::eq("id", id.clone()), same("category_id", &r["category_id"]), same("enabled", &r["enabled"])]),
                        values(vec![("category_id", json!(category)), ("enabled", json!(on)), ("updated_at", json!(now))]),
                    ),
                )?;
                if changed.is_empty() {
                    return Ok(Err(refuse("stale_rules", "The rule changed; refresh and try again")));
                }
            }
            None => {
                let mut insert = Query::insert(values(vec![
                    ("id", json!(id)),
                    ("payee_key", json!(key)),
                    ("category_id", json!(category)),
                    ("enabled", json!(on)),
                    ("created_at", json!(now)),
                    ("updated_at", json!(now)),
                ]));
                insert.conflict = Conflict::Ignore;
                if Client(host).query(RULES, &insert)?.is_empty() {
                    return Ok(Err(refuse("stale_rules", "The rule changed; refresh and try again")));
                }
            }
        }
        log_as(
            host,
            who,
            "merchant-rule.set",
            json!({"ruleId":id,"categoryId":category,"enabled":i32::from(on),"previousCategoryId":before}),
            None,
        )?;
    }
    Ok(Ok(Made { id, before, unchanged }))
}

fn message<H: Host + ?Sized>(host: &H, merchant: &str, category: &str, made: &Made) -> Result<String> {
    let to = category_name(host, category)?;
    if made.unchanged {
        return Ok(format!("Nothing changed. A rule already sends {merchant} to {to}. No existing transactions were changed. {WHERE}"));
    }
    let replaces = match made.before.as_str() {
        Some(old) => format!(" It replaces the earlier rule that sent {merchant} to {}.", category_name(host, old)?),
        None => String::new(),
    };
    Ok(format!(
        "I made a rule: {merchant} always goes to {to}. Future transactions from {merchant} will be sorted into {to} automatically.{replaces} No existing transactions were changed. {WHERE}"
    ))
}

fn answer<H: Host + ?Sized>(host: &H, merchant: &str, category: &str, made: Made) -> Result<Value> {
    let text = message(host, merchant, category, &made)?;
    Ok(json!({
        "status": "ok", "ruleId": made.id, "before": {"categoryId": made.before},
        "after": {"categoryId": category}, "message": text,
    }))
}

/// `finance.rule.set`, the assistant's tool. Moss repeats the message word for word.
pub fn set<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let key = ask!(read_key(input));
    let category = ask!(input::required_string(input, "categoryId", Some(128)));
    let made = ask!(upsert(host, &key.key, &category, None, None, Actor::Moss)?);
    Ok(Ok(answer(host, &key.merchant, &category, made)?))
}

/// A rule made while confirming one transaction in the review screen.
pub(crate) fn set_from<H: Host + ?Sized>(host: &H, rule: &Value, category: &str, actor: Actor) -> Result<std::result::Result<Value, Refusal>> {
    let Some(input) = rule.as_object() else { return Ok(Err(input::invalid("createRule must be an object"))) };
    let key = match read_key(input) {
        Ok(k) => k,
        Err(r) => return Ok(Err(r)),
    };
    let made = match upsert(host, &key.key, category, None, None, actor)? {
        Ok(m) => m,
        Err(r) => return Ok(Err(r)),
    };
    Ok(Ok(answer(host, &key.merchant, category, made)?))
}

/// `finance.rules.update`, the rules screen. Category, switch and optional revision.
pub fn update<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let key = ask!(read_key(input));
    let category = ask!(input::required_string(input, "categoryId", Some(128)));
    let enabled = ask!(input::bool_(input, "enabled"));
    let expected = ask!(input::string(input, "expectedRevision", false, None));
    let made = ask!(upsert(host, &key.key, &category, Some(enabled), expected.as_deref(), Actor::User)?);
    let row = first(host, RULES, Filter::eq("id", made.id.clone()))?.map_or(Value::Null, |r| view(&r));
    Ok(Ok(json!({"status":"ok","unchanged":made.unchanged,"rule":row})))
}

/// `finance.rules.list`.
pub fn list<H: Host + ?Sized>(host: &H, params: &Value) -> Result<Outcome> {
    let empty = Map::new();
    let input = params.as_object().unwrap_or(&empty);
    let search = ask!(input::string(input, "search", false, Some(200))).map(|s| s.to_lowercase());
    let bad = || input::invalid("limit must be an integer from 1 to 1000");
    let limit = match input.get("limit") {
        None | Some(Value::Null) => 50,
        Some(Value::Number(n)) => ask!(n.as_i64().ok_or_else(bad)),
        Some(Value::String(s)) => ask!(s.parse::<i64>().map_err(|_| bad())),
        _ => return Ok(Err(bad())),
    };
    if !(1..=1000).contains(&limit) {
        return Ok(Err(bad()));
    }
    let mut select = Query::select(Filter::All);
    select.order = vec![Order { column: "payee_key".into(), descending: false }, Order { column: "id".into(), descending: false }];
    let rows = Client(host).query(RULES, &select)?;
    let kept: Vec<Value> = rows
        .iter()
        .filter(|r| search.as_deref().is_none_or(|s| r["payee_key"].as_str().is_some_and(|k| k.contains(s))))
        .take(limit as usize)
        .map(view)
        .collect();
    Ok(Ok(json!({"rules": kept})))
}

/// `finance.rules.preview`. How many rows of a month a rule for this merchant would have caught.
pub fn preview<H: Host + ?Sized>(host: &H, params: &Value) -> Result<Outcome> {
    let empty = Map::new();
    let input = params.as_object().unwrap_or(&empty);
    let key = ask!(read_key(input));
    let month = ask!(input::required_string(input, "month", None));
    if !is_calendar_month(&month) {
        return Ok(Err(input::invalid("month must be a valid YYYY-MM")));
    }
    let (start, next) = month_window(&month);
    let rows = Client(host).query(
        TRANSACTIONS,
        &Query::select(and(vec![
            Filter::Compare { column: "date".into(), op: Compare::Ge, value: json!(start) },
            Filter::Compare { column: "date".into(), op: Compare::Lt, value: json!(next) },
        ])),
    )?;
    let matching: Vec<&Value> = rows.iter().filter(|r| r["name"].as_str().is_some_and(|n| normalize_payee(n) == key.key)).collect();
    let examples: Vec<Value> = matching
        .iter()
        .take(PREVIEW_LIMIT)
        .map(|r| json!({"id":r["id"],"date":r["date"],"name":r["name"],"amountCents":r["amount_cents"]}))
        .collect();
    let existing = first(host, RULES, Filter::eq("id", hash32(&key.key)))?.map_or(Value::Null, |r| view(&r));
    Ok(Ok(json!({
        "payeeKey": key.key, "month": month, "total": matching.len(), "limit": PREVIEW_LIMIT,
        "existing": existing, "examples": examples,
    })))
}
