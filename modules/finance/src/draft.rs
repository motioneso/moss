//! The first-budget draft (`app.finance_budget_drafts`, `app.finance_budget_draft_lines`).
//!
//! Every figure is a function of stored transactions and categories. No model is called and no
//! clock is read here. The pure part builds the lines. The tools save them through the review gate.
use crate::budget::{self, check, gate, ledgers, read_review, stale, CATEGORIES, DRAFTS, LINES};
use crate::envelope::{self, Row};
use crate::input::{self, refuse};
use crate::ledger::{log_as, text, today, values, Outcome};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const BASIS_MONTHS: usize = 3;
pub const ROUND_UP: i64 = 500;
pub const GROUPS: [&str; 5] = ["Bills", "Everyday", "Fun", "Savings", "Income"];
const LINE_GROUPS: [&str; 4] = ["Bills", "Everyday", "Fun", "Savings"];
const AMOUNT_MAX: i64 = 100_000_000;

pub struct Info {
    pub id: String,
    pub name: String,
    pub group: String,
    pub archived: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub key: String,
    pub group: String,
    pub name: String,
    pub basis_monthly: i64,
    pub proposed: i64,
    pub adjusted: Option<i64>,
    pub adjusted_by: Option<String>,
    pub dropped: bool,
}

pub struct Basis {
    pub from: String,
    pub to: String,
    pub income: i64,
    pub lines: Vec<Line>,
}

pub fn plan(line: &Line) -> i64 {
    line.adjusted.unwrap_or(line.proposed)
}
pub fn total(lines: &[Line]) -> i64 {
    lines.iter().filter(|l| !l.dropped).map(plan).sum()
}

fn round_up(cents: i64) -> i64 {
    if cents > 0 { (cents + ROUND_UP - 1) / ROUND_UP * ROUND_UP } else { cents / ROUND_UP * ROUND_UP }
}

/// The newest complete months before this one (at most three), else this month as a stand-in.
pub fn pick_months(months: &BTreeSet<String>, current: &str) -> Vec<String> {
    let complete: Vec<&String> = months.iter().filter(|m| m.as_str() < current).collect();
    if !complete.is_empty() {
        return complete[complete.len().saturating_sub(BASIS_MONTHS)..].iter().map(|m| (*m).clone()).collect();
    }
    if months.contains(current) { vec![current.to_owned()] } else { vec![] }
}

fn median(mut values: Vec<i64>) -> i64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 1 { values[mid] } else { (values[mid - 1] + values[mid] + 1).div_euclid(2) }
}

/// A merchant is steady when it charges in every basis month and each month's largest charge
/// sits within 10% of the first month's. One month proves nothing.
fn steady(by_month: &BTreeMap<&str, Vec<i64>>, months: &[String]) -> bool {
    if months.len() < 2 {
        return false;
    }
    let mut peaks = Vec::new();
    for month in months {
        match by_month.get(month.as_str()).and_then(|a| a.iter().max()) {
            Some(peak) => peaks.push(*peak),
            None => return false,
        }
    }
    peaks[0] > 0 && peaks.iter().all(|p| (p - peaks[0]).abs() * 10 <= peaks[0])
}

/// Builds the draft from posted rows grouped by month. Returns None when there is no history.
pub fn build_lines(rows_by_month: &BTreeMap<String, Vec<Row>>, categories: &[Info], current: &str) -> Result<Option<Basis>> {
    let all_months: BTreeSet<String> = rows_by_month.keys().cloned().collect();
    let months = pick_months(&all_months, current);
    if months.is_empty() {
        return Ok(None);
    }
    let rows: Vec<Row> = months.iter().flat_map(|m| rows_by_month[m].clone()).collect();
    let excluded = envelope::transfer_ids(&rows);
    let mut spend: BTreeMap<String, i128> = BTreeMap::new();
    let mut merchants: BTreeMap<String, BTreeMap<String, BTreeMap<&str, Vec<i64>>>> = BTreeMap::new();
    let mut income: BTreeMap<&str, i128> = BTreeMap::new();
    for month in &months {
        for row in &rows_by_month[month] {
            if excluded.contains(&row.id) {
                continue;
            }
            for (category, cents) in envelope::allocations(row) {
                let Some(category) = category.filter(|c| c != "transfers") else { continue };
                if category == "income" {
                    *income.entry(month.as_str()).or_default() -= i128::from(cents);
                    continue;
                }
                *spend.entry(category.clone()).or_default() += i128::from(cents);
                if cents > 0 {
                    merchants.entry(category).or_default().entry(row.payee.clone()).or_default().entry(month.as_str()).or_default().push(cents);
                }
            }
        }
    }
    let divisor = months.len() as i128;
    let mut lines = Vec::new();
    for (id, cents) in &spend {
        let Some(info) = categories.iter().find(|c| &c.id == id) else { continue };
        if info.archived || *cents <= 0 {
            continue;
        }
        let monthly = envelope::safe((cents * 2 + divisor) / (2 * divisor))?;
        if monthly <= 0 {
            continue;
        }
        let mut group = if GROUPS.contains(&info.group.as_str()) { info.group.clone() } else { "Everyday".into() };
        if group != "Bills" {
            let (mut steady_sum, mut all_sum) = (0i128, 0i128);
            for by_month in merchants.get(id).into_iter().flat_map(|m| m.values()) {
                let sum: i128 = by_month.values().flatten().map(|c| i128::from(*c)).sum();
                all_sum += sum;
                if steady(by_month, &months) {
                    steady_sum += sum;
                }
            }
            if all_sum > 0 && steady_sum * 2 >= all_sum {
                group = "Bills".into();
            }
        }
        lines.push(Line {
            key: id.clone(),
            group,
            name: info.name.clone(),
            basis_monthly: monthly,
            proposed: round_up(monthly),
            adjusted: None,
            adjusted_by: None,
            dropped: false,
        });
    }
    let positive: Vec<i64> = months.iter().map(|m| envelope::safe(income.get(m.as_str()).copied().unwrap_or(0))).collect::<Result<Vec<_>>>()?.into_iter().filter(|v| *v > 0).collect();
    Ok(Some(Basis {
        from: format!("{}-01", months[0]),
        to: budget::last_day(&months[months.len() - 1]),
        income: median(positive),
        lines,
    }))
}

pub struct Edit {
    pub amount: Option<i64>,
    pub name: Option<String>,
    pub group: Option<String>,
    pub dropped: Option<bool>,
}

/// An amount un-drops the line unless the edit says otherwise. The editor is recorded only when
/// the edit changes the amount or the dropped flag.
pub fn apply_edit(key: &str, existing: Option<&Line>, edit: &Edit, by: &str) -> Line {
    let base = existing.cloned().unwrap_or(Line {
        key: key.into(),
        group: String::new(),
        name: String::new(),
        basis_monthly: 0,
        proposed: 0,
        adjusted: None,
        adjusted_by: None,
        dropped: false,
    });
    let changes_plan = edit.amount.is_some() || edit.dropped.is_some();
    Line {
        group: edit.group.clone().unwrap_or(base.group.clone()),
        name: edit.name.clone().unwrap_or(base.name.clone()),
        adjusted: edit.amount.or(base.adjusted),
        adjusted_by: if changes_plan { Some(by.into()) } else { base.adjusted_by.clone() },
        dropped: edit.dropped.unwrap_or(if edit.amount.is_some() { false } else { base.dropped }),
        ..base
    }
}

fn line_of(row: &Value) -> Line {
    Line {
        key: row["category_key"].as_str().unwrap_or("").into(),
        group: row["group_name"].as_str().unwrap_or("").into(),
        name: row["category_name"].as_str().unwrap_or("").into(),
        basis_monthly: row["basis_monthly_cents"].as_i64().unwrap_or(0),
        proposed: row["proposed_cents"].as_i64().unwrap_or(0),
        adjusted: row["adjusted_cents"].as_i64(),
        adjusted_by: row["adjusted_by"].as_str().map(Into::into),
        dropped: row["dropped"] == true,
    }
}

/// The newest draft that is not discarded, with its lines in key order.
pub struct Stored {
    pub id: String,
    pub status: String,
    pub from: String,
    pub to: String,
    pub income: i64,
    pub lines: Vec<Line>,
}

fn latest(book: &budget::Book) -> Option<Stored> {
    let row = book.drafts.iter().max_by_key(|d| (d["created_at"].as_str().unwrap_or("").to_owned(), d["id"].as_str().unwrap_or("").to_owned()))?;
    let id = row["id"].as_str()?.to_owned();
    let mut lines: Vec<Line> = book.lines.iter().filter(|l| l["draft_id"] == id.as_str()).map(line_of).collect();
    lines.sort_by(|a, b| a.key.cmp(&b.key));
    Some(Stored {
        id,
        status: row["status"].as_str()?.to_owned(),
        from: row["basis_from"].as_str()?.to_owned(),
        to: row["basis_to"].as_str()?.to_owned(),
        income: row["monthly_income_cents"].as_i64()?,
        lines,
    })
}

fn view(draft: &Stored, iso: &str) -> Value {
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for line in &draft.lines {
        let entry = json!({"categoryKey":line.key,"isoCurrency":iso,"categoryName":line.name,"basisMonthlyCents":line.basis_monthly,
            "planCents":plan(line),"dropped":line.dropped,"changedByMoss":line.adjusted_by.as_deref()==Some("moss"),"proposedCents":line.proposed});
        match groups.iter_mut().find(|g| g.0 == line.group) {
            Some(group) => group.1.push(entry),
            None => groups.push((line.group.clone(), vec![entry])),
        }
    }
    let rank = |name: &str| GROUPS.iter().position(|g| *g == name).unwrap_or(GROUPS.len());
    groups.sort_by_key(|g| rank(&g.0));
    json!({"id":draft.id,"isoCurrency":iso,"status":draft.status,"basisFrom":draft.from,"basisTo":draft.to,
        "monthlyIncomeCents":draft.income,"totalCents":total(&draft.lines),"unplannedCents":draft.income - total(&draft.lines),
        "groups":groups.into_iter().map(|(name, lines)| json!({"name":name,"lines":lines})).collect::<Vec<_>>()})
}

fn infos(book: &budget::Book) -> Vec<Info> {
    book.categories
        .iter()
        .map(|c| Info {
            id: c["id"].as_str().unwrap_or("").into(),
            name: c["name"].as_str().unwrap_or("").into(),
            group: c["group_name"].as_str().unwrap_or("").into(),
            archived: !c["archived_at"].is_null(),
        })
        .collect()
}

/// `finance.budget.draft.get`.
pub fn get<H: Host + ?Sized>(host: &H) -> Result<Outcome> {
    let Some(row) = budget::policy_row(host)? else {
        return Ok(Ok(json!({"setupRequired":true,"hasSynced":false,"hasBudget":false,"draft":null})));
    };
    let policy = match budget::require(host)? {
        Ok(p) => p,
        Err(r) => return Ok(Err(r)),
    };
    let book = budget::load(host)?;
    let items = Client(host).query(budget::ITEMS, &Query::select(Filter::All))?;
    let synced = items.iter().any(|i| !i["last_sync_at"].is_null()) || book.accounts.iter().any(|a| a["source"] == "manual");
    let draft = latest(&book).filter(|d| d.status != "discarded").map(|d| view(&d, &policy.iso));
    Ok(Ok(json!({"hasSynced":synced,"hasBudget":!book.assignments.is_empty(),"revision":row["revision"],
        "fingerprint":budget::fingerprint(&book),"isoCurrency":policy.iso,"draft":draft})))
}

/// `finance.budget.draft.build`. Builds once. An existing draft or budget is never overwritten.
pub fn build<H: Host + ?Sized>(host: &H) -> Result<Outcome> {
    let policy = match budget::require(host)? {
        Ok(p) => p,
        Err(r) => return Ok(Err(r)),
    };
    let book = budget::load(host)?;
    if latest(&book).is_some_and(|d| d.status != "discarded") {
        return Ok(Ok(json!({"status":"ok","built":false})));
    }
    if !book.assignments.is_empty() {
        return Ok(Ok(json!({"status":"ok","built":false,"reason":"has-budget"})));
    }
    let date = today(host)?;
    let current = &date[..7];
    ask!(crate::flex::assert_envelope_draft(&book, current));
    let counted: BTreeSet<String> = book.txs.iter().filter_map(|t| t["date"].as_str().map(|d| d[..7].to_owned())).collect();
    let basis = pick_months(&counted, current);
    let mut by_month: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for row in budget::budget_rows(&book, &policy.iso, &date) {
        let month = row.date[..7].to_owned();
        if basis.contains(&month) {
            by_month.entry(month).or_default().push(row);
        }
    }
    for month in &basis {
        by_month.entry(month.clone()).or_default();
    }
    let Some(built) = build_lines(&by_month, &infos(&book), current)? else {
        return Ok(Ok(json!({"status":"ok","built":false,"reason":"no-history"})));
    };
    let reviewed = budget::Reviewed { fingerprint: budget::fingerprint(&book), policy, book };
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let id = text(host, "new", "uuid", "id")?;
    let at = text(host, "call", "read", "now")?;
    let client = Client(host);
    client.query(
        DRAFTS,
        &Query::insert(values(vec![
            ("id", json!(id)),
            ("status", json!("open")),
            ("basis_from", json!(built.from)),
            ("basis_to", json!(built.to)),
            ("monthly_income_cents", json!(built.income)),
            ("created_at", json!(at)),
        ])),
    )?;
    for line in &built.lines {
        save_line(host, &id, line)?;
    }
    Ok(Ok(json!({"status":"ok","built":true,"lines":built.lines.len()})))
}

fn save_line<H: Host + ?Sized>(host: &H, draft: &str, line: &Line) -> Result<()> {
    let fields = vec![
        ("group_name", json!(line.group)),
        ("category_name", json!(line.name)),
        ("basis_monthly_cents", json!(line.basis_monthly)),
        ("proposed_cents", json!(line.proposed)),
        ("adjusted_cents", json!(line.adjusted)),
        ("adjusted_by", json!(line.adjusted_by)),
        ("dropped", json!(line.dropped)),
    ];
    let mut insert = values(fields.clone());
    insert.insert("draft_id".into(), json!(draft));
    insert.insert("category_key".into(), json!(line.key));
    let mut query = Query::insert(insert);
    query.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "draft_id".into(), "category_key".into()],
        values: values(fields),
    };
    Client(host).query(LINES, &query)?;
    Ok(())
}

fn key_is_slug(key: &str) -> bool {
    let b = key.as_bytes();
    !b.is_empty() && b.len() <= 40 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `finance.budget.draft.update`. Changes one line of the open draft.
pub fn update<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let draft_id = ask!(input::required_string(input, "draftId", None));
    let key = ask!(input::required_string(input, "categoryKey", None));
    let amount = match input.get("amountCents") {
        None | Some(Value::Null) => None,
        Some(_) => {
            let v = ask!(input::int(input, "amountCents"));
            if !(0..=AMOUNT_MAX).contains(&v) {
                return Ok(Err(input::invalid(format!("amountCents must be an integer from 0 to {AMOUNT_MAX}"))));
            }
            Some(v)
        }
    };
    let name = ask!(input::string(input, "categoryName", false, Some(80)));
    let group = ask!(input::string(input, "groupName", false, Some(20)));
    let dropped = match input.get("dropped") {
        None | Some(Value::Null) => None,
        Some(_) => Some(ask!(input::bool_(input, "dropped"))),
    };
    if amount.is_none() && name.is_none() && group.is_none() && dropped.is_none() {
        return Ok(Err(input::invalid("give at least one of amountCents, categoryName, groupName or dropped")));
    }
    let expected = ask!(read_review(input));
    let edit = Edit { amount, name, group, dropped };
    let reviewed = match check(host, &expected)? {
        Ok(r) => r,
        Err(r) => return Ok(Err(r)),
    };
    ask!(crate::flex::assert_envelope_draft(&reviewed.book, &today(host)?[..7]));
    let Some(draft) = latest(&reviewed.book).filter(|d| d.id == draft_id) else {
        return Ok(Err(refuse("draft_not_found", "draftId does not name the current draft")));
    };
    if draft.status != "open" {
        return Ok(Err(refuse("draft_not_open", "the draft has already been started")));
    }
    if key == "income" || key == "transfers" {
        return Ok(Err(refuse("protected_category", "income and transfers cannot be budgeted")));
    }
    if infos(&reviewed.book).iter().any(|c| c.archived && c.id == key) {
        return Ok(Err(refuse("archived_category", "that category is archived; unarchive it first")));
    }
    let existing = draft.lines.iter().find(|l| l.key == key);
    if existing.is_none() {
        if !key_is_slug(&key) {
            return Ok(Err(input::invalid("categoryKey must be a short lowercase slug")));
        }
        if edit.name.as_deref().is_none_or(str::is_empty) || edit.group.as_deref().is_none_or(str::is_empty) || edit.amount.is_none() {
            return Ok(Err(refuse("category_not_in_draft", "categoryKey is not in the draft; to add a line give categoryName, groupName and amountCents")));
        }
    }
    if edit.group.as_deref().is_some_and(|g| !LINE_GROUPS.contains(&g)) {
        return Ok(Err(input::invalid("groupName must be Bills, Everyday, Fun or Savings")));
    }
    if edit.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Ok(Err(input::invalid("categoryName must not be empty")));
    }
    let line = apply_edit(&key, existing, &edit, "moss");
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    save_line(host, &draft.id, &line)?;
    let before = total(&draft.lines);
    let mut lines: Vec<Line> = draft.lines.iter().filter(|l| l.key != key).cloned().collect();
    lines.push(line.clone());
    let after = total(&lines);
    Ok(Ok(json!({
        "status":"ok","draftId":draft.id,"categoryKey":line.key,"categoryName":line.name,
        "before": existing.map(|l| json!({"planCents":plan(l),"dropped":l.dropped})),
        "after": {"planCents":plan(&line),"dropped":line.dropped},
        "totalBeforeCents":before,"totalAfterCents":after,"unplannedAfterCents":draft.income - after,"monthlyIncomeCents":draft.income,
    })))
}

/// `finance.budget.draft.start`. Turns the draft into this month's budget in one save.
pub fn start<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let draft_id = ask!(input::required_string(input, "draftId", None));
    let expected = ask!(read_review(input));
    let reviewed = match check(host, &expected)? {
        Ok(r) => r,
        Err(r) => return Ok(Err(r)),
    };
    let Some(draft) = latest(&reviewed.book).filter(|d| d.id == draft_id) else {
        return Ok(Err(refuse("draft_not_found", "draftId does not name the current draft")));
    };
    if draft.status == "started" {
        return Ok(Ok(json!({"status":"ok","started":true,"alreadyStarted":true})));
    }
    let known = infos(&reviewed.book);
    let planned: Vec<&Line> = draft.lines.iter().filter(|l| !l.dropped && plan(l) > 0).collect();
    for line in &planned {
        if line.key == "income" || line.key == "transfers" {
            return Ok(Err(refuse("protected_category", "income and transfers cannot be budgeted")));
        }
        if known.iter().any(|c| c.id == line.key && c.archived) {
            return Ok(Err(refuse("archived_category", "a planned line points at an archived category; drop the line or unarchive the category")));
        }
    }
    let month = today(host)?[..7].to_owned();
    let ledger = ledgers(&reviewed.book).remove(&month).unwrap_or_default();
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let client = Client(host);
    let next = reviewed.book.categories.iter().filter_map(|c| c["sort_order"].as_i64()).max().map_or(0, |m| m + 1);
    let mut added = 0;
    for line in &planned {
        if known.iter().any(|c| c.id == line.key) {
            continue;
        }
        let mut insert = Query::insert(values(vec![
            ("id", json!(line.key)),
            ("group_name", json!(line.group)),
            ("name", json!(line.name)),
            ("sort_order", json!(next + added)),
            ("is_income", json!(false)),
        ]));
        insert.conflict = Conflict::Ignore;
        client.query(CATEGORIES, &insert)?;
        added += 1;
    }
    for line in &planned {
        let cents = plan(line);
        budget_set(host, &month, &line.key, cents)?;
        if ledger.get(&line.key).copied().unwrap_or(0) != cents {
            log_as(host, "user", "budget.assign", json!({"month":month,"categoryId":line.key}), None)?;
        }
    }
    let at = text(host, "call", "read", "now")?;
    let marked = client.query(
        DRAFTS,
        &Query::update(
            Filter::And { filters: vec![Filter::eq("id", draft.id.clone()), Filter::eq("status", "open")] },
            values(vec![("status", json!("started")), ("started_at", json!(at))]),
        ),
    )?;
    if marked.is_empty() {
        return Err(Error::new("The draft changed during the save"));
    }
    Ok(Ok(json!({"status":"ok","started":true,"assigned":planned.len()})))
}

fn budget_set<H: Host + ?Sized>(host: &H, month: &str, category: &str, cents: i64) -> Result<()> {
    crate::budget_write::set_total(host, month, category, cents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::row_of;

    fn row(id: &str, date: &str, cents: i64, category: &str, payee: &str) -> Row {
        Row { id: id.into(), account_id: "a".into(), date: date.into(), amount: cents, category: Some(category.into()), splits: vec![], linked: false, payee: payee.into() }
    }
    fn info(id: &str, group: &str) -> Info {
        Info { id: id.into(), name: id.to_uppercase(), group: group.into(), archived: false }
    }
    fn by_month(rows: Vec<Row>) -> BTreeMap<String, Vec<Row>> {
        let mut out: BTreeMap<String, Vec<Row>> = BTreeMap::new();
        for r in rows {
            out.entry(r.date[..7].to_owned()).or_default().push(r);
        }
        out
    }

    #[test]
    fn basis_is_the_last_three_complete_months_else_this_month() {
        let months: BTreeSet<String> = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-11"].iter().map(|s| s.to_string()).collect();
        assert_eq!(pick_months(&months, "2026-11"), vec!["2026-07", "2026-08", "2026-09"]);
        let only: BTreeSet<String> = ["2026-11".to_string()].into();
        assert_eq!(pick_months(&only, "2026-11"), vec!["2026-11"]);
        assert!(pick_months(&BTreeSet::new(), "2026-11").is_empty());
    }

    #[test]
    fn monthly_figures_round_and_plans_round_up_to_five_dollars() {
        let rows = by_month(vec![
            row("1", "2026-09-03", 10_000, "dining", "cafe a"),
            row("2", "2026-10-03", 10_001, "dining", "cafe b"),
            row("3", "2026-09-04", -300_000, "income", "work"),
            row("4", "2026-10-04", -310_000, "income", "work"),
        ]);
        let built = build_lines(&rows, &[info("dining", "Everyday")], "2026-11").unwrap().unwrap();
        // (20001 * 2 + 2) / 4 = 10001 monthly; rounded up to the next 500.
        assert_eq!(built.lines[0].basis_monthly, 10_001);
        assert_eq!(built.lines[0].proposed, 10_500);
        assert_eq!((built.from.as_str(), built.to.as_str()), ("2026-09-01", "2026-10-31"));
        assert_eq!(built.income, 305_000);
    }

    #[test]
    fn a_category_of_steady_charges_becomes_a_bill() {
        let rows = by_month(vec![
            row("1", "2026-09-03", 5_000, "utilities", "power co"),
            row("2", "2026-10-03", 5_200, "utilities", "power co"),
            row("3", "2026-09-05", 2_000, "dining", "cafe"),
            row("4", "2026-10-09", 9_000, "dining", "cafe"),
        ]);
        let cats = [info("utilities", "Everyday"), info("dining", "Everyday")];
        let built = build_lines(&rows, &cats, "2026-11").unwrap().unwrap();
        let group = |k: &str| built.lines.iter().find(|l| l.key == k).unwrap().group.clone();
        assert_eq!(group("utilities"), "Bills");
        assert_eq!(group("dining"), "Everyday");
    }

    #[test]
    fn archived_transfer_and_refund_only_categories_get_no_line() {
        let rows = by_month(vec![
            row("1", "2026-10-03", 5_000, "old", "x"),
            row("2", "2026-10-03", -500, "refunds", "x"),
            row("3", "2026-10-03", 700, "transfers", "x"),
        ]);
        let mut old = info("old", "Everyday");
        old.archived = true;
        let built = build_lines(&rows, &[old, info("refunds", "Everyday")], "2026-11").unwrap().unwrap();
        assert!(built.lines.is_empty());
    }

    #[test]
    fn an_amount_undrops_a_line_and_a_rename_keeps_the_editor() {
        let mut line = apply_edit("fun", None, &Edit { amount: Some(900), name: Some("Fun".into()), group: Some("Fun".into()), dropped: None }, "moss");
        assert_eq!((line.adjusted, line.adjusted_by.as_deref(), line.dropped), (Some(900), Some("moss"), false));
        line = apply_edit("fun", Some(&line), &Edit { amount: None, name: None, group: None, dropped: Some(true) }, "user");
        assert!(line.dropped && line.adjusted_by.as_deref() == Some("user"));
        line = apply_edit("fun", Some(&line), &Edit { amount: Some(500), name: None, group: None, dropped: None }, "moss");
        assert!(!line.dropped);
        let renamed = apply_edit("fun", Some(&line), &Edit { amount: None, name: Some("Play".into()), group: None, dropped: None }, "user");
        assert_eq!(renamed.adjusted_by.as_deref(), Some("moss"));
    }

    #[test]
    fn totals_skip_dropped_lines() {
        let mut a = apply_edit("a", None, &Edit { amount: Some(100), name: Some("A".into()), group: Some("Fun".into()), dropped: None }, "user");
        let b = apply_edit("b", None, &Edit { amount: Some(250), name: Some("B".into()), group: Some("Fun".into()), dropped: None }, "user");
        assert_eq!(total(&[a.clone(), b.clone()]), 350);
        a.dropped = true;
        assert_eq!(total(&[a, b]), 250);
    }

    #[test]
    fn slugs_follow_the_old_pattern() {
        assert!(key_is_slug("a") && key_is_slug("9-lives") && key_is_slug(&"a".repeat(40)));
        assert!(!key_is_slug("") && !key_is_slug("-a") && !key_is_slug("A") && !key_is_slug(&"a".repeat(41)) && !key_is_slug("a b"));
    }

    #[test]
    fn row_conversion_reads_the_payee_from_merchant_first() {
        let r = row_of(&json!({"id":"t","account_id":"a","date":"2026-10-01","amount_cents":1,"merchant":" Cafe ","name":"X","splits":[]}));
        assert_eq!(r.payee, "cafe");
    }
}
