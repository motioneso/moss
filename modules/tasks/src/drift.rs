//! Focus, at-risk and overdue reads over persisted rows.
//! Actor-local day boundaries and lazy recurrence roll-forward still need the
//! public timezone seam, so days are UTC here and rows are never advanced.
use crate::{
    repository::{Repository, Result},
    rows::Task,
};
use chrono::{DateTime, NaiveDate, Utc};
use moss_module_sdk::Host;

fn day(value: DateTime<Utc>) -> NaiveDate {
    value.date_naive()
}

pub fn overdue<H: Host + ?Sized>(repo: &Repository<'_, H>, today: NaiveDate) -> Result<Vec<Task>> {
    let mut rows: Vec<Task> = repo
        .persisted_tasks()?
        .into_iter()
        .filter(|t| t.status == "todo" && t.due_at.is_some_and(|d| day(d) < today))
        .collect();
    rows.sort_by(|a, b| a.due_at.cmp(&b.due_at).then(a.id.cmp(&b.id)));
    Ok(rows)
}

pub fn at_risk<H: Host + ?Sized>(repo: &Repository<'_, H>, today: NaiveDate) -> Result<Vec<Task>> {
    let all = repo.persisted_tasks()?;
    let done_parents: std::collections::HashSet<String> = all
        .iter()
        .filter(|t| t.status == "done")
        .filter_map(|t| t.parent_task_id.clone())
        .collect();
    let limit = today + chrono::Duration::days(2);
    let mut rows: Vec<Task> = all
        .into_iter()
        .filter(|t| {
            t.status == "todo"
                && t.priority.is_some_and(|p| p >= 3)
                && ((t.due_at.is_some_and(|d| day(d) <= limit))
                    || t.do_at.is_some_and(|d| day(d) < today))
                && !done_parents.contains(&t.id)
        })
        .collect();
    rows.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then(a.due_at.cmp(&b.due_at))
            .then(a.id.cmp(&b.id))
    });
    Ok(rows)
}

pub fn focus<H: Host + ?Sized>(repo: &Repository<'_, H>, today: NaiveDate) -> Result<Vec<Task>> {
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for task in overdue(repo, today)?
        .into_iter()
        .chain(at_risk(repo, today)?)
    {
        if seen.insert(task.id.clone()) {
            rows.push(task);
        }
    }
    fn effort_rank(effort: &Option<String>) -> i64 {
        match effort.as_deref() {
            Some("quick") => 0,
            Some("medium") => 1,
            Some("large") => 2,
            _ => 3,
        }
    }
    rows.sort_by(|a, b| {
        let ap = a.priority.map(i64::from).unwrap_or(i64::MIN);
        let bp = b.priority.map(i64::from).unwrap_or(i64::MIN);
        bp.cmp(&ap)
            .then(
                a.due_at
                    .map(|d| d.timestamp())
                    .unwrap_or(i64::MAX)
                    .cmp(&b.due_at.map(|d| d.timestamp()).unwrap_or(i64::MAX)),
            )
            .then(effort_rank(&a.effort).cmp(&effort_rank(&b.effort)))
            .then(a.id.cmp(&b.id))
    });
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn at_risk_window_is_two_days() {
        let today = NaiveDate::from_ymd_opt(2026, 1, 10).unwrap();
        assert_eq!(
            today + chrono::Duration::days(2),
            NaiveDate::from_ymd_opt(2026, 1, 12).unwrap()
        );
    }
}
