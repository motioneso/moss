//! Bank sync: balances, daily snapshots and transactions for each connected bank. Each bank is
//! isolated, so one refusal never stops the others. Plaid's refusals are stored as the bank's
//! state and the run still finishes. Only a host failure ends it, and the host rolls it back.
use crate::bank::{self, LINKS};
use crate::ledger::{first, log_as, today, values, TRANSACTIONS};
use crate::plaid::{self, cents, Page, PlaidError};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

/// Pages read per run. A real bank holds hundreds of transactions and one call has 30 seconds, so a
/// run stops early and the saved cursor lets the next run continue.
const PAGES_PER_RUN: u32 = 2;
const MAX_RESTARTS: u32 = 3;
const MUTATION: &str = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

#[derive(Default)]
struct Counts {
    added: u32,
    modified: u32,
    removed: u32,
    pages: u32,
}

fn report(item: &str, status: &str, counts: &Counts) -> Value {
    json!({"itemId":item,"status":status,"added":counts.added,"modified":counts.modified,"removed":counts.removed,"pages":counts.pages})
}

/// `finance.sync.run-now` and the six-hour sweep. Every connected bank, one after another.
pub fn run<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let (day, at) = (today(host)?, bank::now(host)?);
    let mut results = Vec::new();
    let mut items = bank::items(host)?;
    items.sort_by_key(|i| i["item_id"].as_str().unwrap_or_default().to_owned());
    for item in &items {
        let Some(id) = item["item_id"].as_str() else { continue };
        results.push(sync_item(host, item, id, &day, &at)?);
    }
    Ok(json!({"status":"ok","items":results}))
}

/// Stores a refusal as the bank's state, and notes a change of state in the activity list.
fn refuse<H: Host + ?Sized>(host: &H, item: &Value, id: &str, error: &PlaidError, counts: &Counts) -> Result<Value> {
    let status = bank::fail_item(host, id, error)?;
    if item["status"] != status {
        log_as(host, "moss", "bank.sync-failed", json!({"itemId":id,"code":error.code}), None)?;
    }
    Ok(report(id, status, counts))
}

fn sync_item<H: Host + ?Sized>(host: &H, item: &Value, id: &str, day: &str, at: &str) -> Result<Value> {
    let mut counts = Counts::default();
    let Some(link) = bank::link(host, id)? else {
        let missing = PlaidError { code: "TOKEN_MISSING".into(), status: 0, detail: Value::Null };
        bank::update_item(host, id, vec![("status", json!("error")), ("last_error", json!(missing.code))])?;
        return Ok(report(id, "error", &counts));
    };
    let slot = link["slot"].as_str().unwrap_or_default().to_owned();

    // Balances come first. Anything but a login problem falls back to the plain account list.
    let mut balance_failure = Value::Null;
    let listing = match plaid::accounts(host, &slot, "/accounts/balance/get")? {
        Ok(listing) => listing,
        Err(e) if e.code == "ITEM_LOGIN_REQUIRED" => return refuse(host, item, id, &e, &counts),
        Err(e) => {
            balance_failure = json!({"code":e.code,"detail":e.detail});
            match plaid::accounts(host, &slot, "/accounts/get")? {
                Ok(listing) => listing,
                Err(e) => return refuse(host, item, id, &e, &counts),
            }
        }
    };
    bank::store_accounts(host, id, &listing.accounts, at)?;
    bank::snapshot(host, &listing.accounts, day)?;

    let mut cursor = link["sync_cursor"].as_str().map(str::to_owned);
    let begin = cursor.clone();
    let (mut restarts, mut pages) = (0, 0);
    while pages < PAGES_PER_RUN {
        match plaid::transactions_sync(host, &slot, cursor.as_deref())? {
            Ok(page) => {
                if !apply(host, &page, &mut counts)? {
                    let bad = PlaidError { code: "INVALID_TRANSACTION".into(), status: 0, detail: Value::Null };
                    return refuse(host, item, id, &bad, &counts);
                }
                pages += 1;
                counts.pages = pages;
                Client(host).query(
                    LINKS,
                    &Query::update(
                        Filter::eq("item_id", id),
                        values(vec![("sync_cursor", json!(page.next_cursor)), ("pagination_start", json!(begin))]),
                    ),
                )?;
                if !page.has_more {
                    break;
                }
                cursor = Some(page.next_cursor);
            }
            Err(e) if e.code == MUTATION && restarts < MAX_RESTARTS => {
                restarts += 1;
                cursor = begin.clone();
            }
            Err(e) => return refuse(host, item, id, &e, &counts),
        }
    }

    // The bank's display name is looked up once. A failed lookup is not a sync failure.
    let institution = listing.institution.or_else(|| item["institution_id"].as_str().map(str::to_owned));
    let mut done = vec![
        ("status", json!("connected")),
        ("last_sync_at", json!(at)),
        ("last_error", Value::Null),
        ("last_error_detail", if balance_failure.is_null() { Value::Null } else { json!(balance_failure.to_string()) }),
    ];
    if let Some(institution) = &institution {
        done.push(("institution_id", json!(institution)));
        if item["institution_name"].is_null() {
            if let Ok(Some(name)) = plaid::institution_name(host, institution)? {
                done.push(("institution_name", json!(name)));
            }
        }
    }
    bank::update_item(host, id, done)?;
    Ok(report(id, "connected", &counts))
}

struct Tx {
    id: String,
    account: String,
    date: String,
    amount: i64,
    currency: String,
    name: String,
    merchant: Option<String>,
    category: Option<String>,
    pending: bool,
    pending_id: Option<String>,
}

fn parse(v: &Value) -> Option<Tx> {
    Some(Tx {
        id: v["transaction_id"].as_str()?.to_owned(),
        account: v["account_id"].as_str()?.to_owned(),
        date: v["date"].as_str()?.to_owned(),
        amount: cents(&v["amount"])?,
        currency: v["iso_currency_code"].as_str().unwrap_or("USD").to_owned(),
        name: v["name"].as_str()?.to_owned(),
        merchant: v["merchant_name"].as_str().map(str::to_owned),
        category: v["personal_finance_category"]["primary"].as_str().map(str::to_owned),
        pending: v["pending"] == true,
        pending_id: v["pending_transaction_id"].as_str().map(str::to_owned),
    })
}

/// Writes one page. Added and modified share one upsert by id, so a repeated page changes
/// nothing. Returns false when a transaction could not be read, which fails the bank.
fn apply<H: Host + ?Sized>(host: &H, page: &Page, counts: &mut Counts) -> Result<bool> {
    let client = Client(host);
    for (list, added) in [(&page.added, true), (&page.modified, false)] {
        for raw in list {
            let Some(tx) = parse(raw) else { return Ok(false) };
            if upsert(host, &tx)? {
                if added {
                    counts.added += 1;
                } else {
                    counts.modified += 1;
                }
            }
        }
    }
    for id in &page.removed {
        if !client.query(TRANSACTIONS, &Query::delete(Filter::eq("id", id.clone())))?.is_empty() {
            counts.removed += 1;
        }
    }
    Ok(true)
}

/// A manual entry is never overwritten. The person's own category and note stay on a changed
/// transaction, and a changed amount puts it back in front of them. A posted transaction takes
/// over what the person did to its pending twin.
fn upsert<H: Host + ?Sized>(host: &H, tx: &Tx) -> Result<bool> {
    let client = Client(host);
    let existing = first(host, TRANSACTIONS, Filter::eq("id", tx.id.clone()))?;
    if existing.as_ref().is_some_and(|r| r["source"] == "manual") {
        return Ok(false);
    }
    let mut carried = None;
    if let (false, Some(pending_id)) = (tx.pending, &tx.pending_id) {
        if let Some(twin) = first(host, TRANSACTIONS, Filter::eq("id", pending_id.clone()))? {
            if twin["source"] == "provider" && twin["pending"] == true && twin["account_id"] == json!(tx.account) {
                client.query(TRANSACTIONS, &Query::delete(Filter::eq("id", pending_id.clone())))?;
                carried = Some(twin).filter(|t| t["categorized_by"] == "user");
            }
        }
    }
    let plaid_columns = vec![
        ("account_id", json!(tx.account)),
        ("date", json!(tx.date)),
        ("amount_cents", json!(tx.amount)),
        ("iso_currency", json!(tx.currency)),
        ("name", json!(tx.name)),
        ("merchant", json!(tx.merchant)),
        ("plaid_category", json!(tx.category)),
        ("pending", json!(tx.pending)),
        ("pending_transaction_id", json!(tx.pending_id)),
    ];
    match existing {
        Some(row) => {
            let mut set = values(plaid_columns);
            let user = row["categorized_by"] == "user";
            if user && (row["amount_cents"] != json!(tx.amount) || row["iso_currency"] != json!(tx.currency)) {
                set.insert("review_state".into(), json!("needs_look"));
            }
            if !user {
                if let Some(twin) = carried {
                    carry(&mut set, &twin);
                }
            }
            client.query(TRANSACTIONS, &Query::update(Filter::eq("id", tx.id.clone()), set))?;
        }
        None => {
            let mut row = values(plaid_columns);
            row.insert("id".into(), json!(tx.id));
            row.insert("review_state".into(), json!("needs_look"));
            if let Some(twin) = carried {
                carry(&mut row, &twin);
            }
            client.query(TRANSACTIONS, &Query::insert(row))?;
        }
    }
    Ok(true)
}

fn carry(into: &mut std::collections::BTreeMap<String, Value>, twin: &Value) {
    for key in ["category_id", "categorized_by", "notes", "review_state"] {
        into.insert(key.into(), twin[key].clone());
    }
}
