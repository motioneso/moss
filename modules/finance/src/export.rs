//! `finance.transactions.export`. A spreadsheet of the person's own transaction history.
//!
//! Only the caller's rows are read, so another person's shared rows never reach the file.
//! Cells that could run as spreadsheet formulas are quoted with a leading apostrophe.
use crate::input::{self, MAX_SAFE};
use crate::ledger::{text as host_text, Outcome, ACCOUNTS, TRANSACTIONS};
use crate::shared;
use moss_module_sdk::{
    query::{Compare, Filter},
    Host, Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const TRANSFER_CORRECTIONS: &str = "app.finance_transfer_corrections";
const MAX_ROWS: usize = 5000;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const HEADER: &str = "Date,Payee,Account,Account ID,Category,Category ID,Outflow,Inflow,Currency,Status,Cleared,Reconciled at,Transaction ID,Allocations,Allocation status,Transfer ID,Corrects transfer ID,Corrected by transfer ID";

/// Quoted text. A leading formula or control character gets an apostrophe in front.
pub fn csv_text(value: &str) -> String {
    let lead = value.trim_start_matches(|c: char| c.is_whitespace()).chars().next();
    let first = value.chars().next();
    let risky = matches!(lead, Some('=' | '+' | '-' | '@')) || matches!(first, Some('\t' | '\r' | '\n'));
    let safe = if risky { format!("'{value}") } else { value.to_owned() };
    format!("\"{}\"", safe.replace('"', "\"\""))
}

/// Cents as a plain decimal such as `-12.05`.
pub fn amount_input(cents: i64) -> String {
    let abs = cents.unsigned_abs();
    format!("{}{}.{:02}", if cents < 0 { "-" } else { "" }, abs / 100, abs % 100)
}

fn int(v: &Value) -> i64 {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

/// The file for rows already read. Transfers carry the ids of the rows they correct.
pub fn csv(
    rows: &[Value],
    accounts: &BTreeMap<String, String>,
    categories: &BTreeMap<String, String>,
    corrects: &BTreeMap<String, String>,
    corrected_by: &BTreeMap<String, String>,
) -> String {
    let mut lines = vec![HEADER.to_owned()];
    for row in rows {
        let cents = int(&row["amount_cents"]).clamp(-MAX_SAFE, MAX_SAFE);
        let account = text(row, "account_id");
        let category = row["category_id"].as_str();
        let parts: Vec<(String, i64)> = row["splits"]
            .as_array()
            .map(|a| a.iter().map(|p| (text(p, "categoryId").to_owned(), int(&p["amountCents"]))).collect())
            .unwrap_or_default();
        let allocated: i64 = parts.iter().map(|p| p.1).sum();
        let transfer = text(row, "transfer_id");
        let split_text = parts
            .iter()
            .map(|(id, amount)| {
                let name = categories.get(id).map_or(id.as_str(), String::as_str);
                format!("{name} [{id}]: {} {}", amount_input(*amount), text(row, "iso_currency"))
            })
            .collect::<Vec<_>>()
            .join("; ");
        let category_name = if parts.is_empty() {
            category.and_then(|c| categories.get(c).map(String::as_str)).or(category).unwrap_or("Uncategorized")
        } else {
            "Split"
        };
        let cleared = if row["source"] == "manual" {
            match row["cleared"].as_bool() {
                Some(true) => "Yes",
                Some(false) => "No",
                None => "Not tracked",
            }
        } else {
            "Not tracked"
        };
        let cells = [
            csv_text(text(row, "date")),
            csv_text(text(row, "name")),
            csv_text(accounts.get(account).map_or(account, String::as_str)),
            csv_text(account),
            csv_text(category_name),
            csv_text(category.unwrap_or("")),
            if cents >= 0 { amount_input(cents) } else { String::new() },
            if cents < 0 { amount_input(-cents) } else { String::new() },
            csv_text(text(row, "iso_currency")),
            csv_text(if row["pending"] == true { "Pending" } else { "Posted" }),
            csv_text(cleared),
            csv_text(text(row, "reconciled_at")),
            csv_text(text(row, "id")),
            csv_text(&split_text),
            csv_text(if parts.is_empty() { "None" } else if allocated == cents { "Balanced" } else { "Unbalanced" }),
            csv_text(transfer),
            csv_text(corrects.get(transfer).map_or("", String::as_str)),
            csv_text(corrected_by.get(transfer).map_or("", String::as_str)),
        ];
        lines.push(cells.join(","));
    }
    lines.join("\r\n") + "\r\n"
}

fn map_of(rows: &[Value], key: &str, value: &str) -> BTreeMap<String, String> {
    rows.iter().filter_map(|r| Some((r[key].as_str()?.to_owned(), r[value].as_str()?.to_owned()))).collect()
}

pub fn run<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let from = ask!(input::string(input, "from", false, None));
    let through = ask!(input::string(input, "through", false, None));
    let account = ask!(input::string(input, "accountId", false, None));
    let bad_date = |d: &Option<String>| d.as_deref().is_some_and(|d| !input::is_calendar_date(d));
    if bad_date(&from) || bad_date(&through) || matches!((&from, &through), (Some(f), Some(t)) if f > t) {
        return Ok(Err(input::invalid("Choose valid inclusive export dates, with the start on or before the end")));
    }
    if account.as_deref().is_some_and(|a| a.trim().is_empty() || a.len() > 256) {
        return Ok(Err(input::invalid("Choose a valid owned account")));
    }
    let mut filters = vec![Filter::Owned];
    if let Some(f) = &from {
        filters.push(Filter::Compare { column: "date".into(), op: Compare::Ge, value: json!(f) });
    }
    if let Some(t) = &through {
        filters.push(Filter::Compare { column: "date".into(), op: Compare::Le, value: json!(t) });
    }
    if let Some(a) = &account {
        filters.push(Filter::eq("account_id", a.clone()));
    }
    let mut rows = shared::pages(host, TRANSACTIONS, Filter::And { filters }, &["date", "id"])?;
    let total = rows.len();
    if total > MAX_ROWS {
        return Ok(Ok(json!({"status":"too_many","totalCount":total,"maxRows":MAX_ROWS})));
    }
    rows.sort_by(|a, b| text(b, "date").cmp(text(a, "date")).then(text(a, "id").cmp(text(b, "id"))));
    let accounts = map_of(&shared::pages(host, ACCOUNTS, Filter::Owned, &["account_id"])?, "account_id", "name");
    let categories = map_of(&shared::pages(host, crate::budget::CATEGORIES, Filter::Owned, &["id"])?, "id", "name");
    let fixes = shared::pages(host, TRANSFER_CORRECTIONS, Filter::Owned, &["correction_transfer_id"])?;
    let corrects = map_of(&fixes, "correction_transfer_id", "original_transfer_id");
    let corrected_by = map_of(&fixes, "original_transfer_id", "correction_transfer_id");
    let file = csv(&rows, &accounts, &categories, &corrects, &corrected_by);
    if file.len() > MAX_BYTES {
        return Ok(Ok(json!({"status":"too_large","totalCount":total,"maxBytes":MAX_BYTES})));
    }
    Ok(Ok(json!({
        "status": "ready", "csv": file, "totalCount": total,
        "scope": {"from": from, "through": through, "accountId": account}, "preparedAt": host_text(host, "call", "read", "now")?,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formula_cells_are_defused_and_quotes_doubled() {
        assert_eq!(csv_text("=SUM(A1)"), "\"'=SUM(A1)\"");
        assert_eq!(csv_text("  -5"), "\"'  -5\"");
        assert_eq!(csv_text("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_text("plain"), "\"plain\"");
    }

    #[test]
    fn amounts_keep_two_places() {
        assert_eq!(amount_input(1205), "12.05");
        assert_eq!(amount_input(-7), "-0.07");
    }

    #[test]
    fn rows_split_outflow_and_inflow_and_name_the_parts() {
        let rows = vec![
            json!({"id":"t1","account_id":"a1","date":"2026-11-02","amount_cents":1200,"iso_currency":"USD","name":"Shop","category_id":"groceries","pending":false,"splits":[],"transfer_id":null}),
            json!({"id":"t2","account_id":"a1","date":"2026-11-03","amount_cents":-500,"iso_currency":"USD","name":"Pay","category_id":null,"pending":true,
                "splits":[{"categoryId":"income","amountCents":-300},{"categoryId":"other","amountCents":-100}],"transfer_id":null}),
        ];
        let accounts = BTreeMap::from([("a1".to_owned(), "Checking".to_owned())]);
        let categories = BTreeMap::from([("groceries".to_owned(), "Groceries".to_owned()), ("income".to_owned(), "Income".to_owned())]);
        let out = csv(&rows, &accounts, &categories, &BTreeMap::new(), &BTreeMap::new());
        let lines: Vec<&str> = out.split("\r\n").collect();
        assert_eq!(lines[0], HEADER);
        assert!(lines[1].starts_with("\"2026-11-02\",\"Shop\",\"Checking\",\"a1\",\"Groceries\",\"groceries\",12.00,,"));
        assert!(lines[2].contains(",,5.00,"));
        assert!(lines[2].contains("Income [income]: -3.00 USD; other [other]: -1.00 USD"));
        assert!(lines[2].contains("\"Unbalanced\""));
        assert!(out.ends_with("\r\n"));
    }
}
