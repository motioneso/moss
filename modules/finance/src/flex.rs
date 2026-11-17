//! The flexible spending pool (`app.finance_flex_policies`).
//!
//! While a month's policy is active, the members' assignments, spending and carried money count
//! as one pool envelope. Assignments stay stored per category, and the pool total is a delta over
//! the members' stored amounts. Activity rows hold the month and mode only.
use crate::budget::{self, check, gate, read_month, read_review, stale, Book, Context, Reviewed, BOUND, FLEX};
use crate::budget_write::set_total;
use crate::envelope::{safe, Cat};
use crate::input::{self, refuse, Refusal};
use crate::ledger::{log_as, text, today, values, Outcome};
use moss_module_sdk::{
    query::{Conflict, Query},
    Client, Host, Result,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const FLEX_POOL: &str = "moss:flex-pool";

#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub month: String,
    pub active: bool,
    pub flex_ids: Vec<String>,
    pub non_monthly_ids: Vec<String>,
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

pub fn policies(book: &Book) -> Vec<Policy> {
    book.flex
        .iter()
        .filter_map(|r| {
            Some(Policy {
                month: r["month"].as_str()?.to_owned(),
                active: r["active"] == true,
                flex_ids: strings(&r["flex_ids"]),
                non_monthly_ids: strings(&r["non_monthly_ids"]),
            })
        })
        .collect()
}

/// The newest policy at or before `month`.
pub fn for_month<'a>(all: &'a [Policy], month: &str) -> Option<&'a Policy> {
    all.iter().filter(|p| p.month.as_str() <= month).max_by(|a, b| a.month.cmp(&b.month))
}

/// Existing policies with one month's policy swapped for a proposed one.
pub fn with_override(all: &[Policy], proposed: Option<&Policy>) -> Vec<Policy> {
    let mut out: Vec<Policy> = all.iter().filter(|p| proposed.is_none_or(|n| n.month != p.month)).cloned().collect();
    out.extend(proposed.cloned());
    out
}

/// An active policy's members, when the month uses the pool.
pub fn active_for(book: &Book, month: &str) -> Option<Policy> {
    for_month(&policies(book), month).filter(|p| p.active).cloned()
}

pub fn pooled_ids(book: &Book, month: &str) -> Vec<String> {
    active_for(book, month).map(|p| p.flex_ids).unwrap_or_default()
}

pub fn pooled_ids_of(policy: Option<&Policy>) -> Vec<String> {
    policy.filter(|p| p.active).map(|p| p.flex_ids.clone()).unwrap_or_default()
}

/// Folds the members' amounts into the pool amount.
pub fn route(input: &BTreeMap<String, i64>, policy: Option<&Policy>) -> Result<BTreeMap<String, i64>> {
    let Some(policy) = policy.filter(|p| p.active) else { return Ok(input.clone()) };
    let mut out = input.clone();
    let mut pool = i128::from(input.get(FLEX_POOL).copied().unwrap_or(0));
    for id in &policy.flex_ids {
        pool += i128::from(input.get(id).copied().unwrap_or(0));
        out.remove(id);
    }
    out.insert(FLEX_POOL.to_owned(), safe(pool)?);
    Ok(out)
}

/// A pooled category is funded by changing the pool total, not on its own.
pub fn assert_category_funding(book: &Book, month: &str, ids: &[String]) -> std::result::Result<(), Refusal> {
    match active_for(book, month) {
        Some(p) if ids.iter().any(|id| p.flex_ids.contains(id)) => {
            Err(refuse("flex_member", "Change the flexible pool total instead of funding a pooled category"))
        }
        _ => Ok(()),
    }
}

pub fn assert_envelope_draft(book: &Book, month: &str) -> std::result::Result<(), Refusal> {
    if active_for(book, month).is_some() {
        return Err(refuse("flex_active", "Use Budget to fund the active flexible pool instead of starting a category draft"));
    }
    Ok(())
}

/// The amount to store for an assignment. The pool's total is stored as the part members do not hold.
pub fn stored_total(id: &str, total: i64, ledger: &BTreeMap<String, i64>, policy: Option<&Policy>) -> std::result::Result<i64, Refusal> {
    let Some(p) = policy.filter(|p| id == FLEX_POOL && p.active) else { return Ok(total) };
    let base: i128 = p.flex_ids.iter().map(|k| i128::from(ledger.get(k).copied().unwrap_or(0))).sum();
    safe(i128::from(total) - base).map_err(|_| input::invalid("Amount exceeds supported precision"))
}

/// What each member holds once the pool is dissolved.
fn leave(ids: &[String], available: &BTreeMap<String, i64>, envelope: &BTreeMap<String, Cat>, pool_available: i64) -> std::result::Result<Vec<(String, i64)>, Refusal> {
    let bad = |m: &str| input::invalid(m.to_owned());
    if pool_available < 0 {
        return Err(bad("Cover the flexible pool's overspending before leaving"));
    }
    if available.len() != ids.len() || ids.iter().any(|id| !available.contains_key(id)) {
        return Err(bad("Choose an available amount for every flexible category"));
    }
    let mut sum = 0i128;
    let mut out = Vec::new();
    for id in ids {
        let value = available[id];
        if value < 0 {
            return Err(bad("Available amounts must not be negative"));
        }
        sum += i128::from(value);
        let row = envelope.get(id);
        let total = i128::from(value) - i128::from(row.map_or(0, |r| r.available)) + i128::from(row.map_or(0, |r| r.assigned));
        out.push((id.clone(), safe(total).map_err(|_| bad("Amount exceeds supported precision"))?));
    }
    if sum != i128::from(pool_available) {
        return Err(bad("Destination amounts must equal the flexible pool's available money"));
    }
    let pool = envelope.get(FLEX_POOL);
    let carry = i128::from(pool.map_or(0, |p| p.available)) - i128::from(pool.map_or(0, |p| p.assigned)) + i128::from(pool.map_or(0, |p| p.activity));
    out.push((FLEX_POOL.to_owned(), safe(-carry).map_err(|_| bad("Amount exceeds supported precision"))?));
    Ok(out)
}

fn id_list(input: &Map<String, Value>, key: &str) -> std::result::Result<Vec<String>, Refusal> {
    let bad = || input::invalid("Choose at most 100 unique category ids");
    let Some(value) = input.get(key).filter(|v| !v.is_null()) else { return Ok(Vec::new()) };
    let list = value.as_array().ok_or_else(bad)?;
    let mut out: Vec<String> = Vec::new();
    for item in list {
        match item.as_str() {
            Some(s) if s.len() <= 128 && !out.iter().any(|x| x == s) => out.push(s.to_owned()),
            _ => return Err(bad()),
        }
    }
    if out.len() > 100 {
        return Err(bad());
    }
    Ok(out)
}

struct Plan {
    policy: Policy,
    assignments: Vec<(String, i64)>,
    requires_distribution: bool,
    view: Value,
}

fn prepare<H: Host + ?Sized>(host: &H, reviewed: &Reviewed, input: &Map<String, Value>) -> Result<std::result::Result<Plan, Refusal>> {
    let month = ask!(read_month(input));
    let date = today(host)?;
    if month != date[..7] {
        return Ok(Err(refuse("current_month_required", "Change budget mode in the current month; past policies are preserved")));
    }
    let mode = ask!(input::required_string(input, "mode", None));
    if mode != "flex" && mode != "envelopes" {
        return Ok(Err(input::invalid("mode must be one of flex, envelopes")));
    }
    let book = &reviewed.book;
    let iso = &reviewed.policy.iso;
    let before = budget::context(host, book, iso, &month, &date)?;
    if before.ready.is_none() {
        return Ok(Err(input::invalid("Review your currency and account balances before changing mode")));
    }
    let all = policies(book);
    let current = for_month(&all, &month).filter(|p| p.active).cloned();
    let live: Vec<&str> = book
        .categories
        .iter()
        .filter(|c| c["archived_at"].is_null() && c["id"] != "income" && c["id"] != "transfers")
        .filter_map(|c| c["id"].as_str())
        .collect();
    let future_nonzero = book.assignments.iter().any(|a| a["month"].as_str().is_some_and(|m| m > month.as_str()) && a["assigned_cents"].as_i64().unwrap_or(0) != 0);
    if future_nonzero {
        return Ok(Err(refuse("future_assignments", "Clear nonzero future assignments before changing mode; they will not be rewritten")));
    }
    if book.drafts.iter().max_by_key(|d| d["created_at"].as_str().unwrap_or("").to_owned()).is_some_and(|d| d["status"] == "open") {
        return Ok(Err(refuse("open_draft", "Finish your open first-budget draft before changing mode")));
    }
    let pool_of = |ctx: &Context| ctx.month.categories.get(FLEX_POOL).cloned().unwrap_or(Cat { assigned: 0, activity: 0, available: 0 });
    let mut assignments = Vec::new();
    let mut requires_distribution = false;
    let policy;
    if mode == "flex" {
        if current.is_some() {
            return Ok(Err(input::invalid("Leave the current pool before changing its members")));
        }
        let flex_ids = ask!(id_list(input, "flexIds"));
        let non_monthly = ask!(id_list(input, "nonMonthlyIds"));
        if flex_ids.is_empty() || flex_ids.iter().chain(&non_monthly).any(|id| !live.contains(&id.as_str())) || non_monthly.iter().any(|id| flex_ids.contains(id)) {
            return Ok(Err(input::invalid("Choose live expense categories in distinct groups, including at least one flexible category")));
        }
        let targeted = book.targets.iter().any(|t| {
            t["kind"] != "removed" && t["effective_month"].as_str().is_some_and(|m| m >= month.as_str()) && t["category_id"].as_str().is_some_and(|c| flex_ids.iter().any(|f| f == c))
        }) || crate::targets::for_month(book, &month).iter().any(|t| flex_ids.contains(&t.category));
        if targeted {
            return Ok(Err(refuse("flex_target", "Remove or move targets on proposed flexible categories before pooling their money")));
        }
        policy = Policy { month: month.clone(), active: true, flex_ids, non_monthly_ids: non_monthly };
    } else {
        let Some(current) = current.clone() else {
            return Ok(Err(input::invalid("This month is already using category envelopes")));
        };
        policy = Policy { month: month.clone(), active: false, flex_ids: vec![], non_monthly_ids: vec![] };
        let available = pool_of(&before).available;
        if available < 0 {
            return Ok(Err(input::invalid("Cover the flexible pool's overspending before leaving")));
        }
        let envelope = budget::context_with(host, book, iso, &month, &date, Some(&policy))?;
        match input.get("distribution") {
            None => requires_distribution = true,
            Some(Value::Object(values)) => {
                let mut amounts = BTreeMap::new();
                for (key, value) in values {
                    let one = Map::from_iter([("value".to_owned(), value.clone())]);
                    amounts.insert(key.clone(), ask!(input::ranged(&one, "value", 0, input::MAX_SAFE)));
                }
                assignments = ask!(leave(&current.flex_ids, &amounts, &envelope.month.categories, available));
            }
            Some(_) => return Ok(Err(input::invalid("Choose an available amount for every flexible category"))),
        }
    }
    let after = budget::context_with(host, book, iso, &month, &date, Some(&policy))?;
    let (pool, ready_after) = if mode == "flex" { (pool_of(&after), after.ready) } else { (pool_of(&before), before.ready) };
    let member_ids = if mode == "flex" { policy.flex_ids.clone() } else { current.map(|c| c.flex_ids).unwrap_or_default() };
    let name = |id: &str| book.categories.iter().find(|c| c["id"] == id).and_then(|c| c["name"].as_str()).unwrap_or(id).to_owned();
    let members: Vec<Value> = member_ids.iter().map(|id| json!({"id":id,"name":name(id)})).collect();
    let moves: Vec<Value> = assignments.iter().map(|(id, cents)| json!({"categoryId":id,"amountCents":cents})).collect();
    let view = json!({
        "status": "ok", "month": month, "mode": mode, "isoCurrency": iso, "revision": reviewed.policy.revision,
        "fingerprint": reviewed.fingerprint, "requiresDistribution": requires_distribution,
        "poolAvailableCents": pool.available, "poolAssignedCents": pool.assigned, "poolActivityCents": pool.activity,
        "readyBeforeCents": before.ready, "readyAfterCents": ready_after, "members": members, "assignments": moves,
    });
    Ok(Ok(Plan { policy, assignments, requires_distribution, view }))
}

/// `finance.flex.preview`. Reads only and takes no review.
pub fn preview<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let reviewed = ask!(budget::current(host)?);
    Ok(prepare(host, &reviewed, input)?.map(|p| p.view))
}

/// `finance.flex.configure`.
pub fn configure<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let plan = ask!(prepare(host, &reviewed, input)?);
    if plan.requires_distribution {
        return Ok(Err(input::invalid("Choose destinations for all available pool money before leaving")));
    }
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    let policy = &plan.policy;
    for (id, cents) in &plan.assignments {
        set_total(host, &policy.month, id, *cents)?;
    }
    let now = text(host, "call", "read", "now")?;
    let columns = |p: &Policy| vec![("active", json!(p.active)), ("flex_ids", json!(p.flex_ids)), ("non_monthly_ids", json!(p.non_monthly_ids)), ("updated_at", json!(now))];
    let mut upsert = Query::insert(values([vec![("month", json!(policy.month))], columns(policy)].concat()));
    upsert.conflict = Conflict::Update { columns: vec!["owner_user_id".into(), "month".into()], values: values(columns(policy)) };
    Client(host).query(FLEX, &upsert)?;
    let mode = if policy.active { "flex" } else { "envelopes" };
    log_as(host, "user", "flex.mode", json!({"month":policy.month,"mode":mode}), None)?;
    Ok(Ok(json!({"status":"ok","month":policy.month,"mode":mode})))
}

/// `finance.flex.assign`.
pub fn assign<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Outcome> {
    let Some(input) = body.as_object() else { return Ok(Err(input::invalid("Input must be an object"))) };
    let month = ask!(read_month(input));
    let cents = ask!(input::ranged(input, "amountCents", 0, BOUND));
    let previous = ask!(input::ranged(input, "previousCents", i64::MIN / 2, i64::MAX / 2));
    let expected = ask!(read_review(input));
    let reviewed = ask!(check(host, &expected)?);
    let Some(policy) = active_for(&reviewed.book, &month) else {
        return Ok(Err(input::invalid("Flexible mode is not active for this month")));
    };
    let date = today(host)?;
    let ctx = budget::context(host, &reviewed.book, &reviewed.policy.iso, &month, &date)?;
    if ctx.month.categories.get(FLEX_POOL).map_or(0, |c| c.assigned) != previous {
        return Ok(Err(stale()));
    }
    let ledger = budget::ledgers(&reviewed.book).remove(&month).unwrap_or_default();
    let delta = ask!(stored_total(FLEX_POOL, cents, &ledger, Some(&policy)));
    if !gate(host, &reviewed)? {
        return Ok(Err(stale()));
    }
    set_total(host, &month, FLEX_POOL, delta)?;
    log_as(host, "user", "flex.assign", json!({"month":month}), None)?;
    Ok(Ok(json!({"status":"ok","month":month,"assignedCents":cents})))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn policy(active: bool, ids: &[&str]) -> Policy {
        Policy { month: "2026-11".into(), active, flex_ids: ids.iter().map(|s| (*s).into()).collect(), non_monthly_ids: vec![] }
    }

    #[test]
    fn the_newest_policy_at_or_before_the_month_wins() {
        let mut older = policy(true, &["a"]);
        older.month = "2026-09".into();
        let all = vec![older, policy(false, &[])];
        assert!(!for_month(&all, "2026-12").unwrap().active);
        assert!(for_month(&all, "2026-10").unwrap().active);
        assert!(for_month(&all, "2026-08").is_none());
    }

    #[test]
    fn routing_sums_members_into_the_pool() {
        let input = BTreeMap::from([("a".to_owned(), 100), ("b".to_owned(), 50), ("c".to_owned(), 7), (FLEX_POOL.to_owned(), 10)]);
        let out = route(&input, Some(&policy(true, &["a", "b"]))).unwrap();
        assert_eq!(out, BTreeMap::from([("c".to_owned(), 7), (FLEX_POOL.to_owned(), 160)]));
        assert_eq!(route(&input, Some(&policy(false, &["a"]))).unwrap(), input);
    }

    #[test]
    fn the_pool_total_is_stored_as_a_delta() {
        let ledger = BTreeMap::from([("a".to_owned(), 100), ("b".to_owned(), 50)]);
        let p = policy(true, &["a", "b"]);
        assert_eq!(stored_total(FLEX_POOL, 400, &ledger, Some(&p)).unwrap(), 250);
        assert_eq!(stored_total("a", 400, &ledger, Some(&p)).unwrap(), 400);
        assert_eq!(stored_total(FLEX_POOL, 400, &ledger, None).unwrap(), 400);
    }

    #[test]
    fn leaving_needs_every_member_and_conserves_the_pool() {
        let ids = vec!["a".to_owned(), "b".to_owned()];
        let envelope = BTreeMap::from([
            ("a".to_owned(), Cat { assigned: 0, activity: 0, available: 0 }),
            (FLEX_POOL.to_owned(), Cat { assigned: 300, activity: 100, available: 200 }),
        ]);
        let good = BTreeMap::from([("a".to_owned(), 120), ("b".to_owned(), 80)]);
        let out = leave(&ids, &good, &envelope, 200).unwrap();
        assert_eq!(out, vec![("a".to_owned(), 120), ("b".to_owned(), 80), (FLEX_POOL.to_owned(), -(200 - 300 + 100))]);
        let short = BTreeMap::from([("a".to_owned(), 120), ("b".to_owned(), 70)]);
        assert!(leave(&ids, &short, &envelope, 200).is_err());
        assert!(leave(&ids, &BTreeMap::from([("a".to_owned(), 200)]), &envelope, 200).is_err());
        assert!(leave(&ids, &good, &envelope, -1).is_err());
    }
}
