//! Category targets (`app.finance_targets`) and funding them from ready money.
//!
//! A target guides an envelope and never allocates money itself. Funding turns the guidance
//! into ordinary assignments through the same write the budget screen uses. Activity rows hold
//! the category id, month and kind only.
use crate::budget::{self, check, gate, read_month, read_review, stale, Book, TARGETS, BOUND};
use crate::budget_write::{apply_items, Item, MAX_BATCH};
use crate::envelope::{day_number, Cat};
use crate::input::{self, ranged, refuse, required_string, MAX_SAFE};
use crate::ledger::{log_as, text, today, values, Outcome};
use moss_module_sdk::{
    query::{Conflict, Query},
    Client, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const MAX_WEEKLY: i64 = MAX_SAFE / 5;

/// One saved version of a category's target, effective from its month on.
#[derive(Clone, Debug)]
pub struct Target {
    pub category: String,
    pub month: String,
    pub kind: String,
    pub amount: i64,
    pub due: Option<String>,
    pub weekday: Option<i64>,
}

fn target_of(row: &Value) -> Option<Target> {
    Some(Target {
        category: row["category_id"].as_str()?.to_owned(),
        month: row["effective_month"].as_str()?.to_owned(),
        kind: row["kind"].as_str()?.to_owned(),
        amount: row["amount_cents"].as_i64()?,
        due: row["due_date"].as_str().map(str::to_owned),
        weekday: row["weekday"].as_i64(),
    })
}

/// The latest version at or before `month` for each category, without removed ones.
pub fn for_month(book: &Book, month: &str) -> Vec<Target> {
    let mut latest: BTreeMap<String, Target> = BTreeMap::new();
    for target in book.targets.iter().filter_map(target_of).filter(|t| t.month.as_str() <= month) {
        match latest.get(&target.category) {
            Some(held) if held.month >= target.month => {}
            _ => {
                latest.insert(target.category.clone(), target);
            }
        }
    }
    latest.into_values().filter(|t| t.kind != "removed").collect()
}

fn days_in(month: &str) -> i64 {
    let last = budget::last_day(month);
    last[8..10].parse().unwrap_or(28)
}

/// Full calendar-month occurrences of a weekday (0 is Sunday).
pub fn count_weekdays(month: &str, weekday: i64) -> i64 {
    let first = (day_number(&format!("{month}-01")) + 4).rem_euclid(7);
    let first_occurrence = 1 + (weekday - first + 7) % 7;
    (days_in(month) - first_occurrence).div_euclid(7) + 1
}

fn month_index(month: &str) -> i64 {
    month[..4].parse::<i64>().unwrap_or(0) * 12 + month[5..7].parse::<i64>().unwrap_or(1) - 1
}

/// A target with its progress against one month's envelope.
#[derive(Clone, Debug)]
pub struct Progress {
    pub target: Target,
    pub weekly: Option<(i64, i64, i64)>,
    pub progress: i64,
    pub remaining: i64,
    pub suggested: i64,
    pub status: &'static str,
}

pub fn progress(target: &Target, state: Option<&Cat>, month: &str, as_of: &str) -> Progress {
    let weekly = (target.kind == "weekly").then(|| {
        let weekday = target.weekday.unwrap_or(0);
        let occurrences = count_weekdays(month, weekday);
        (weekday, occurrences, target.amount * occurrences)
    });
    let amount = weekly.map_or(target.amount, |w| w.2);
    let (assigned, activity, available) = state.map_or((0, 0, 0), |c| (c.assigned, c.activity, c.available));
    let base = match target.kind.as_str() {
        "refill" => available + activity,
        "monthly" | "weekly" => assigned,
        _ => available,
    };
    let remaining = (amount - base).max(0);
    let overdue = target.kind == "balance" && target.due.as_deref().is_some_and(|d| d < as_of);
    let months = match (target.kind.as_str(), &target.due) {
        ("balance", Some(due)) => (month_index(due) - month_index(month) + 1).max(1),
        _ => 1,
    };
    Progress {
        target: target.clone(),
        weekly,
        progress: base.max(0),
        remaining,
        suggested: (remaining + months - 1) / months,
        status: if remaining == 0 { "reached" } else if overdue { "overdue" } else { "in-progress" },
    }
}

impl Progress {
    pub fn json(&self) -> Value {
        let t = &self.target;
        let mut out = json!({
            "categoryId": t.category, "effectiveMonth": t.month, "kind": t.kind, "amountCents": t.amount, "dueDate": t.due,
            "progressCents": self.progress, "remainingCents": self.remaining, "suggestedCents": self.suggested, "status": self.status,
        });
        if let Some(weekday) = t.weekday {
            out["weekday"] = json!(weekday);
        }
        if let Some((weekday, occurrences, total)) = self.weekly {
            out["weekly"] = json!({"weekday":weekday,"occurrences":occurrences,"totalCents":total});
        }
        out
    }
}

/// The day a month's progress is measured on.
pub fn as_of(month: &str, today: &str) -> String {
    let current = &today[..7];
    if month < current { budget::last_day(month) } else if month > current { format!("{month}-01") } else { today.to_owned() }
}

/// Progress for every target in force that month.
pub fn progress_all(book: &Book, categories: &BTreeMap<String, Cat>, month: &str, today: &str) -> Vec<Progress> {
    let day = as_of(month, today);
    for_month(book, month).iter().map(|t| progress(t, categories.get(&t.category), month, &day)).collect()
}

/// `finance.target.set`.
pub fn set<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(input));
    let category = ask!(required_string(input, "categoryId", None));
    let kind = ask!(required_string(input, "kind", None));
    if !["monthly", "weekly", "refill", "balance"].contains(&kind.as_str()) {
        return Ok(Err(input::invalid("kind must be one of monthly, weekly, refill, balance")));
    }
    let cents = ask!(ranged(input, "amountCents", 1, if kind == "weekly" { MAX_WEEKLY } else { MAX_SAFE }));
    let weekday = if kind == "weekly" {
        Some(ask!(ranged(input, "weekday", 0, 6)))
    } else if input.get("weekday").is_some_and(|v| !v.is_null()) {
        return Ok(Err(input::invalid("Only weekly targets have a weekday")));
    } else {
        None
    };
    let due = ask!(input::string(input, "dueDate", false, None));
    if kind == "balance" && !due.as_deref().is_some_and(input::is_calendar_date) {
        return Ok(Err(input::invalid("Choose a valid target date")));
    }
    if kind != "balance" && due.is_some() {
        return Ok(Err(input::invalid("Only balance targets have a date")));
    }
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    ask!(crate::flex::assert_category_funding(&reviewed.book, &month, std::slice::from_ref(&category)));
    let eligible = reviewed.book.categories.iter().any(|c| c["id"] == category.as_str() && c["archived_at"].is_null() && c["is_income"] != true && category != "transfers");
    if !eligible || !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    save(host, &Target { category: category.clone(), month: month.clone(), kind: kind.clone(), amount: cents, due, weekday })?;
    Ok(Ok(json!({"status":"ok","categoryId":category,"month":month})))
}

/// Removal skips the funding check, so an archived or pooled category can still drop its target.
pub fn remove<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(input));
    let category = ask!(required_string(input, "categoryId", None));
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let eligible = reviewed.book.categories.iter().any(|c| c["id"] == category.as_str() && c["is_income"] != true && category != "transfers");
    if !eligible || !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    save(host, &Target { category: category.clone(), month: month.clone(), kind: "removed".into(), amount: 0, due: None, weekday: None })?;
    Ok(Ok(json!({"status":"ok","categoryId":category,"month":month})))
}

fn save<H: Host + ?Sized>(host: &H, t: &Target) -> Result<()> {
    let now = text(host, "call", "read", "now")?;
    let mut upsert = Query::insert(values(vec![
        ("category_id", json!(t.category)), ("effective_month", json!(t.month)), ("kind", json!(t.kind)),
        ("amount_cents", json!(t.amount)), ("due_date", json!(t.due)), ("weekday", json!(t.weekday)), ("updated_at", json!(now)),
    ]));
    upsert.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "category_id".into(), "effective_month".into()],
        values: values(vec![("kind", json!(t.kind)), ("amount_cents", json!(t.amount)), ("due_date", json!(t.due)), ("weekday", json!(t.weekday)), ("updated_at", json!(now))]),
    };
    Client(host).query(TARGETS, &upsert)?;
    log_as(host, "user", "target.set", json!({"categoryId":t.category,"month":t.month,"kind":t.kind}), None)?;
    Ok(())
}

/// One target's funding suggestion.
pub struct Line {
    pub category: String,
    pub name: String,
    pub kind: String,
    pub weekly: Option<(i64, i64, i64)>,
    pub due: Option<String>,
    pub previous: i64,
    pub amount: i64,
    pub new_assigned: Option<i64>,
    pub reason: Option<&'static str>,
}

impl Line {
    pub fn json(&self) -> Value {
        let mut out = json!({
            "categoryId": self.category, "name": self.name, "kind": self.kind, "dueDate": self.due,
            "previousCents": self.previous, "amountCents": self.amount, "newAssignedCents": self.new_assigned,
            "unavailableReason": self.reason,
        });
        if let Some((weekday, occurrences, total)) = self.weekly {
            out["weekly"] = json!({"weekday":weekday,"occurrences":occurrences,"totalCents":total});
        }
        out
    }
}

/// True when any envelope other than income and transfers is overspent.
pub fn overspent(categories: &BTreeMap<String, Cat>) -> bool {
    categories.iter().any(|(id, c)| id != "income" && id != "transfers" && c.available < 0)
}

pub fn lines(targets: &[Progress], categories: &BTreeMap<String, Cat>, book: &Book, pooled: &[String]) -> Vec<Line> {
    targets
        .iter()
        .map(|p| {
            let id = p.target.category.as_str();
            let category = book.categories.iter().find(|c| c["id"] == id);
            let previous = categories.get(id).map_or(0, |c| c.assigned);
            let total = i128::from(previous) + i128::from(p.suggested);
            let bound = i128::from(BOUND);
            let within = i128::from(p.suggested) <= bound && total.abs() <= bound;
            let reason = if category.is_none_or(|c| !c["archived_at"].is_null()) || id == "income" || id == "transfers" {
                Some("archived")
            } else if pooled.iter().any(|x| x == id) {
                Some("pooled")
            } else if p.target.kind == "removed" || p.suggested <= 0 {
                Some("reached")
            } else if !within {
                Some("assignment_limit")
            } else {
                None
            };
            Line {
                category: id.to_owned(),
                name: category.and_then(|c| c["name"].as_str()).unwrap_or("Archived category").to_owned(),
                kind: p.target.kind.clone(),
                weekly: p.weekly,
                due: p.target.due.clone(),
                previous,
                amount: p.suggested,
                new_assigned: within.then_some(total as i64),
                reason,
            }
        })
        .collect()
}

/// `finance.targets.fund`.
pub fn fund<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(input));
    let date = today(host)?;
    if month != date[..7] {
        return Ok(Err(refuse("current_month_required", "Fund targets from the current month's saved budget")));
    }
    let selection = || refuse("invalid_selection", "Choose one to twenty different targets and their captured amounts");
    let (Some(ids), Some(amounts)) = (input.get("categoryIds").and_then(Value::as_array), input.get("expectedAmountsCents").and_then(Value::as_array)) else {
        return Ok(Err(selection()));
    };
    let mut names = Vec::new();
    for id in ids {
        match id.as_str() {
            Some(s) if !s.is_empty() && !names.contains(&s) => names.push(s),
            _ => return Ok(Err(selection())),
        }
    }
    if names.is_empty() || names.len() > MAX_BATCH || names.len() != amounts.len() {
        return Ok(Err(selection()));
    }
    let mut cents = Vec::new();
    for value in amounts {
        let one = Map::from_iter([("value".to_owned(), value.clone())]);
        cents.push(ask!(ranged(&one, "value", 1, BOUND)));
    }
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let ctx = budget::context(host, &reviewed.book, &reviewed.policy.iso, &month, &date)?;
    ask!(ctx.blocked());
    if overspent(&ctx.month.categories) || ctx.card_overspent {
        return Ok(Err(refuse("cover_overspending", "Cover category and card-payment overspending before funding targets")));
    }
    let pooled = crate::flex::pooled_ids(&reviewed.book, &month);
    let all = progress_all(&reviewed.book, &ctx.month.categories, &month, &date);
    let guidance = lines(&all, &ctx.month.categories, &reviewed.book, &pooled);
    let mut items = Vec::new();
    for (index, id) in names.iter().enumerate() {
        let Some(line) = guidance.iter().find(|l| l.category == *id).filter(|l| l.reason.is_none()) else {
            return Ok(Err(refuse("target_unavailable", "A selected target is no longer eligible; check the saved budget")));
        };
        let Some(new_assigned) = line.new_assigned else {
            return Ok(Err(refuse("target_unavailable", "A selected target is no longer eligible; check the saved budget")));
        };
        if line.amount != cents[index] {
            return Ok(Err(refuse("stale_target_guidance", "Target guidance changed; check the saved budget before choosing again")));
        }
        items.push(Item { category: (*id).to_owned(), amount: new_assigned, previous: line.previous });
    }
    let Some(ready) = ctx.ready else {
        return Ok(Err(refuse("funding_unavailable", "Ready to assign is unavailable; check the saved budget")));
    };
    let total: i64 = cents.iter().sum();
    if total <= 0 || total > ready {
        return Ok(Err(refuse("not_enough_ready", "Choose fewer targets to stay within ready-to-assign money")));
    }
    let applied = items.len();
    let outcome = apply_items(host, &month, &items, &expected, "user")?;
    Ok(outcome.map(|_| {
        let rows: Vec<Value> = items.iter().map(|i| json!({"categoryId":i.category,"amountCents":i.amount,"previousCents":i.previous})).collect();
        json!({"status":"ok","applied":applied,"assignments":rows,"totalCents":total,"readyBeforeCents":ready,"readyAfterCents":ready - total})
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(assigned: i64, activity: i64, available: i64) -> Cat {
        Cat { assigned, activity, available }
    }
    fn target(kind: &str, amount: i64, due: Option<&str>, weekday: Option<i64>) -> Target {
        Target { category: "groceries".into(), month: "2026-11".into(), kind: kind.into(), amount, due: due.map(Into::into), weekday }
    }

    #[test]
    fn weekdays_are_counted_per_calendar_month() {
        // November 2026 starts on a Sunday and has 30 days.
        assert_eq!(count_weekdays("2026-11", 0), 5);
        assert_eq!(count_weekdays("2026-11", 1), 5);
        assert_eq!(count_weekdays("2026-11", 2), 4);
        assert_eq!(count_weekdays("2026-02", 0), 4);
        assert_eq!(count_weekdays("2028-02", 2), 5);
    }

    #[test]
    fn monthly_target_measures_what_is_assigned() {
        let p = progress(&target("monthly", 50_000, None, None), Some(&cat(20_000, 5_000, 15_000)), "2026-11", "2026-11-10");
        assert_eq!((p.progress, p.remaining, p.suggested, p.status), (20_000, 30_000, 30_000, "in-progress"));
        let done = progress(&target("monthly", 50_000, None, None), Some(&cat(50_000, 0, 50_000)), "2026-11", "2026-11-10");
        assert_eq!((done.remaining, done.status), (0, "reached"));
    }

    #[test]
    fn weekly_target_multiplies_by_the_weekday_count() {
        let p = progress(&target("weekly", 1_000, None, Some(0)), Some(&cat(2_000, 0, 2_000)), "2026-11", "2026-11-10");
        assert_eq!(p.weekly, Some((0, 5, 5_000)));
        assert_eq!((p.remaining, p.suggested), (3_000, 3_000));
    }

    #[test]
    fn refill_counts_what_was_spent_back_in() {
        let p = progress(&target("refill", 10_000, None, None), Some(&cat(4_000, 3_000, 1_000)), "2026-11", "2026-11-10");
        assert_eq!((p.progress, p.remaining), (4_000, 6_000));
    }

    #[test]
    fn balance_target_spreads_over_months_and_goes_overdue() {
        let t = target("balance", 90_000, Some("2027-01-15"), None);
        let p = progress(&t, Some(&cat(0, 0, 30_000)), "2026-11", "2026-11-10");
        assert_eq!((p.remaining, p.suggested, p.status), (60_000, 20_000, "in-progress"));
        let late = progress(&target("balance", 90_000, Some("2026-10-15"), None), None, "2026-11", "2026-11-10");
        assert_eq!((late.suggested, late.status), (90_000, "overdue"));
    }

    #[test]
    fn a_negative_envelope_shows_no_progress() {
        let p = progress(&target("balance", 1_000, Some("2026-11-30"), None), Some(&cat(0, 0, -400)), "2026-11", "2026-11-10");
        assert_eq!((p.progress, p.remaining), (0, 1_400));
    }
}
