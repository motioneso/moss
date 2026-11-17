//! Manual account and entry creation (`app.finance_accounts`, `app.finance_transactions`).
//!
//! One invocation is one database transaction. The balance moves first, guarded by the account's
//! revision, so two writers cannot both move it from the same starting balance. A failure after
//! that point ends the invocation and the host rolls the balance back.
use crate::input::{self, refuse, Refusal, MAX_SAFE};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const ACCOUNTS: &str = "app.finance_accounts";
pub const TRANSACTIONS: &str = "app.finance_transactions";
pub const ACTIVITY: &str = "app.finance_activity";

/// A finished call. A refusal is something the person can fix, not a host failure.
pub type Outcome = std::result::Result<Value, Refusal>;

pub fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

fn text<H: Host + ?Sized>(host: &H, port_resource: &str, operation: &str, key: &str) -> Result<String> {
    let value = host.call("context", operation, port_resource, json!({}))?;
    value[key].as_str().map(str::to_owned).ok_or_else(|| Error::new("Host context incomplete"))
}
/// The person's calendar day.
pub fn today<H: Host + ?Sized>(host: &H) -> Result<String> {
    text(host, "account", "local-date", "date")
}

/// sha256 of the JSON text of the ordered values, as the old code stored it.
fn digest(ordered: &Map<String, Value>) -> Result<String> {
    let json = serde_json::to_string(ordered)?;
    Ok(Sha256::digest(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect())
}

fn done(id: &str, unchanged: bool) -> Outcome {
    Ok(json!({"status":"ok","id":id,"unchanged":unchanged}))
}
fn failed(reason: &str) -> Outcome {
    let (code, message) = match reason {
        "conflict" => ("manual_conflict", "This operation identity belongs to different entries; check the saved result"),
        "unavailable" => ("manual_unavailable", "This manual account is unavailable, archived or has a different currency"),
        "invalid_date" => ("manual_invalid_date", "The entry date precedes the account opening balance"),
        "reconciled_period" => ("manual_reconciled_period", "This date is in a reconciled statement period; choose a later date"),
        _ => ("manual_overflow", "The resulting balance exceeds supported precision"),
    };
    Err(refuse(code, message))
}

fn first<H: Host + ?Sized>(host: &H, table: &str, filter: Filter) -> Result<Option<Value>> {
    let mut query = Query::select(filter);
    query.limit = Some(1);
    Ok(Client(host).query(table, &query)?.into_iter().next())
}

/// Activity rows hold ids only. No amount, name or note is written there.
fn log<H: Host + ?Sized>(host: &H, kind: &str, params: Value) -> Result<()> {
    let id = text(host, "new", "uuid", "id")?;
    let at = text(host, "call", "read", "now")?;
    let row = values(vec![("id", json!(id)), ("at", json!(at)), ("actor", json!("user")), ("kind", json!(kind)), ("params", params)]);
    Client(host).query(ACTIVITY, &Query::insert(row))?;
    Ok(())
}

/// Leaves with the refusal when a reader fails.
macro_rules! ask {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(refusal) => return Ok(Err(refusal)),
        }
    };
}

pub fn create_account<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else {
        return Ok(Err(input::invalid("Input must be an object")));
    };
    let today = today(host)?;
    let id = ask!(input::operation_id(input, "operationId"));
    let name = ask!(input::required_string(input, "name", Some(320)));
    let name = name.trim_matches(input::is_js_space).to_owned();
    if name.is_empty() {
        return Ok(Err(input::invalid("name is required")));
    }
    let kind = ask!(input::required_string(input, "accountType", None));
    if !input::ACCOUNT_TYPES.contains(&kind.as_str()) {
        return Ok(Err(input::invalid("accountType is unsupported")));
    }
    let (type_, subtype) = input::account_kind(&kind);
    let currency = ask!(input::currency(input));
    let opening_date = ask!(input::date(input, "openingDate", &today));
    let opening = ask!(input::int(input, "openingBalanceCents"));

    let mut ordered = Map::new();
    ordered.insert("accountId".into(), json!(id));
    ordered.insert("name".into(), json!(name));
    ordered.insert("type".into(), json!(type_));
    ordered.insert("subtype".into(), json!(subtype));
    ordered.insert("isoCurrency".into(), json!(currency));
    ordered.insert("openingDate".into(), json!(opening_date));
    ordered.insert("openingBalanceCents".into(), json!(opening));
    let digest = digest(&ordered)?;

    let row = values(vec![
        ("account_id", json!(id)),
        ("name", json!(name)),
        ("type", json!(type_)),
        ("subtype", json!(subtype)),
        ("balance_cents", json!(opening)),
        ("iso_currency", json!(currency)),
        ("updated_at", json!(text(host, "call", "read", "now")?)),
        ("source", json!("manual")),
        ("opening_date", json!(opening_date)),
        ("opening_balance_cents", json!(opening)),
        ("creation_digest", json!(digest)),
    ]);
    let mut insert = Query::insert(row);
    insert.conflict = Conflict::Ignore;
    if !Client(host).query(ACCOUNTS, &insert)?.is_empty() {
        log(host, "account.create", json!({"accountId":id}))?;
        return Ok(done(&id, false));
    }
    let prior = first(host, ACCOUNTS, Filter::eq("account_id", id.clone()))?;
    let same = prior.is_some_and(|p| p["source"] == "manual" && p["creation_digest"] == json!(digest));
    Ok(if same { done(&id, true) } else { failed("conflict") })
}

fn category_is_current<H: Host + ?Sized>(host: &H, id: &str) -> Result<bool> {
    Ok(crate::accounts::categories(host)?.iter().any(|c| c.id == id))
}

/// A writer that loses a race on the account rereads once, so a repeated operation answers
/// unchanged and a different one applies on top of the winner's balance.
pub fn create_entry<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    create_entry_attempt(host, body, true)
}

fn create_entry_attempt<H: Host + ?Sized>(host: &H, body: &Value, retry: bool) -> Result<Outcome> {
    let Some(input) = body.as_object() else {
        return Ok(Err(input::invalid("Input must be an object")));
    };
    let today = today(host)?;
    let id = ask!(input::operation_id(input, "operationId"));
    let account_id = ask!(input::required_string(input, "accountId", Some(128)));
    let name = ask!(input::required_string(input, "name", Some(640)));
    let name = name.trim_matches(input::is_js_space).to_owned();
    if name.is_empty() {
        return Ok(Err(input::invalid("name is required")));
    }
    let amount = ask!(input::int(input, "amountCents"));
    if amount == 0 {
        return Ok(Err(input::invalid("amountCents must be nonzero")));
    }
    let category = ask!(input::string(input, "categoryId", false, None)).filter(|c| !c.is_empty());
    if let Some(category) = &category {
        if !category_is_current(host, category)? {
            return Ok(Err(refuse("invalid_category", "Choose a current category; linked transfers need their separate workflow")));
        }
    }
    let currency = ask!(input::currency(input));
    let date = ask!(input::date(input, "date", &today));
    let notes = ask!(input::string(input, "notes", false, Some(4000))).unwrap_or_default();
    let cleared = ask!(input::bool_(input, "cleared"));

    let mut ordered = Map::new();
    ordered.insert("id".into(), json!(id));
    ordered.insert("accountId".into(), json!(account_id));
    ordered.insert("name".into(), json!(name));
    ordered.insert("amountCents".into(), json!(amount));
    ordered.insert("categoryId".into(), json!(category));
    ordered.insert("isoCurrency".into(), json!(currency));
    ordered.insert("date".into(), json!(date));
    ordered.insert("notes".into(), json!(notes));
    ordered.insert("cleared".into(), json!(cleared));
    let digest = digest(&ordered)?;

    if let Some(prior) = first(host, TRANSACTIONS, Filter::eq("id", id.clone()))? {
        let same = prior["source"] == "manual" && prior["entry_digest"] == json!(digest);
        return Ok(if same { done(&id, true) } else { failed("conflict") });
    }
    let account = first(host, ACCOUNTS, Filter::And {
        filters: vec![Filter::eq("account_id", account_id.clone()), Filter::eq("source", "manual")],
    })?;
    let Some(account) = account else { return Ok(failed("unavailable")) };
    if !account["archived_at"].is_null() || account["iso_currency"] != json!(currency) {
        return Ok(failed("unavailable"));
    }
    if date.as_str() < account["opening_date"].as_str().unwrap_or("") {
        return Ok(failed("invalid_date"));
    }
    if account["last_reconciled_date"].as_str().is_some_and(|last| date.as_str() <= last) {
        return Ok(failed("reconciled_period"));
    }
    let balance = account["balance_cents"].as_i64().ok_or_else(|| Error::new("Invalid balance"))?;
    let sign: i128 = if matches!(account["type"].as_str(), Some("credit" | "loan")) { 1 } else { -1 };
    let moved = i128::from(balance) + sign * i128::from(amount);
    if moved.abs() > i128::from(MAX_SAFE) {
        return Ok(failed("overflow"));
    }
    let revision = account["ledger_revision"].as_i64().unwrap_or(0);
    let at = text(host, "call", "read", "now")?;
    let changed = Client(host).query(
        ACCOUNTS,
        &Query::update(
            Filter::And {
                filters: vec![
                    Filter::eq("account_id", account_id.clone()),
                    Filter::eq("source", "manual"),
                    Filter::eq("ledger_revision", revision),
                ],
            },
            values(vec![
                ("balance_cents", json!(moved as i64)),
                ("ledger_revision", json!(revision + 1)),
                ("updated_at", json!(at)),
            ]),
        ),
    )?;
    if changed.is_empty() {
        if retry {
            return create_entry_attempt(host, body, false);
        }
        return Err(Error::new("The account changed during the save"));
    }
    let row = values(vec![
        ("id", json!(id)),
        ("account_id", json!(account_id)),
        ("date", json!(date)),
        ("name", json!(name)),
        ("amount_cents", json!(amount)),
        ("iso_currency", json!(currency)),
        ("category_id", json!(category)),
        ("notes", if notes.is_empty() { Value::Null } else { json!(notes) }),
        ("pending", json!(false)),
        ("categorized_by", json!("user")),
        ("review_state", json!(if category.is_none() { "needs_look" } else { "confirmed" })),
        ("source", json!("manual")),
        ("entry_digest", json!(digest)),
        ("cleared", json!(cleared)),
    ]);
    Client(host).query(TRANSACTIONS, &Query::insert(row))?;
    log(host, "transaction.create", json!({"accountId":account_id,"transactionId":id}))?;
    Ok(done(&id, false))
}
