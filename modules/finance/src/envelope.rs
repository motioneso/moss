//! Pure budget math. No clock and no host calls. Spending is positive and income is negative,
//! as the ledger stores it.
//!
//! ```text
//! available(C, m) = carry(C, m-1) + assigned(C, m) - activity(C, m)
//! carry(C, m)     = max(available(C, m), 0)
//! tbb(M)          = sum(income, m <= M) - sum(assigned, m <= M) + sum(overspend, m < M)
//! ```
use crate::input::MAX_SAFE;
use moss_module_sdk::{Error, Result};
use std::collections::{BTreeMap, BTreeSet};

/// One posted ledger row in the budget currency.
#[derive(Clone, Debug)]
pub struct Row {
    pub id: String,
    pub account_id: String,
    pub date: String,
    pub amount: i64,
    pub category: Option<String>,
    pub splits: Vec<(String, i64)>,
    pub linked: bool,
    /// The merchant, or the name when there is none, trimmed and lower case.
    pub payee: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cat {
    pub assigned: i64,
    pub activity: i64,
    pub available: i64,
}

#[derive(Clone, Debug)]
pub struct Month {
    pub tbb: i64,
    pub categories: BTreeMap<String, Cat>,
}

pub type Assignments = BTreeMap<String, BTreeMap<String, i64>>;

pub fn safe(value: i128) -> Result<i64> {
    if value.abs() > i128::from(MAX_SAFE) {
        return Err(Error::new("A budget amount is too large"));
    }
    Ok(value as i64)
}

pub fn is_envelope(id: &str) -> bool {
    id != "income" && id != "transfers"
}

fn day_number(date: &str) -> i64 {
    let part = |r: std::ops::Range<usize>| date[r].parse::<i64>().unwrap_or(0);
    let (mut y, m, d) = (part(0..4), part(5..7), part(8..10));
    if m <= 2 {
        y -= 1;
    }
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

fn is_transfer_category(row: &Row) -> bool {
    row.category.as_deref() == Some("transfers")
}

/// Rows that move money between the person's own accounts. Linked rows and rows sorted as
/// transfers count. A row also counts when it pairs with one of those: opposite amount, a
/// different account, within three days, neither split nor linked.
pub fn transfer_ids(rows: &[Row]) -> BTreeSet<String> {
    let mut set: BTreeSet<String> =
        rows.iter().filter(|r| r.linked || is_transfer_category(r)).map(|r| r.id.clone()).collect();
    let mut sorted: Vec<&Row> = rows.iter().collect();
    sorted.sort_by(|a, b| (&a.date, &a.id).cmp(&(&b.date, &b.id)));
    let mut paired: BTreeSet<&str> = BTreeSet::new();
    let free = |r: &Row| !r.linked && r.splits.is_empty() && r.amount != 0;
    for (i, a) in sorted.iter().enumerate() {
        if paired.contains(a.id.as_str()) || !free(a) {
            continue;
        }
        for b in &sorted[i + 1..] {
            if day_number(&b.date) - day_number(&a.date) > 3 {
                break;
            }
            let fits = !paired.contains(b.id.as_str())
                && free(b)
                && b.amount == -a.amount
                && b.account_id != a.account_id
                && (is_transfer_category(a) || is_transfer_category(b));
            if fits {
                paired.insert(a.id.as_str());
                paired.insert(b.id.as_str());
                break;
            }
        }
    }
    set.extend(paired.into_iter().map(str::to_owned));
    set
}

/// A split counts when its parts add up to the row amount. Otherwise the row counts whole.
pub fn allocations(row: &Row) -> Vec<(Option<String>, i64)> {
    if !row.splits.is_empty() && row.splits.iter().map(|p| p.1).sum::<i64>() == row.amount {
        return row.splits.iter().map(|(c, a)| (Some(c.clone()), *a)).collect();
    }
    vec![(row.category.clone(), row.amount)]
}

/// Every month that has an assignment or a counted row, in order, carrying balances forward.
pub fn derive(assignments: &Assignments, rows: &[Row], excluded: &BTreeSet<String>) -> Result<BTreeMap<String, Month>> {
    let mut activity: BTreeMap<String, BTreeMap<String, i128>> = BTreeMap::new();
    let mut income: BTreeMap<String, i128> = BTreeMap::new();
    for row in rows.iter().filter(|r| !excluded.contains(&r.id)) {
        let month = row.date[..7].to_owned();
        activity.entry(month.clone()).or_default();
        for (category, amount) in allocations(row) {
            let Some(category) = category.filter(|c| c != "transfers") else { continue };
            *activity.entry(month.clone()).or_default().entry(category.clone()).or_default() += i128::from(amount);
            if category == "income" {
                *income.entry(month.clone()).or_default() -= i128::from(amount);
            }
        }
    }
    let months: BTreeSet<&String> = assignments.keys().chain(activity.keys()).collect();
    let mut out = BTreeMap::new();
    let mut carry: BTreeMap<String, i128> = BTreeMap::new();
    let (mut cum_income, mut cum_assigned, mut cum_overspend) = (0i128, 0i128, 0i128);
    for month in months {
        let no_plan: BTreeMap<String, i64> = BTreeMap::new();
        let no_spend: BTreeMap<String, i128> = BTreeMap::new();
        let assigned = assignments.get(month).unwrap_or(&no_plan);
        let spent = activity.get(month).unwrap_or(&no_spend);
        let ids: BTreeSet<String> = carry.keys().chain(assigned.keys()).chain(spent.keys()).cloned().collect();
        let (mut categories, mut total, mut overspend) = (BTreeMap::new(), 0i128, 0i128);
        for id in ids {
            let a = i128::from(*assigned.get(&id).unwrap_or(&0));
            let s = *spent.get(&id).unwrap_or(&0);
            let available = carry.get(&id).copied().unwrap_or(0) + a - s;
            categories.insert(id.clone(), Cat { assigned: safe(a)?, activity: safe(s)?, available: safe(available)? });
            total += a;
            if available > 0 {
                carry.insert(id, available);
            } else {
                carry.remove(&id);
                overspend += available;
            }
        }
        cum_income += income.get(month).copied().unwrap_or(0);
        cum_assigned += total;
        out.insert(month.clone(), Month { tbb: safe(cum_income - cum_assigned + cum_overspend)?, categories });
        cum_overspend += overspend;
    }
    Ok(out)
}

/// Money in the budget's accounts that no envelope holds.
pub fn ready(signed_balances: i128, categories: &BTreeMap<String, Cat>) -> Result<i64> {
    let held: i128 = categories.iter().filter(|(id, _)| is_envelope(id)).map(|(_, c)| i128::from(c.available)).sum();
    safe(signed_balances - held)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, account: &str, date: &str, amount: i64, category: Option<&str>) -> Row {
        Row { id: id.into(), account_id: account.into(), date: date.into(), amount, category: category.map(Into::into), splits: vec![], linked: false, payee: String::new() }
    }
    fn plan(month: &str, id: &str, cents: i64) -> Assignments {
        BTreeMap::from([(month.to_owned(), BTreeMap::from([(id.to_owned(), cents)]))])
    }

    #[test]
    fn balances_carry_and_overspend_leaves_the_pool_next_month() {
        let mut assigned = plan("2026-10", "groceries", 10_000);
        assigned.insert("2026-11".into(), BTreeMap::new());
        let rows = vec![
            row("p", "a", "2026-10-01", -50_000, Some("income")),
            row("g1", "a", "2026-10-05", 12_000, Some("groceries")),
            row("g2", "a", "2026-11-05", 1_000, Some("groceries")),
        ];
        let months = derive(&assigned, &rows, &BTreeSet::new()).unwrap();
        assert_eq!(months["2026-10"].categories["groceries"], Cat { assigned: 10_000, activity: 12_000, available: -2_000 });
        assert_eq!(months["2026-10"].tbb, 40_000);
        // The overspend is not carried, but it lowers the pool from the next month on.
        assert_eq!(months["2026-11"].categories["groceries"].available, -1_000);
        assert_eq!(months["2026-11"].tbb, 40_000 - 2_000);
    }

    #[test]
    fn unspent_money_carries_forward() {
        let assigned = plan("2026-09", "dining", 5_000);
        let rows = vec![row("d", "a", "2026-10-02", 1_500, Some("dining"))];
        let months = derive(&assigned, &rows, &BTreeSet::new()).unwrap();
        assert_eq!(months["2026-10"].categories["dining"].available, 3_500);
    }

    #[test]
    fn a_balanced_split_counts_by_part_and_an_unbalanced_one_counts_whole() {
        let mut split = row("s", "a", "2026-10-02", 3_000, Some("groceries"));
        split.splits = vec![("groceries".into(), 2_000), ("dining".into(), 1_000)];
        let months = derive(&Assignments::new(), &[split.clone()], &BTreeSet::new()).unwrap();
        assert_eq!(months["2026-10"].categories["dining"].activity, 1_000);
        split.splits = vec![("groceries".into(), 2_000), ("dining".into(), 500)];
        let months = derive(&Assignments::new(), &[split], &BTreeSet::new()).unwrap();
        assert_eq!(months["2026-10"].categories["groceries"].activity, 3_000);
    }

    #[test]
    fn transfers_and_uncategorized_rows_stay_out_of_the_envelopes() {
        let rows = vec![
            row("out", "a", "2026-10-02", 20_000, Some("transfers")),
            row("in", "b", "2026-10-03", -20_000, None),
            row("none", "a", "2026-10-04", 700, None),
        ];
        let excluded = transfer_ids(&rows);
        assert!(excluded.contains("out") && excluded.contains("in") && !excluded.contains("none"));
        let months = derive(&Assignments::new(), &rows, &excluded).unwrap();
        assert!(months["2026-10"].categories.is_empty());
    }

    #[test]
    fn pairing_needs_a_transfer_side_a_different_account_and_three_days() {
        let a = row("a", "x", "2026-10-02", 100, Some("transfers"));
        let far = row("b", "y", "2026-10-06", -100, None);
        let same_account = row("c", "x", "2026-10-03", -100, None);
        assert_eq!(transfer_ids(&[a.clone(), far, same_account]).len(), 1);
        let near = row("d", "y", "2026-10-05", -100, None);
        assert_eq!(transfer_ids(&[a, near]).len(), 2);
        let plain = vec![row("e", "x", "2026-10-02", 100, Some("dining")), row("f", "y", "2026-10-02", -100, Some("income"))];
        assert!(transfer_ids(&plain).is_empty());
    }

    #[test]
    fn ready_is_balances_minus_envelope_money() {
        let months = derive(&plan("2026-10", "groceries", 10_000), &[], &BTreeSet::new()).unwrap();
        assert_eq!(ready(60_000, &months["2026-10"].categories).unwrap(), 50_000);
    }

    #[test]
    fn day_numbers_count_across_month_ends() {
        assert_eq!(day_number("2026-03-01") - day_number("2026-02-28"), 1);
        assert_eq!(day_number("2028-03-01") - day_number("2028-02-28"), 2);
    }
}
