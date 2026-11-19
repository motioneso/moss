//! Finance sections of the whole-account export and delete. Both act only on the caller's rows.
//! Delete removes children before parents, so a half-finished delete never leaves a row that
//! points at a missing parent.
//!
//! The export leaves out the bank link rows (they name a credential slot) and the link sessions
//! (they hold a one-use link token). The household mirror rows copy data already in the export.
use crate::{bank, plaid};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Api {
    name: String,
    parameters: Value,
}

/// Every owned table, children first, with the columns that order its rows for paging.
pub const TABLES: [(&str, &[&str]); 28] = [
    ("app.finance_shared_transactions", &["id"]),
    ("app.finance_shared_accounts", &["account_id"]),
    ("app.finance_provider_handoffs", &["item_id", "transaction_id"]),
    ("app.finance_transfer_corrections", &["original_transfer_id"]),
    ("app.finance_manual_transfers", &["id"]),
    ("app.finance_reconciliations", &["id"]),
    ("app.finance_activity", &["id"]),
    ("app.finance_merchant_rules", &["id"]),
    ("app.finance_imports", &["id"]),
    ("app.finance_bill_adjustments", &["plan_id", "due_date"]),
    ("app.finance_bill_occurrences", &["plan_id", "due_date"]),
    ("app.finance_bill_suggestion_dismissals", &["account_id", "payee_key", "cadence", "amount_cents"]),
    ("app.finance_bill_plans", &["id"]),
    ("app.finance_budget_draft_lines", &["draft_id", "category_key"]),
    ("app.finance_budget_drafts", &["id"]),
    ("app.finance_card_assignments", &["account_id", "month"]),
    ("app.finance_card_policies", &["account_id"]),
    ("app.finance_flex_policies", &["month"]),
    ("app.finance_targets", &["category_id", "effective_month"]),
    ("app.finance_budget_assignments", &["month", "category_id"]),
    ("app.finance_budget_policy", &["owner_user_id"]),
    ("app.finance_balance_snapshots", &["account_id", "day"]),
    ("app.finance_transactions", &["id"]),
    ("app.finance_bank_links", &["item_id"]),
    ("app.finance_link_sessions", &["link_token"]),
    ("app.finance_accounts", &["account_id"]),
    ("app.finance_items", &["item_id"]),
    ("app.finance_categories", &["id"]),
];

/// Tables kept out of the export. The module comment says why.
const NOT_EXPORTED: [&str; 4] = [
    "app.finance_bank_links",
    "app.finance_link_sessions",
    "app.finance_shared_accounts",
    "app.finance_shared_transactions",
];

/// Rows per page. The host cuts an unpaged read at 1000 rows, so the export pages below that.
const PAGE: u32 = 500;

fn read_table<H: Host + ?Sized>(client: &Client<'_, H>, table: &str, key: &[&str]) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    loop {
        let mut query = Query::select(Filter::Owned);
        query.order =
            key.iter().map(|column| Order { column: (*column).to_owned(), descending: false }).collect();
        query.limit = Some(PAGE);
        query.offset = rows.len() as u32;
        let page = client.query(table, &query)?;
        let full = page.len() as u32 == PAGE;
        rows.extend(page);
        if !full {
            return Ok(rows);
        }
    }
}

fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let mut out = Map::new();
    for (table, key) in TABLES.iter().rev() {
        if NOT_EXPORTED.contains(table) {
            continue;
        }
        let name = table.trim_start_matches("app.finance_");
        out.insert(name.to_owned(), Value::Array(read_table(&client, table, key)?));
    }
    Ok(Value::Object(out))
}

/// Drops each stored bank token, then every owned row.
fn delete_all<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    for link in read_table(&client, bank::LINKS, &["item_id"])? {
        if let Some(slot) = link["slot"].as_str().filter(|s| !s.is_empty()) {
            plaid::forget(host, slot)?;
        }
    }
    let mut removed = 0;
    for (table, _) in TABLES {
        removed += client.query(table, &Query::delete(Filter::Owned))?.len();
    }
    Ok(json!({"deleted": removed}))
}

pub fn execute<H: Host + ?Sized>(host: &H, api: Api) -> Result<Value> {
    if api.parameters != json!({}) {
        return Err(Error::new("Account operation takes no parameters"));
    }
    match api.name.as_str() {
        "collectFinanceExportSection" => collect(host),
        "deleteFinanceAccountData" => delete_all(host),
        _ => Err(Error::new("Unknown Finance API")),
    }
}
