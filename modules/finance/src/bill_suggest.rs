//! Bill suggestions from repeating posted charges, and dismissing one
//! (`app.finance_bill_suggestion_dismissals`).
//!
//! A suggestion needs a regular run of similar amounts to one payee: three charges, or two for a
//! yearly bill. Existing plans and earlier dismissals hide a suggestion. The dismissal activity
//! row holds the account id and cadence only.
use crate::bills::{plans_of, Plan};
use crate::budget::{load, require};
use crate::envelope::day_number;
use crate::input::{self, ranged, required_string};
use crate::ledger::{log_as, text, today, values, Outcome};
use crate::recurrence::{from_day_number, Cadence};
use crate::text::normalize_payee;
use moss_module_sdk::{
    query::{Conflict, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const LOOKBACK_DAYS: i64 = 400;
pub const LIMIT: usize = 20;
const PAYEE_KEY_MAX: usize = 160;
pub const DISMISSALS: &str = "app.finance_bill_suggestion_dismissals";
const CADENCES: [&str; 4] = ["weekly", "fortnightly", "monthly", "yearly"];

pub struct Charge {
    pub id: String,
    pub account: String,
    pub date: String,
    pub name: String,
    pub merchant: Option<String>,
    pub cents: i64,
    pub category: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
    pub account: String,
    pub payee_key: String,
    pub name: String,
    pub cadence: &'static str,
    pub cents: i64,
    pub category: Option<String>,
    pub last: String,
    pub next: String,
    pub charges: usize,
}

pub struct Dismissal {
    pub account: String,
    pub payee_key: String,
    pub cadence: String,
    pub cents: i64,
}

/// The payee key a suggestion carries: cleaned, cut to the dismissal limit, end trimmed.
pub fn payee_key(text: &str) -> String {
    normalize_payee(text).chars().take(PAYEE_KEY_MAX).collect::<String>().trim_end().to_owned()
}

fn tolerance(c: &str) -> i64 {
    match c {
        "weekly" => 1,
        "fortnightly" => 2,
        "monthly" => 3,
        _ => 7,
    }
}
fn min_run(c: &str) -> usize {
    if c == "yearly" { 2 } else { 3 }
}
fn parts(day: &str) -> (i64, i64, i64) {
    let n = |r: std::ops::Range<usize>| day[r].parse::<i64>().unwrap_or(0);
    (n(0..4), n(5..7), n(8..10))
}
fn shift(day: &str, by: i64) -> String {
    from_day_number(day_number(day) + by).unwrap_or_else(|| day.to_owned())
}

/// Same day in the next period, clamped to the month's last day.
fn next_date(day: &str, cadence: &str) -> String {
    match cadence {
        "weekly" => shift(day, 7),
        "fortnightly" => shift(day, 14),
        _ => {
            let (y, m, d) = parts(day);
            let (y, m) = if cadence == "yearly" { (y + 1, m) } else if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            let last = parts(&crate::budget::last_day(&format!("{y:04}-{m:02}"))).2;
            format!("{y:04}-{m:02}-{:02}", d.min(last))
        }
    }
}
fn is_month_end(day: &str) -> bool {
    parts(day).2 == parts(&crate::budget::last_day(&day[..7])).2
}
fn next_month_end(day: &str) -> String {
    let (y, m, _) = parts(day);
    let (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    crate::budget::last_day(&format!("{y:04}-{m:02}"))
}

fn fits(previous: &str, current: &str, cadence: &str) -> bool {
    let mut expected = vec![next_date(previous, cadence)];
    if cadence == "monthly" && is_month_end(previous) {
        expected.push(next_month_end(previous));
    }
    let drift = expected.iter().map(|d| (day_number(current) - day_number(d)).abs()).min().unwrap_or(i64::MAX);
    drift <= tolerance(cadence)
}

fn median(values: &[i64]) -> i64 {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let middle = sorted.len() >> 1;
    if sorted.len() % 2 == 1 { sorted[middle] } else { (sorted[middle - 1] + sorted[middle] + 1).div_euclid(2) }
}
fn near(a: i64, b: i64, share: f64) -> bool {
    ((a - b).abs() as f64) <= (b.abs() as f64) * share
}

fn bands(sorted: &[&Charge]) -> Vec<Vec<usize>> {
    let (mut out, mut band): (Vec<Vec<usize>>, Vec<usize>) = (vec![], vec![]);
    for (i, c) in sorted.iter().enumerate() {
        let centre = if band.is_empty() { c.cents } else { median(&band.iter().map(|b| sorted[*b].cents).collect::<Vec<_>>()) };
        if !band.is_empty() && ((c.cents - centre).abs() as f64) > (centre as f64 * 0.1).max(100.0) {
            out.push(std::mem::take(&mut band));
        }
        band.push(i);
    }
    if !band.is_empty() {
        out.push(band);
    }
    out
}

fn run(dates: &[&str]) -> Option<(&'static str, usize)> {
    let last = dates.len().checked_sub(1).filter(|l| *l >= 1)?;
    let cadence = CADENCES.iter().copied().find(|c| fits(dates[last - 1], dates[last], c))?;
    let mut length = 2;
    while length <= last && fits(dates[last - length], dates[last - length + 1], cadence) {
        length += 1;
    }
    (length >= min_run(cadence)).then_some((cadence, length))
}

fn due_near(plan: &Plan, s: &Suggestion) -> bool {
    let slack = tolerance(s.cadence);
    crate::recurrence::occurrences(&plan.schedule(), &shift(&s.next, -slack), &shift(&s.next, slack)).is_some_and(|d| !d.is_empty())
}

pub fn suggest(charges: &[Charge], plans: &[Plan], dismissals: &[Dismissal], today: &str) -> Vec<Suggestion> {
    let mut groups: BTreeMap<(String, String), Vec<&Charge>> = BTreeMap::new();
    for c in charges.iter().filter(|c| c.cents > 0) {
        let key = payee_key(c.merchant.as_deref().unwrap_or(&c.name));
        if !key.is_empty() {
            groups.entry((c.account.clone(), key)).or_default().push(c);
        }
    }
    let mut found = Vec::new();
    for ((_, key), group) in &groups {
        let mut by_amount = group.clone();
        by_amount.sort_by_key(|c| c.cents);
        for band in bands(&by_amount) {
            let mut by_date: Vec<&Charge> = band.iter().map(|i| by_amount[*i]).collect();
            by_date.sort_by(|a, b| (&a.date, &a.id).cmp(&(&b.date, &b.id)));
            let dates: Vec<&str> = by_date.iter().map(|c| c.date.as_str()).collect();
            let Some((cadence, length)) = run(&dates) else { continue };
            let newest = by_date[by_date.len() - 1];
            let next = next_date(&newest.date, cadence);
            if day_number(today) - day_number(&next) > tolerance(cadence) {
                continue;
            }
            found.push(Suggestion {
                account: newest.account.clone(),
                payee_key: key.clone(),
                name: newest.merchant.as_deref().unwrap_or(&newest.name).trim().to_owned(),
                cadence,
                cents: newest.cents,
                category: newest.category.clone().filter(|c| c != "uncategorized"),
                last: newest.date.clone(),
                next,
                charges: length,
            });
        }
    }
    found.retain(|s| {
        let planned = plans.iter().any(|p| {
            p.account_id == s.account
                && (payee_key(&p.name) == s.payee_key || (p.cadence == Cadence::parse(s.cadence).unwrap_or(Cadence::Once) && near(p.amount, s.cents, 0.25) && due_near(p, s)))
        });
        let dismissed = dismissals.iter().any(|d| d.account == s.account && d.payee_key == s.payee_key && d.cadence == s.cadence && near(s.cents, d.cents, 0.25));
        !planned && !dismissed
    });
    found.sort_by(|a, b| (&a.next, &a.payee_key).cmp(&(&b.next, &b.payee_key)));
    found.truncate(LIMIT);
    found
}

/// `finance.bills.suggestions`.
pub fn read<H: Host + ?Sized>(host: &H, _body: &Value) -> Result<Outcome> {
    if crate::budget::policy_row(host)?.is_none() {
        return Ok(Ok(json!({"status":"ok","setupRequired":true})));
    }
    let policy = ask!(require(host)?);
    let book = load(host)?;
    let day = today(host)?;
    let from = shift(&day, -LOOKBACK_DAYS);
    let accounts: BTreeMap<&str, &Value> = book
        .accounts
        .iter()
        .filter(|a| a["iso_currency"] == policy.iso.as_str() && a["archived_at"].is_null())
        .filter_map(|a| Some((a["account_id"].as_str()?, &a["name"])))
        .collect();
    let claimed: std::collections::BTreeSet<&str> = book.occurrences.iter().filter_map(|o| o["transaction_id"].as_str()).collect();
    let charges: Vec<Charge> = book
        .txs
        .iter()
        .filter(|t| {
            t["date"].as_str().is_some_and(|d| d >= from.as_str() && d <= day.as_str())
                && t["pending"] != true
                && t["amount_cents"].as_i64().is_some_and(|a| a > 0)
                && t["iso_currency"] == policy.iso.as_str()
                && t["account_id"].as_str().is_some_and(|a| accounts.contains_key(a))
                && !matches!(t["category_id"].as_str(), Some("income" | "transfers"))
                && t["transfer_id"].is_null()
                && t["id"].as_str().is_some_and(|i| !claimed.contains(i))
        })
        .map(|t| Charge {
            id: t["id"].as_str().unwrap_or("").into(),
            account: t["account_id"].as_str().unwrap_or("").into(),
            date: t["date"].as_str().unwrap_or("").into(),
            name: t["name"].as_str().unwrap_or("").into(),
            merchant: t["merchant"].as_str().map(Into::into),
            cents: t["amount_cents"].as_i64().unwrap_or(0),
            category: t["category_id"].as_str().map(Into::into),
        })
        .collect();
    let plans: Vec<Plan> = plans_of(&book).into_iter().filter(|p| p.end.as_deref().is_none_or(|e| e >= day.as_str())).collect();
    let held = dismissals(host)?;
    let list = suggest(&charges, &plans, &held, &day);
    let out: Vec<Value> = list
        .iter()
        .map(|s| json!({"accountId":s.account,"payeeKey":s.payee_key,"name":s.name,"cadence":s.cadence,"amountCents":s.cents,
            "categoryId":s.category,"lastDate":s.last,"nextDate":s.next,"charges":s.charges,
            "accountName":accounts.get(s.account.as_str()).copied().cloned().unwrap_or(Value::Null)}))
        .collect();
    Ok(Ok(json!({"status":"ok","today":day,"isoCurrency":policy.iso,"suggestions":out})))
}

/// Saved dismissals. The review fingerprint ignores them, so they are read on their own.
fn dismissals<H: Host + ?Sized>(host: &H) -> Result<Vec<Dismissal>> {
    Ok(crate::budget::paged(host, DISMISSALS, &["account_id", "payee_key", "cadence", "amount_cents"])?
        .iter()
        .filter_map(|r| {
            Some(Dismissal {
                account: r["account_id"].as_str()?.into(),
                payee_key: r["payee_key"].as_str()?.into(),
                cadence: r["cadence"].as_str()?.into(),
                cents: r["amount_cents"].as_i64()?,
            })
        })
        .collect())
}

/// `finance.bills.suggestions.dismiss`.
pub fn dismiss<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let account = ask!(required_string(input, "accountId", None));
    let key = ask!(required_string(input, "payeeKey", Some(640)));
    if key.is_empty() || payee_key(&key) != key {
        return Ok(Err(input::invalid("Use the payee key from a bill suggestion")));
    }
    let cadence = ask!(required_string(input, "cadence", None));
    if !CADENCES.contains(&cadence.as_str()) {
        return Ok(Err(input::invalid("cadence must be one of weekly, fortnightly, monthly, yearly")));
    }
    let cents = ask!(ranged(input, "amountCents", 1, 100_000_000));
    if crate::ledger::first(host, crate::ledger::ACCOUNTS, moss_module_sdk::query::Filter::eq("account_id", account.as_str()))?.is_none() {
        return Ok(Err(input::invalid("Choose one of your accounts")));
    }
    let at = text(host, "call", "read", "now")?;
    let mut upsert = Query::insert(values(vec![
        ("account_id", json!(account)), ("payee_key", json!(key)), ("cadence", json!(cadence)),
        ("amount_cents", json!(cents)), ("dismissed_at", json!(at)),
    ]));
    upsert.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "account_id".into(), "payee_key".into(), "cadence".into(), "amount_cents".into()],
        values: values(vec![("dismissed_at", json!(at))]),
    };
    Client(host).query(DISMISSALS, &upsert)?;
    log_as(host, "user", "bill.suggestion-dismiss", json!({"accountId":account,"cadence":cadence}), None)?;
    Ok(Ok(json!({"status":"ok","accountId":account,"payeeKey":key,"cadence":cadence,"amountCents":cents})))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn charge(id: &str, date: &str, cents: i64) -> Charge {
        Charge { id: id.into(), account: "a".into(), date: date.into(), name: "NETFLIX 123".into(), merchant: None, cents, category: Some("subscriptions".into()) }
    }

    #[test]
    fn a_monthly_run_of_three_is_suggested_with_its_next_date() {
        let charges = [charge("1", "2026-08-05", 1599), charge("2", "2026-09-05", 1599), charge("3", "2026-10-05", 1599)];
        let got = suggest(&charges, &[], &[], "2026-11-06");
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].cadence, got[0].next.as_str(), got[0].charges, got[0].payee_key.as_str()), ("monthly", "2026-11-05", 3, "netflix"));
    }

    #[test]
    fn two_charges_are_too_few_except_yearly_and_a_lapsed_run_is_dropped() {
        assert!(suggest(&[charge("1", "2026-09-05", 1599), charge("2", "2026-10-05", 1599)], &[], &[], "2026-11-06").is_empty());
        let yearly = suggest(&[charge("1", "2025-11-05", 9900), charge("2", "2026-11-05", 9900)], &[], &[], "2026-11-08");
        assert_eq!(yearly[0].cadence, "yearly");
        let lapsed = [charge("1", "2026-05-05", 1599), charge("2", "2026-06-05", 1599), charge("3", "2026-07-05", 1599)];
        assert!(suggest(&lapsed, &[], &[], "2026-11-06").is_empty());
    }

    #[test]
    fn a_dismissal_hides_a_near_amount_and_a_new_amount_comes_back() {
        let charges = [charge("1", "2026-08-05", 1599), charge("2", "2026-09-05", 1599), charge("3", "2026-10-05", 1599)];
        let hide = [Dismissal { account: "a".into(), payee_key: "netflix".into(), cadence: "monthly".into(), cents: 1500 }];
        assert!(suggest(&charges, &[], &hide, "2026-11-06").is_empty());
        let far = [Dismissal { account: "a".into(), payee_key: "netflix".into(), cadence: "monthly".into(), cents: 900 }];
        assert_eq!(suggest(&charges, &[], &far, "2026-11-06").len(), 1);
    }

    #[test]
    fn month_end_bills_follow_the_last_day() {
        let charges = [charge("1", "2026-07-31", 5000), charge("2", "2026-08-31", 5000), charge("3", "2026-09-30", 5000)];
        let got = suggest(&charges, &[], &[], "2026-10-31");
        assert_eq!(got[0].next, "2026-10-30");
        assert!(fits("2026-09-30", "2026-10-31", "monthly"));
    }
}
