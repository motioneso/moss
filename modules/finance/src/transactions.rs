//! Transactions: the month query, single and bulk categorizing, confirming and notes
//! (`app.finance_transactions`). One invocation is one database transaction.
//!
//! A write checks the row it read by repeating the old column values in the update filter, so a row
//! changed in between matches nothing and the call refuses instead of overwriting.
use crate::input::{self, refuse, Refusal};
use crate::ledger::{first, log, log_as, values, Outcome, TRANSACTIONS};
use crate::text::{self, is_calendar_month, is_hash32, month_window, normalize_payee};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub const DEFAULT_LIMIT: usize = 50;
pub const MAX_LIMIT: usize = 2000;
pub const MAX_NOTES_BYTES: usize = 4000;
pub const MAX_BATCH: usize = 200;

/// The fields a writer may change. The write revision is a hash of these.
const REVISION_FIELDS: [&str; 7] =
    ["category_id", "categorized_by", "review_state", "notes", "splits", "split_revision", "amount_cents"];

pub(crate) fn write_revision(row: &Value) -> String {
    text::revision(row, &REVISION_FIELDS)
}

pub(crate) fn same(column: &str, value: &Value) -> Filter {
    if value.is_null() {
        Filter::Null { column: column.into(), not: false }
    } else {
        Filter::Compare { column: column.into(), op: Compare::Eq, value: value.clone() }
    }
}

pub(crate) fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}

pub(crate) fn splits_of(row: &Value) -> Vec<(String, i64)> {
    row["splits"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .map(|p| (p["categoryId"].as_str().unwrap_or("").to_owned(), p["amountCents"].as_i64().unwrap_or(0)))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn split_balanced(row: &Value) -> bool {
    let parts = splits_of(row);
    !parts.is_empty() && parts.iter().map(|p| p.1).sum::<i64>() == row["amount_cents"].as_i64().unwrap_or(0)
}

fn needs_look(row: &Value) -> bool {
    row["review_state"] == "needs_look" || (!splits_of(row).is_empty() && !split_balanced(row))
}

fn month_of(row: &Value) -> String {
    row["date"].as_str().unwrap_or("").chars().take(7).collect()
}

fn view(row: &Value) -> Value {
    json!({
        "id": row["id"], "accountId": row["account_id"], "date": row["date"], "amountCents": row["amount_cents"],
        "isoCurrency": row["iso_currency"], "name": row["name"], "merchant": row["merchant"],
        "plaidCategory": row["plaid_category"], "categoryId": row["category_id"], "pending": row["pending"] == true,
        "pendingTransactionId": row["pending_transaction_id"], "categorizedBy": row["categorized_by"],
        "reviewState": row["review_state"], "aiConfidence": row["ai_confidence"], "notes": row["notes"],
        "splits": row["splits"], "splitRevision": row["split_revision"].as_i64().unwrap_or(0),
        "source": row["source"], "cleared": row["cleared"] == true, "reconciledAt": row["reconciled_at"],
        "transferId": row["transfer_id"], "writeRevision": write_revision(row),
    })
}

fn duplicate_key(row: &Value) -> String {
    let name = row["merchant"].as_str().filter(|m| !m.is_empty()).or(row["name"].as_str()).unwrap_or("");
    let lowered = name.trim().split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    format!("{}|{}|{}|{}|{}", row["account_id"], row["iso_currency"], row["date"], row["amount_cents"], lowered)
}

fn read_month(input: &Map<String, Value>, today: &str) -> std::result::Result<String, Refusal> {
    match input::string(input, "month", false, None)? {
        None => Ok(today[..7].to_owned()),
        Some(m) if is_calendar_month(&m) => Ok(m),
        Some(_) => Err(input::invalid("month must be a valid YYYY-MM")),
    }
}

/// Query-string values arrive as text, so booleans and numbers read both forms.
fn flag(input: &Map<String, Value>, key: &str) -> std::result::Result<bool, Refusal> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::String(s)) if s == "true" => Ok(true),
        Some(Value::String(s)) if s == "false" => Ok(false),
        _ => Err(input::invalid(format!("{key} must be a boolean"))),
    }
}

fn limit(input: &Map<String, Value>) -> std::result::Result<usize, Refusal> {
    let bad = || input::invalid(format!("limit must be an integer from 1 to {MAX_LIMIT}"));
    let n = match input.get("limit") {
        None | Some(Value::Null) => return Ok(DEFAULT_LIMIT),
        Some(Value::Number(n)) => n.as_i64().ok_or_else(bad)?,
        Some(Value::String(s)) => s.parse::<i64>().map_err(|_| bad())?,
        _ => return Err(bad()),
    };
    if (1..=MAX_LIMIT as i64).contains(&n) { Ok(n as usize) } else { Err(bad()) }
}

fn choice(input: &Map<String, Value>, key: &str, allowed: &[&str]) -> std::result::Result<Option<String>, Refusal> {
    match input::string(input, key, false, None)? {
        None => Ok(None),
        Some(v) if allowed.contains(&v.as_str()) => Ok(Some(v)),
        Some(_) => Err(input::invalid(format!("{key} is not a supported value"))),
    }
}

/// `finance.transactions.query`. The person's own rows for one month, newest first.
pub fn query<H: Host + ?Sized>(host: &H, params: &Value) -> Result<Outcome> {
    let empty = Map::new();
    let input = params.as_object().unwrap_or(&empty);
    let today = crate::ledger::today(host)?;
    let month = ask!(read_month(input, &today));
    let account = ask!(input::string(input, "accountId", false, None));
    let transaction = ask!(input::string(input, "transactionId", false, None));
    let category = ask!(input::string(input, "categoryId", false, None));
    let search = ask!(input::string(input, "search", false, None)).map(|s| s.to_lowercase());
    let pending_only = ask!(flag(input, "pendingOnly"));
    let uncategorized = ask!(flag(input, "uncategorizedOnly"));
    let duplicates_only = ask!(flag(input, "duplicatesOnly"));
    let needs_look_only = ask!(flag(input, "needsLookOnly"));
    let posting = ask!(choice(input, "postingState", &["pending", "posted"]));
    let direction = ask!(choice(input, "direction", &["inflow", "outflow"]));
    let ledger = ask!(choice(input, "ledgerState", &["cleared", "uncleared", "reconciled"]));
    let limit = ask!(limit(input));

    let (start, next) = month_window(&month);
    let mut select = Query::select(and(vec![
        Filter::Compare { column: "date".into(), op: Compare::Ge, value: json!(start) },
        Filter::Compare { column: "date".into(), op: Compare::Lt, value: json!(next) },
    ]));
    select.order = vec![Order { column: "date".into(), descending: true }, Order { column: "id".into(), descending: false }];
    let mut rows = Client(host).query(TRANSACTIONS, &select)?;

    let mut groups: std::collections::BTreeMap<String, usize> = Default::default();
    for row in &rows {
        *groups.entry(duplicate_key(row)).or_default() += 1;
    }
    // Household rows join the month before the filters run. They never count as duplicates or
    // as needing a look, because they belong to someone else's books.
    rows.extend(crate::shared::month_rows(host, &start, &next)?);
    rows.sort_by(|a, b| b["date"].as_str().cmp(&a["date"].as_str()).then(a["id"].as_str().cmp(&b["id"].as_str())));
    let dup = |r: &Value| if crate::shared::is_shared(r) { 0 } else { groups.get(&duplicate_key(r)).copied().unwrap_or(0) };
    rows.retain(|r| {
        let parts = splits_of(r);
        account.as_deref().is_none_or(|a| r["account_id"] == a)
            && transaction.as_deref().is_none_or(|t| r["id"] == t)
            && category.as_deref().is_none_or(|c| r["category_id"] == c || parts.iter().any(|p| p.0 == c))
            && search.as_deref().is_none_or(|s| {
                ["name", "merchant", "notes"].iter().any(|k| r[*k].as_str().is_some_and(|t| t.to_lowercase().contains(s)))
            })
            && (!pending_only || r["pending"] == true)
            && posting.as_deref().is_none_or(|p| (r["pending"] == true) == (p == "pending"))
            && direction.as_deref().is_none_or(|d| {
                let cents = r["amount_cents"].as_i64().unwrap_or(0);
                if d == "inflow" { cents < 0 } else { cents > 0 }
            })
            && ledger.as_deref().is_none_or(|state| {
                if r["source"] != "manual" || r["pending"] == true {
                    return false;
                }
                let reconciled = !r["reconciled_at"].is_null();
                match state {
                    "reconciled" => reconciled,
                    _ => !reconciled && (r["cleared"] == true) == (state == "cleared"),
                }
            })
            && (!uncategorized || (r["category_id"].is_null() && !split_balanced(r)))
            && (!duplicates_only || dup(r) >= 2)
    });
    let looks = |r: &Value| !crate::shared::is_shared(r) && needs_look(r);
    let needs_look_count = rows.iter().filter(|r| looks(r)).count();
    if needs_look_only {
        rows.retain(|r| looks(r));
    }
    let total = rows.len();
    rows.truncate(limit);
    let shown: Vec<Value> = rows
        .iter()
        .map(|r| {
            if crate::shared::is_shared(r) {
                return crate::shared::view(r);
            }
            let mut v = view(r);
            if dup(r) >= 2 {
                v["possibleDuplicate"] = json!(true);
            }
            v
        })
        .collect();
    let categories: Vec<Value> = accounts_categories(host)?;
    let accounts = crate::accounts::list(host)?["accounts"].clone();
    Ok(Ok(json!({
        "month": month, "transactions": shown, "totalCount": total, "needsLookCount": needs_look_count,
        "supportsSplits": true, "supportsBulk": true, "supportsConfirm": true, "supportsNotes": true,
        "categories": categories, "accounts": accounts,
    })))
}

fn accounts_categories<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>> {
    Ok(crate::accounts::categories(host)?.into_iter().map(|c| json!({"id":c.id,"name":c.name})).collect())
}

pub(crate) fn live_category<H: Host + ?Sized>(host: &H, id: &str) -> Result<bool> {
    Ok(crate::accounts::categories(host)?.iter().any(|c| c.id == id))
}

/// Normalized payees of every merchant the person has already confirmed a category for.
pub(crate) fn seen_payees<H: Host + ?Sized>(host: &H) -> Result<BTreeSet<String>> {
    let rows = Client(host).query(
        TRANSACTIONS,
        &Query::select(and(vec![
            Filter::eq("review_state", "confirmed"),
            Filter::Null { column: "category_id".into(), not: true },
        ])),
    )?;
    Ok(rows.iter().filter_map(|r| r["name"].as_str()).map(normalize_payee).filter(|p| !p.is_empty()).collect())
}

fn bad_category() -> Refusal {
    refuse("invalid_category", "Choose a current category")
}
fn not_found() -> Refusal {
    refuse("not_found", "That transaction was not found")
}

#[derive(Clone, Copy, PartialEq)]
pub enum Actor {
    User,
    Moss,
}

/// What a single categorizing call may require about the merchant.
#[derive(Clone, Copy, PartialEq)]
pub enum Merchant {
    Any,
    Seen,
    New,
}

pub struct Apply<'a> {
    pub id: &'a str,
    pub account_id: &'a str,
    pub month: &'a str,
    pub category: &'a str,
    pub actor: Actor,
    pub merchant: Merchant,
    pub amount_cents: Option<i64>,
    pub notes: Option<&'a str>,
}

/// Sets the category on one unsplit, unlinked row and confirms it. Returns whether the category
/// changed. Writes nothing when it refuses.
pub(crate) fn apply_category<H: Host + ?Sized>(host: &H, a: &Apply, log_unchanged: bool) -> Result<std::result::Result<bool, Refusal>> {
    let row = match check_category(host, a)? {
        Ok(row) => row,
        Err(refusal) => return Ok(Err(refusal)),
    };
    write_category(host, a, row, log_unchanged)
}

/// Every refusal `apply_category` can give before it writes. Writes nothing.
fn check_category<H: Host + ?Sized>(host: &H, a: &Apply) -> Result<std::result::Result<Value, Refusal>> {
    let Some(row) = first(host, TRANSACTIONS, and(vec![Filter::eq("id", a.id), Filter::eq("account_id", a.account_id)]))? else {
        return Ok(Err(not_found()));
    };
    if month_of(&row) != a.month {
        return Ok(Err(not_found()));
    }
    if !row["transfer_id"].is_null() {
        return Ok(Err(refuse("linked_transfer", "Linked transfers are managed from the transfer")));
    }
    if !splits_of(&row).is_empty() {
        return Ok(Err(refuse("split_transaction", "Change the split instead of the category")));
    }
    if !live_category(host, a.category)? {
        return Ok(Err(bad_category()));
    }
    if let Some(cents) = a.amount_cents {
        if row["amount_cents"] != json!(cents) {
            return Ok(Err(refuse("amount_mismatch", "The amount no longer matches the transaction")));
        }
    }
    if a.merchant != Merchant::Any {
        let seen = seen_payees(host)?.contains(&normalize_payee(row["name"].as_str().unwrap_or("")));
        match (a.merchant, seen) {
            (Merchant::New, true) => return Ok(Err(refuse("merchant_seen", "This merchant already has a confirmed category"))),
            (Merchant::Seen, false) => return Ok(Err(refuse("new_merchant", "This merchant is new, so the category needs your approval"))),
            _ => {}
        }
    }
    Ok(Ok(row))
}

fn write_category<H: Host + ?Sized>(host: &H, a: &Apply, row: Value, log_unchanged: bool) -> Result<std::result::Result<bool, Refusal>> {
    let previous = row["category_id"].clone();
    let mut set = values(vec![
        ("category_id", json!(a.category)),
        ("categorized_by", json!(if a.actor == Actor::Moss { "moss" } else { "user" })),
        ("review_state", json!("confirmed")),
        ("ai_confidence", Value::Null),
    ]);
    if let Some(notes) = a.notes {
        set.insert("notes".into(), if notes.is_empty() { Value::Null } else { json!(notes) });
    }
    let changed = Client(host).query(
        TRANSACTIONS,
        &Query::update(
            and(vec![
                Filter::eq("id", a.id),
                Filter::eq("account_id", a.account_id),
                same("category_id", &previous),
                same("review_state", &row["review_state"]),
                same("categorized_by", &row["categorized_by"]),
                same("notes", &row["notes"]),
            ]),
            set,
        ),
    )?;
    if changed.is_empty() {
        return Ok(Err(refuse("stale_transaction", "The transaction changed; refresh and try again")));
    }
    let moved = previous != json!(a.category);
    if moved || log_unchanged {
        let params = json!({"transactionId":a.id,"accountId":a.account_id,"month":a.month,"categoryId":a.category,"previousCategoryId":previous});
        let actor = if a.actor == Actor::Moss { "moss" } else { "user" };
        if moved {
            log_as(host, actor, "transaction.categorize", params, Some(json!({"previousCategoryId":previous})))?;
        } else {
            log_as(host, actor, "transaction.confirm", params, None)?;
        }
    }
    Ok(Ok(moved))
}

fn object<'a>(body: &'a Value) -> std::result::Result<&'a Map<String, Value>, Refusal> {
    body.as_object().ok_or_else(|| input::invalid("Input must be an object"))
}

struct Ids {
    id: String,
    account: String,
    month: String,
    category: String,
}

fn read_ids(input: &Map<String, Value>) -> std::result::Result<Ids, Refusal> {
    let month = input::required_string(input, "month", None)?;
    if !is_calendar_month(&month) {
        return Err(input::invalid("month must be a valid YYYY-MM"));
    }
    Ok(Ids {
        id: input::required_string(input, "transactionId", Some(256))?,
        account: input::required_string(input, "accountId", Some(128))?,
        month,
        category: input::required_string(input, "categoryId", Some(128))?,
    })
}

/// The person's own category choice for one row, from the screen.
pub fn set_category<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let input = ask!(object(body));
    let ids = ask!(read_ids(input));
    let apply = Apply { id: &ids.id, account_id: &ids.account, month: &ids.month, category: &ids.category, actor: Actor::User, merchant: Merchant::Any, amount_cents: None, notes: None };
    let moved = ask!(apply_category(host, &apply, true)?);
    Ok(Ok(json!({"status":"ok","unchanged":!moved})))
}

/// The assistant's categorizing tools. `merchant` says whether the merchant must be seen or new.
pub fn categorize<H: Host + ?Sized>(host: &H, body: &Value, merchant: Merchant) -> Result<Outcome> {
    let input = ask!(object(body));
    let ids = ask!(read_ids(input));
    let cents = ask!(input::int(input, "amountCents"));
    let notes = ask!(input::string(input, "notes", false, Some(2000)));
    let apply = Apply { id: &ids.id, account_id: &ids.account, month: &ids.month, category: &ids.category, actor: Actor::Moss, merchant, amount_cents: Some(cents), notes: notes.as_deref() };
    let moved = ask!(apply_category(host, &apply, false)?);
    Ok(Ok(json!({"status":"ok","unchanged":!moved})))
}

fn id_list(input: &Map<String, Value>, key: &str) -> std::result::Result<Vec<String>, Refusal> {
    let list = input.get(key).and_then(Value::as_array).ok_or_else(|| input::invalid(format!("{key} must be a list")))?;
    if list.is_empty() || list.len() > MAX_BATCH {
        return Err(input::invalid(format!("{key} must hold 1 to {MAX_BATCH} items")));
    }
    list.iter()
        .map(|v| v.as_str().filter(|s| !s.is_empty() && s.len() <= 256).map(str::to_owned).ok_or_else(|| input::invalid(format!("{key} holds an invalid item"))))
        .collect()
}

/// Several category choices at once. Everything is checked before the first write.
pub fn review_apply<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let input = ask!(object(body));
    let transactions = ask!(id_list(input, "transactionIds"));
    let accounts = ask!(id_list(input, "accountIds"));
    let months = ask!(id_list(input, "months"));
    let categories = ask!(id_list(input, "categoryIds"));
    if [accounts.len(), months.len(), categories.len()].iter().any(|n| *n != transactions.len()) {
        return Ok(Err(input::invalid("The lists must have the same length")));
    }
    if months.iter().any(|m| !is_calendar_month(m)) {
        return Ok(Err(input::invalid("months must be valid YYYY-MM")));
    }
    let rule = input.get("createRule").filter(|v| !v.is_null());
    if rule.is_some() && transactions.len() != 1 {
        return Ok(Err(input::invalid("A rule can only be made from one transaction")));
    }
    let mut seen = BTreeSet::new();
    if !transactions.iter().all(|t| seen.insert(t.clone())) {
        return Ok(Err(input::invalid("transactionIds must be distinct")));
    }
    for category in categories.iter().collect::<BTreeSet<_>>() {
        if !live_category(host, category)? {
            return Ok(Err(bad_category()));
        }
    }
    // Every refusal comes before the first write. A tool call commits whatever it wrote, so a
    // refusal after a write would keep the earlier rows.
    let mut checked = Vec::new();
    for i in 0..transactions.len() {
        let apply = Apply { id: &transactions[i], account_id: &accounts[i], month: &months[i], category: &categories[i], actor: Actor::User, merchant: Merchant::Any, amount_cents: None, notes: None };
        checked.push(ask!(check_category(host, &apply)?));
    }
    let made = match rule {
        Some(rule) => Some(ask!(crate::rules::set_from(host, rule, &categories[0], Actor::User)?)),
        None => None,
    };
    let mut results = Vec::new();
    for (i, row) in checked.into_iter().enumerate() {
        let apply = Apply { id: &transactions[i], account_id: &accounts[i], month: &months[i], category: &categories[i], actor: Actor::User, merchant: Merchant::Any, amount_cents: None, notes: None };
        let moved = match write_category(host, &apply, row, true)? {
            Ok(moved) => moved,
            Err(_) => return Err(Error::new("A transaction changed during the save")),
        };
        results.push(json!({"transactionId":transactions[i],"unchanged":!moved}));
    }
    let mut out = json!({"status":"ok","applied":results.len(),"results":results});
    if let Some(made) = made {
        out["rule"] = made;
    }
    Ok(Ok(out))
}

struct Pick {
    id: String,
    revision: String,
}

fn picks(input: &Map<String, Value>) -> std::result::Result<Vec<Pick>, Refusal> {
    let list = input.get("transactions").and_then(Value::as_array).ok_or_else(|| input::invalid("transactions must be a list"))?;
    if list.is_empty() || list.len() > MAX_BATCH {
        return Err(input::invalid(format!("transactions must hold 1 to {MAX_BATCH} items")));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in list {
        let o = item.as_object().ok_or_else(|| input::invalid("transactions holds an invalid item"))?;
        let id = input::required_string(o, "id", Some(256))?;
        let revision = input::required_string(o, "writeRevision", None)?;
        if id.is_empty() || !is_hash32(&revision) || !seen.insert(id.clone()) {
            return Err(input::invalid("transactions holds an invalid or repeated item"));
        }
        out.push(Pick { id, revision });
    }
    Ok(out)
}

fn stale() -> Refusal {
    refuse("stale_transactions", "Some transactions changed; refresh and try again")
}

/// Loads the picked rows, requiring each to exist with the revision the screen showed.
fn load_picked<H: Host + ?Sized>(host: &H, picks: &[Pick]) -> Result<std::result::Result<Vec<Value>, Refusal>> {
    let ids: Vec<Value> = picks.iter().map(|p| json!(p.id)).collect();
    let rows = Client(host).query(TRANSACTIONS, &Query::select(Filter::In { column: "id".into(), values: ids }))?;
    let mut out = Vec::new();
    for pick in picks {
        match rows.iter().find(|r| r["id"] == pick.id.as_str()) {
            Some(r) if write_revision(r) == pick.revision => out.push(r.clone()),
            _ => return Ok(Err(stale())),
        }
    }
    Ok(Ok(out))
}

fn settle_rows<H: Host + ?Sized>(host: &H, rows: &[Value], set: impl Fn(&Value) -> std::collections::BTreeMap<String, Value>) -> Result<std::result::Result<usize, Refusal>> {
    for row in rows {
        let changed = Client(host).query(
            TRANSACTIONS,
            &Query::update(
                and(vec![
                    Filter::eq("id", row["id"].clone()),
                    same("category_id", &row["category_id"]),
                    same("review_state", &row["review_state"]),
                    same("categorized_by", &row["categorized_by"]),
                    same("notes", &row["notes"]),
                ]),
                set(row),
            ),
        )?;
        if changed.is_empty() {
            // Earlier rows are already written, so ending the call rolls them back.
            return Err(Error::new("A transaction changed during the save"));
        }
    }
    Ok(Ok(rows.len()))
}

/// One live category for many unsplit, unlinked rows.
pub fn bulk_categorize<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let input = ask!(object(body));
    let category = ask!(input::required_string(input, "categoryId", Some(128)));
    let picked = ask!(picks(input));
    if !live_category(host, &category)? {
        return Ok(Err(bad_category()));
    }
    let rows = ask!(load_picked(host, &picked)?);
    if rows.iter().any(|r| !r["transfer_id"].is_null() || !splits_of(r).is_empty()) {
        return Ok(Err(stale()));
    }
    let n = ask!(settle_rows(host, &rows, |_| values(vec![
        ("category_id", json!(category)),
        ("categorized_by", json!("user")),
        ("review_state", json!("confirmed")),
        ("ai_confidence", Value::Null),
    ]))?);
    log(host, "transaction.bulk-categorize", json!({"categoryId":category,"count":n}))?;
    Ok(Ok(json!({"status":"ok","updated":n})))
}

/// Confirms rows that need a look and already hold a category.
pub fn bulk_confirm<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let input = ask!(object(body));
    let picked = ask!(picks(input));
    let rows = ask!(load_picked(host, &picked)?);
    if rows.iter().any(|r| r["review_state"] != "needs_look" || r["category_id"].is_null()) {
        return Ok(Err(stale()));
    }
    let n = ask!(settle_rows(host, &rows, |_| values(vec![("review_state", json!("confirmed"))]))?);
    log(host, "transaction.bulk-confirm", json!({"count":n}))?;
    Ok(Ok(json!({"confirmed":n})))
}

fn notes_ids(input: &Map<String, Value>) -> std::result::Result<(String, String, String), Refusal> {
    let month = input::required_string(input, "month", None)?;
    if !is_calendar_month(&month) {
        return Err(input::invalid("month must be a valid YYYY-MM"));
    }
    Ok((input::required_string(input, "transactionId", Some(256))?, input::required_string(input, "accountId", Some(128))?, month))
}

/// A note the old rules accept: no NUL, within 4000 bytes, kept exactly as typed.
fn valid_note(note: &str) -> bool {
    note.len() <= MAX_NOTES_BYTES && !note.contains('\0')
}

/// `finance.transactions.notes.read`.
pub fn notes_read<H: Host + ?Sized>(host: &H, params: &Value) -> Result<Outcome> {
    let empty = Map::new();
    let input = params.as_object().unwrap_or(&empty);
    let (id, account, month) = ask!(notes_ids(input));
    let found = first(host, TRANSACTIONS, and(vec![Filter::eq("id", id.clone()), Filter::eq("account_id", account.clone())]))?
        .filter(|r| month_of(r) == month);
    Ok(Ok(match found {
        None => json!({"available":false}),
        Some(r) => json!({
            "available": true, "transactionId": id, "accountId": account, "month": month,
            "name": r["name"], "date": r["date"], "notes": r["notes"], "writeRevision": write_revision(&r),
        }),
    }))
}

/// `finance.transactions.notes.save`. Saved, unchanged or stale.
pub fn notes_save<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let input = ask!(object(body));
    let (id, account, month) = ask!(notes_ids(input));
    let revision = ask!(input::required_string(input, "writeRevision", None));
    let note = ask!(input::string(input, "notes", true, None)).unwrap_or_default();
    if !is_hash32(&revision) || !valid_note(&note) {
        return Ok(Err(refuse("invalid_note", "The note is too long or holds characters that cannot be saved")));
    }
    let found = first(host, TRANSACTIONS, and(vec![Filter::eq("id", id.clone()), Filter::eq("account_id", account.clone())]))?
        .filter(|r| month_of(r) == month);
    let Some(row) = found.filter(|r| write_revision(r) == revision) else {
        return Ok(Err(refuse("stale_transaction", "The transaction changed; refresh and try again")));
    };
    let new = if note.is_empty() { Value::Null } else { json!(note) };
    if row["notes"] == new {
        return Ok(Ok(json!({"status":"ok","unchanged":true,"writeRevision":revision})));
    }
    let changed = Client(host).query(
        TRANSACTIONS,
        &Query::update(
            and(vec![Filter::eq("id", id.clone()), Filter::eq("account_id", account.clone()), same("notes", &row["notes"])]),
            values(vec![("notes", new.clone())]),
        ),
    )?;
    if changed.is_empty() {
        return Ok(Err(refuse("stale_transaction", "The transaction changed; refresh and try again")));
    }
    log(host, "transaction.note", json!({"transactionId":id,"accountId":account,"month":month,"notesChanged":true}))?;
    let mut after = row.clone();
    after["notes"] = new;
    Ok(Ok(json!({"status":"ok","unchanged":false,"writeRevision":write_revision(&after)})))
}
