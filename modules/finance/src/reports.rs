//! Spending and net-worth reports and the month detail list behind them. Read only.
//!
//! Transfers between a person's own accounts never count as spending or income. Other people's
//! shared accounts appear as separate series and rows, one owner at a time, and only through the
//! household mirror, so a report never shows more than sharing allows. Net worth is the person's
//! own accounts only, because balance history is never shared.
use crate::budget::{self, row_of};
use crate::envelope;
use crate::input::{self, refuse, Refusal, MAX_SAFE};
use crate::ledger::{today, Outcome, ACCOUNTS, TRANSACTIONS};
use crate::shared;
use crate::transactions::splits_of;
use moss_module_sdk::{
    query::{Compare, Filter},
    Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_MONTHS: i64 = 24;

fn month_of(date: &str) -> &str {
    date.get(0..7).unwrap_or("")
}

fn shift(month: &str, by: i32) -> String {
    let y: i32 = month[0..4].parse().unwrap_or(1970);
    let m: i32 = month[5..7].parse().unwrap_or(1);
    let index = y * 12 + (m - 1) + by;
    format!("{:04}-{:02}", index.div_euclid(12), index.rem_euclid(12) + 1)
}

/// Ascending months ending in the month of `today`.
pub fn window(today: &str, months: usize) -> Vec<String> {
    let last = month_of(today).to_owned();
    (0..months as i32).rev().map(|back| shift(&last, -back)).collect()
}

struct Params {
    months: usize,
    currency: Option<String>,
}

fn is_currency(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())
}

fn params(input: &Map<String, Value>) -> std::result::Result<Params, Refusal> {
    let months = match input.get("months") {
        None | Some(Value::Null) => 6,
        Some(v) => match v.as_i64() {
            Some(n) if (1..=MAX_MONTHS).contains(&n) => n,
            _ => return Err(input::invalid("months must be an integer from 1 to 24")),
        },
    };
    let currency = input::string(input, "currency", false, Some(3))?;
    if currency.as_deref().is_some_and(|c| !is_currency(c)) {
        return Err(input::invalid("currency must be a three letter code"));
    }
    Ok(Params { months: months as usize, currency })
}

/// The currency a report covers. Several currencies without a choice leave the choice to the person.
fn scope(seen: &BTreeSet<String>, wanted: &Option<String>) -> (Vec<String>, Option<String>, bool) {
    let list: Vec<String> = seen.iter().cloned().collect();
    match wanted {
        Some(c) => (list, Some(c.clone()), false),
        None if list.len() > 1 => (list, None, true),
        None => {
            let only = list.first().cloned();
            (list, only, false)
        }
    }
}

fn checked(v: i128) -> std::result::Result<i64, Refusal> {
    if v.abs() > i128::from(MAX_SAFE) {
        return Err(refuse("unsafe_money", "A report total is too large"));
    }
    Ok(v as i64)
}

fn payee(row: &Value) -> String {
    row["merchant"].as_str().or(row["name"].as_str()).unwrap_or("").to_owned()
}

fn cents(row: &Value) -> i64 {
    row["amount_cents"].as_i64().unwrap_or(0)
}

/// Every row of one owner, with the ones that are transfers marked.
fn transfers(rows: &[&Value]) -> BTreeSet<String> {
    let owned: Vec<envelope::Row> = rows.iter().map(|r| row_of(r)).collect();
    envelope::transfer_ids(&owned)
}

#[derive(Default)]
struct Month {
    category: BTreeMap<String, i128>,
    payee: BTreeMap<String, i128>,
    income: i128,
    outflow: i128,
}

fn month_json(month: &str, m: &Month) -> std::result::Result<Value, Refusal> {
    let map = |src: &BTreeMap<String, i128>| -> std::result::Result<Value, Refusal> {
        let mut out = Map::new();
        for (k, v) in src {
            out.insert(k.clone(), json!(checked(*v)?));
        }
        Ok(Value::Object(out))
    };
    Ok(json!({
        "month": month, "byCategory": map(&m.category)?, "byPayee": map(&m.payee)?,
        "cashFlow": {"incomeCents": checked(m.income)?, "outflowCents": checked(m.outflow)?, "netCents": checked(m.income - m.outflow)?},
    }))
}

fn spend(rows: &[&Value], window: &[String], currency: &str) -> std::result::Result<Vec<Value>, Refusal> {
    let skip = transfers(rows);
    let mut months: BTreeMap<&str, Month> = window.iter().map(|m| (m.as_str(), Month::default())).collect();
    for row in rows {
        let id = row["id"].as_str().unwrap_or("");
        let Some(month) = months.get_mut(month_of(row["date"].as_str().unwrap_or(""))) else { continue };
        if skip.contains(id) || row["iso_currency"] != currency {
            continue;
        }
        let parent = row_of(row);
        for (category, amount) in envelope::allocations(&parent) {
            if category.as_deref() == Some("income") {
                month.income -= i128::from(amount);
                continue;
            }
            month.outflow += i128::from(amount);
            *month.category.entry(category.unwrap_or_else(|| "uncategorized".into())).or_default() += i128::from(amount);
            *month.payee.entry(payee(row)).or_default() += i128::from(amount);
        }
    }
    window.iter().map(|m| month_json(m, &months[m.as_str()])).collect()
}

fn in_window(row: &Value, window: &[String]) -> bool {
    window.iter().any(|m| m == month_of(row["date"].as_str().unwrap_or("")))
}

fn between(from_month: &str, to_month: &str) -> Filter {
    Filter::And {
        filters: vec![
            Filter::Compare { column: "date".into(), op: Compare::Ge, value: json!(format!("{from_month}-01")) },
            Filter::Compare { column: "date".into(), op: Compare::Lt, value: json!(format!("{to_month}-01")) },
        ],
    }
}

/// The spending report for rows already loaded. Rows run from the month before the window.
pub fn spending_from(own: &[Value], other: &[Value], window: &[String], wanted: &Option<String>) -> std::result::Result<Value, Refusal> {
    let seen: BTreeSet<String> =
        own.iter().chain(other).filter(|r| in_window(r, window)).filter_map(|r| r["iso_currency"].as_str().map(str::to_owned)).collect();
    let (currencies, currency, required) = scope(&seen, wanted);
    let mut out = json!({
        "window": window, "currencies": currencies, "currency": currency, "currencySelectionRequired": required,
        "own": [], "shared": [],
    });
    let Some(code) = currency.filter(|_| !required) else { return Ok(out) };
    out["own"] = json!(spend(&own.iter().collect::<Vec<_>>(), window, &code)?);
    let mut owners: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for row in other {
        owners.entry(row["owner_user_id"].as_str().unwrap_or("")).or_default().push(row);
    }
    let mut shared = Vec::new();
    for (owner, rows) in owners {
        if !rows.iter().any(|r| in_window(r, window)) {
            continue;
        }
        shared.push(json!({"ownerUserId": owner, "months": spend(&rows, window, &code)?}));
    }
    out["shared"] = json!(shared);
    Ok(out)
}

fn named<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>> {
    Ok(crate::accounts::categories(host)?.iter().map(|c| json!({"id": c.id, "name": c.name})).collect())
}

fn parse<H: Host + ?Sized>(host: &H, body: &Value) -> Result<std::result::Result<(Params, String, Vec<String>), Refusal>> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let p = match params(input) {
        Ok(p) => p,
        Err(r) => return Ok(Err(r)),
    };
    let day = today(host)?;
    let w = window(&day, p.months);
    Ok(Ok((p, day, w)))
}

/// `finance.reports.spending`.
pub fn spending<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let (p, _, w) = match parse(host, body)? {
        Ok(v) => v,
        Err(r) => return Ok(Err(r)),
    };
    let (from, to) = (shift(&w[0], -1), shift(&w[w.len() - 1], 1));
    let own = shared::pages(host, TRANSACTIONS, between(&from, &to), &["id"])?;
    let other = shared::window_rows(host, Some((&format!("{from}-01"), &format!("{to}-01"))))?;
    let mut out = match spending_from(&own, &other, &w, &p.currency) {
        Ok(v) => v,
        Err(r) => return Ok(Err(r)),
    };
    out["categories"] = json!(named(host)?);
    Ok(Ok(out))
}

struct Series {
    points: Vec<(String, i64)>,
    coverage: Vec<Value>,
}

enum Fail {
    History,
    Unsafe,
}

fn net_worth_series(accounts: &[Value], snaps: &[Value], manual: &[Value], today: &str, window: &[String]) -> std::result::Result<Series, Fail> {
    let kind: BTreeMap<&str, (&Value, i128)> =
        accounts.iter().filter_map(|a| Some((a["account_id"].as_str()?, (a, budget::sign(a["type"].as_str().unwrap_or("")))))).collect();
    let mut lists: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    let mut coverage: Vec<Value> = Vec::new();
    let mut has_ledger = false;
    for s in snaps {
        let (Some(id), Some(day)) = (s["account_id"].as_str(), s["day"].as_str()) else { continue };
        let Some((account, _)) = kind.get(id) else { continue };
        if account["source"] == "manual" || day > today {
            continue;
        }
        let balance = s["balance_cents"].as_i64().filter(|b| b.abs() <= MAX_SAFE).ok_or(Fail::Unsafe)?;
        lists.entry(id.to_owned()).or_default().insert(day.to_owned(), balance);
    }
    for account in accounts {
        let id = account["account_id"].as_str().unwrap_or("");
        let is_manual = account["source"] == "manual";
        let mut item = json!({
            "accountId": id, "name": account["name"], "source": if is_manual { "ledger" } else { "snapshot" },
            "asOf": null, "balanceCents": null, "contributionCents": null, "included": false,
        });
        if is_manual {
            let opening = account["opening_date"].as_str().filter(|d| input::is_calendar_date(d));
            let (Some(opening), Some(start)) = (opening, account["opening_balance_cents"].as_i64()) else {
                item["reason"] = json!("opening_missing");
                coverage.push(item);
                continue;
            };
            if opening > today {
                item["reason"] = json!("not_open");
                coverage.push(item);
                continue;
            }
            let mut events: BTreeMap<String, i128> = BTreeMap::from([(opening.to_owned(), 0)]);
            for m in manual.iter().filter(|m| m["account_id"] == id) {
                let day = m["date"].as_str().unwrap_or("");
                if day > today {
                    continue;
                }
                if m["iso_currency"] != account["iso_currency"] || day < opening {
                    return Err(Fail::History);
                }
                *events.entry(day.to_owned()).or_default() += i128::from(cents(m));
            }
            let sign = kind[id].1;
            let mut balance = i128::from(start);
            for (day, amount) in events {
                balance -= sign * amount;
                if balance.abs() > i128::from(MAX_SAFE) {
                    return Err(Fail::Unsafe);
                }
                lists.entry(id.to_owned()).or_default().insert(day, balance as i64);
            }
            item["asOf"] = json!(today);
            has_ledger = true;
        }
        coverage.push(item);
    }
    let mut days: BTreeSet<String> = lists.values().flat_map(|l| l.keys()).filter(|d| window.iter().any(|m| m == month_of(d))).cloned().collect();
    if has_ledger {
        if let Some(first) = window.first() {
            for day in [format!("{first}-01"), today.to_owned()] {
                if window.iter().any(|m| m == month_of(&day)) && lists.values().any(|l| l.keys().next().is_some_and(|k| *k <= day)) {
                    days.insert(day);
                }
            }
        }
    }
    let mut points = Vec::new();
    for day in &days {
        let mut total: i128 = 0;
        for (id, list) in &lists {
            if let Some((_, balance)) = list.range(..=day.clone()).next_back() {
                total += i128::from(*balance) * kind[id.as_str()].1;
            }
        }
        if total.abs() > i128::from(MAX_SAFE) {
            return Err(Fail::Unsafe);
        }
        points.push((day.clone(), total as i64));
    }
    let head = points.last().map(|p| p.0.clone());
    for item in &mut coverage {
        if item.get("reason").is_some() {
            continue;
        }
        let id = item["accountId"].as_str().unwrap_or("").to_owned();
        let latest = lists.get(&id).and_then(|l| l.iter().rfind(|(d, _)| head.as_ref().is_none_or(|h| *d <= h)));
        let Some((date, balance)) = latest else {
            item["reason"] = json!("no_snapshot");
            continue;
        };
        if item["source"] == "snapshot" {
            item["asOf"] = json!(date);
        }
        item["balanceCents"] = json!(balance);
        match &head {
            Some(_) => {
                item["contributionCents"] = json!(i128::from(*balance) * kind[id.as_str()].1);
                item["included"] = json!(true);
            }
            None => item["reason"] = json!("outside_period"),
        }
    }
    Ok(Series { points, coverage })
}

/// The net-worth report for accounts and history already loaded.
pub fn net_worth_from(accounts: &[Value], snaps: &[Value], manual: &[Value], today: &str, window: &[String], wanted: &Option<String>) -> Value {
    let seen: BTreeSet<String> = accounts.iter().filter_map(|a| a["iso_currency"].as_str().map(str::to_owned)).collect();
    let (currencies, currency, required) = scope(&seen, wanted);
    let mut out = json!({
        "window": window, "currencies": currencies, "currency": currency, "currencySelectionRequired": required,
        "points": [], "headlineCents": null, "asOf": null, "coverage": [],
    });
    let Some(code) = currency.filter(|_| !required) else { return out };
    let mine: Vec<Value> = accounts.iter().filter(|a| a["iso_currency"] == code.as_str()).cloned().collect();
    match net_worth_series(&mine, snaps, manual, today, window) {
        Ok(s) => {
            out["points"] = json!(s.points.iter().map(|(d, t)| json!({"date": d, "totalCents": t})).collect::<Vec<_>>());
            out["headlineCents"] = json!(s.points.last().map(|p| p.1));
            out["asOf"] = json!(s.points.last().map(|p| p.0.clone()));
            out["coverage"] = json!(s.coverage);
        }
        Err(Fail::History) => out["unavailableReason"] = json!("invalid_history"),
        Err(Fail::Unsafe) => out["unavailableReason"] = json!("unsafe_money"),
    }
    out
}

/// `finance.reports.net-worth`.
pub fn net_worth<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let (p, day, w) = match parse(host, body)? {
        Ok(v) => v,
        Err(r) => return Ok(Err(r)),
    };
    let accounts = shared::pages(host, ACCOUNTS, Filter::All, &["account_id"])?;
    let snaps = shared::pages(host, budget::SNAPSHOTS, Filter::All, &["account_id", "day"])?;
    let manual = shared::pages(host, TRANSACTIONS, Filter::And { filters: vec![Filter::eq("source", "manual"), Filter::eq("pending", false)] }, &["id"])?;
    Ok(Ok(net_worth_from(&accounts, &snaps, &manual, &day, &w, &p.currency)))
}

/// Parts of one row that belong to a group.
fn parts_for(row: &Value, group: &str, key: &str) -> Option<(i128, bool)> {
    let parent = row_of(row);
    let balanced = !splits_of(row).is_empty() && splits_of(row).iter().map(|p| p.1).sum::<i64>() == cents(row);
    let mut total: i128 = 0;
    let mut hit = false;
    for (category, amount) in envelope::allocations(&parent) {
        let income = category.as_deref() == Some("income");
        let matched = match group {
            "income" => income,
            "outflow" => !income,
            "category" => !income && category.as_deref().unwrap_or("uncategorized") == key,
            _ => !income && payee(row) == key,
        };
        if matched {
            hit = true;
            total += if income { -i128::from(amount) } else { i128::from(amount) };
        }
    }
    hit.then_some((total, balanced))
}

fn optional_range(input: &Map<String, Value>, key: &str, low: i64, high: i64, default: i64) -> std::result::Result<i64, Refusal> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => match v.as_i64() {
            Some(n) if (low..=high).contains(&n) => Ok(n),
            _ => Err(input::invalid(format!("{key} must be an integer from {low} to {high}"))),
        },
    }
}

/// `finance.reports.transactions`. The rows behind one number of a monthly report.
pub fn details<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(input::required_string(input, "month", Some(7)));
    let currency = ask!(input::required_string(input, "currency", Some(3)));
    if !is_currency(&currency) {
        return Ok(Err(input::invalid("currency must be a three letter code")));
    }
    let group = input::string(input, "group", false, Some(16));
    let group = ask!(group).unwrap_or_else(|| "outflow".into());
    if !["category", "payee", "income", "outflow"].contains(&group.as_str()) {
        return Ok(Err(input::invalid("group is unsupported")));
    }
    let key = ask!(input::string(input, "key", group == "category" || group == "payee", Some(2000))).unwrap_or_default();
    let offset = ask!(optional_range(input, "offset", 0, 1_000_000, 0)) as usize;
    let limit = ask!(optional_range(input, "limit", 1, 200, 50)) as usize;
    let months = ask!(optional_range(input, "months", 1, MAX_MONTHS, 6)) as usize;
    let mut owners: BTreeSet<String> = BTreeSet::new();
    if let Some(list) = input.get("sharedOwnerIds") {
        let Some(list) = list.as_array().filter(|l| l.len() <= 100) else {
            return Ok(Err(input::invalid("sharedOwnerIds must be a list of at most 100 ids")));
        };
        for id in list {
            match id.as_str().filter(|s| !s.is_empty() && s.len() <= 64) {
                Some(s) => owners.insert(s.to_owned()),
                None => return Ok(Err(input::invalid("sharedOwnerIds holds an invalid id"))),
            };
        }
    }
    let day = today(host)?;
    if !window(&day, months).contains(&month) || month.len() != 7 {
        return Ok(Err(refuse("report_scope_changed", "That month is outside the report window")));
    }
    let (from, to) = (shift(&month, -1), shift(&month, 1));
    let own = shared::pages(host, TRANSACTIONS, between(&from, &to), &["id"])?;
    let other = shared::window_rows(host, Some((&format!("{from}-01"), &format!("{to}-01"))))?;
    let names: BTreeMap<String, String> = shared::pages(host, ACCOUNTS, Filter::All, &["account_id"])?
        .iter()
        .filter_map(|a| Some((a["account_id"].as_str()?.to_owned(), a["name"].as_str()?.to_owned())))
        .collect();
    let me = shared::actor(host)?;
    Ok(Ok(details_from(&own, &other, &me, &names, &month, &currency, &group, &key, &owners, offset, limit)))
}

#[allow(clippy::too_many_arguments)]
pub fn details_from(
    own: &[Value],
    other: &[Value],
    me: &str,
    names: &BTreeMap<String, String>,
    month: &str,
    currency: &str,
    group: &str,
    key: &str,
    owners: &BTreeSet<String>,
    offset: usize,
    limit: usize,
) -> Value {
    let mut groups: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for r in own {
        groups.entry("").or_default().push(r);
    }
    for r in other.iter().filter(|r| owners.contains(r["owner_user_id"].as_str().unwrap_or(""))) {
        groups.entry(r["owner_user_id"].as_str().unwrap_or("")).or_default().push(r);
    }
    let mut rows: Vec<(String, String, String, Value)> = Vec::new();
    let mut total: i128 = 0;
    for (owner, list) in &groups {
        let skip = transfers(list);
        for row in list {
            let id = row["id"].as_str().unwrap_or("");
            if month_of(row["date"].as_str().unwrap_or("")) != month || skip.contains(id) || row["iso_currency"] != currency {
                continue;
            }
            let Some((amount, split)) = parts_for(row, group, key) else { continue };
            let is_shared = !owner.is_empty();
            total += amount;
            let account = row["account_id"].as_str().unwrap_or("");
            let account_name = if is_shared { "Shared account".to_owned() } else { names.get(account).cloned().unwrap_or_else(|| "Unavailable account".into()) };
            let has_parts = !splits_of(row).is_empty();
            let view = json!({
                "id": id, "ownerUserId": if is_shared { (*owner).to_owned() } else { me.to_owned() }, "shared": is_shared,
                "accountId": account, "accountName": account_name, "date": row["date"], "name": payee(row),
                "amountCents": amount as i64, "parentAmountCents": cents(row), "isoCurrency": row["iso_currency"],
                "pending": row["pending"] == true, "splitPortion": split, "splitNeedsReview": has_parts && !split,
            });
            rows.push((row["date"].as_str().unwrap_or("").to_owned(), (*owner).to_owned(), id.to_owned(), view));
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let count = rows.len();
    let page: Vec<Value> = rows.into_iter().skip(offset).take(limit).map(|r| r.3).collect();
    json!({
        "month": month, "currency": currency, "group": group, "rows": page, "totalCount": count,
        "totalCents": total as i64, "offset": offset, "limit": limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(id: &str, owner: &str, date: &str, amount: i64, category: &str, merchant: &str) -> Value {
        json!({"id": id, "owner_user_id": owner, "account_id": "a1", "date": date, "amount_cents": amount, "iso_currency": "USD",
            "name": merchant, "merchant": merchant, "category_id": category, "pending": false, "splits": [], "transfer_id": null})
    }

    #[test]
    fn window_ends_this_month_and_crosses_the_year() {
        assert_eq!(window("2026-02-10", 3), vec!["2025-12", "2026-01", "2026-02"]);
    }

    #[test]
    fn spending_counts_income_apart_and_skips_transfers() {
        let own = vec![
            tx("1", "me", "2026-11-02", 1200, "groceries", "Shop"),
            tx("2", "me", "2026-11-03", -5000, "income", "Pay"),
            tx("3", "me", "2026-11-04", 900, "transfers", "Move"),
        ];
        let out = spending_from(&own, &[], &window("2026-11-10", 2), &None).unwrap();
        let month = &out["own"][1];
        assert_eq!(month["byCategory"]["groceries"], 1200);
        assert_eq!(month["byPayee"]["Shop"], 1200);
        assert_eq!(month["cashFlow"], json!({"incomeCents": 5000, "outflowCents": 1200, "netCents": 3800}));
        assert!(month["byCategory"].get("transfers").is_none());
    }

    #[test]
    fn two_currencies_need_a_choice() {
        let mut eur = tx("2", "me", "2026-11-03", 100, "dining", "Cafe");
        eur["iso_currency"] = json!("EUR");
        let own = vec![tx("1", "me", "2026-11-02", 100, "dining", "Cafe"), eur];
        let out = spending_from(&own, &[], &window("2026-11-10", 1), &None).unwrap();
        assert_eq!(out["currencySelectionRequired"], true);
        assert_eq!(out["own"], json!([]));
        let chosen = spending_from(&own, &[], &window("2026-11-10", 1), &Some("EUR".into())).unwrap();
        assert_eq!(chosen["own"][0]["cashFlow"]["outflowCents"], 100);
    }

    #[test]
    fn shared_owners_are_reported_one_by_one() {
        let other = vec![tx("9", "ann", "2026-11-05", 700, "dining", "Cafe")];
        let out = spending_from(&[], &other, &window("2026-11-10", 1), &None).unwrap();
        assert_eq!(out["shared"][0]["ownerUserId"], "ann");
        assert_eq!(out["shared"][0]["months"][0]["cashFlow"]["outflowCents"], 700);
    }

    #[test]
    fn details_list_the_rows_behind_a_number() {
        let own = vec![tx("1", "me", "2026-11-02", 1200, "groceries", "Shop"), tx("2", "me", "2026-11-03", 300, "dining", "Cafe")];
        let names = BTreeMap::from([("a1".to_owned(), "Checking".to_owned())]);
        let out = details_from(&own, &[], "me", &names, "2026-11", "USD", "category", "groceries", &BTreeSet::new(), 0, 50);
        assert_eq!(out["totalCount"], 1);
        assert_eq!(out["totalCents"], 1200);
        assert_eq!(out["rows"][0]["accountName"], "Checking");
    }

    #[test]
    fn net_worth_carries_balances_and_signs_debt() {
        let accounts = vec![
            json!({"account_id": "c", "name": "Cash", "type": "depository", "source": "provider", "iso_currency": "USD"}),
            json!({"account_id": "d", "name": "Card", "type": "credit", "source": "provider", "iso_currency": "USD"}),
        ];
        let snaps = vec![
            json!({"account_id": "c", "day": "2026-11-01", "balance_cents": 10_000}),
            json!({"account_id": "d", "day": "2026-11-02", "balance_cents": 2_500}),
        ];
        let out = net_worth_from(&accounts, &snaps, &[], "2026-11-10", &window("2026-11-10", 1), &None);
        assert_eq!(out["points"], json!([{"date": "2026-11-01", "totalCents": 10_000}, {"date": "2026-11-02", "totalCents": 7_500}]));
        assert_eq!(out["headlineCents"], 7_500);
        assert_eq!(out["coverage"][1]["contributionCents"], -2_500);
    }

    #[test]
    fn manual_account_history_comes_from_its_ledger() {
        let accounts = vec![json!({"account_id": "m", "name": "Wallet", "type": "depository", "source": "manual", "iso_currency": "USD",
            "opening_date": "2026-11-01", "opening_balance_cents": 5_000})];
        let manual = vec![json!({"account_id": "m", "date": "2026-11-03", "amount_cents": 1_000, "iso_currency": "USD"})];
        let out = net_worth_from(&accounts, &[], &manual, "2026-11-10", &window("2026-11-10", 1), &None);
        assert_eq!(out["headlineCents"], 4_000);
        assert_eq!(out["coverage"][0]["asOf"], "2026-11-10");
    }

    #[test]
    fn a_movement_before_opening_makes_history_unavailable() {
        let accounts = vec![json!({"account_id": "m", "name": "Wallet", "type": "depository", "source": "manual", "iso_currency": "USD",
            "opening_date": "2026-11-05", "opening_balance_cents": 5_000})];
        let manual = vec![json!({"account_id": "m", "date": "2026-11-03", "amount_cents": 1_000, "iso_currency": "USD"})];
        let out = net_worth_from(&accounts, &[], &manual, "2026-11-10", &window("2026-11-10", 1), &None);
        assert_eq!(out["unavailableReason"], "invalid_history");
    }
}
