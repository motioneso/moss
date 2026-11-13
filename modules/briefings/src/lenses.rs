//! Evening day math. Everything here is pure: the clock and the zone are passed in. Days are
//! compared as calendar dates in the owner's zone, so the edges of a day and daylight-saving
//! changes come out exact.
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::Value;

/// One task as the evening lenses see it.
#[derive(Debug, Clone, PartialEq)]
pub struct EveningTask {
    pub id: String,
    pub title: String,
    pub do_at: Option<String>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
}

/// The three ways the evening review looks at tasks.
#[derive(Debug, Default, PartialEq)]
pub struct Lenses {
    pub completed_today: Vec<EveningTask>,
    pub slipped: Vec<EveningTask>,
    pub carrying_forward: Vec<EveningTask>,
}

fn instant(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&Utc))
}

/// The owner's calendar date for a time, or `None` when the text is not a time.
pub fn local_day(value: &Value, zone: Tz) -> Option<NaiveDate> {
    let at = instant(value.as_str()?)?;
    Some(at.with_timezone(&zone).date_naive())
}

/// The instant of local midnight at the start of `now`'s day.
pub fn local_day_start(now: DateTime<Utc>, zone: Tz) -> Option<DateTime<Utc>> {
    let day = now.with_timezone(&zone).date_naive();
    // A zone that skips midnight starts its day at the first hour that exists.
    (0..4).find_map(|hour| {
        zone.from_local_datetime(&day.and_hms_opt(hour, 0, 0)?).earliest().map(|t| t.with_timezone(&Utc))
    })
}

fn task(raw: &Value) -> Option<EveningTask> {
    let title = raw["title"].as_str().filter(|t| !t.is_empty())?;
    let text = |key: &str| raw[key].as_str().map(str::to_owned);
    Some(EveningTask {
        id: text("id").unwrap_or_default(),
        title: title.to_owned(),
        do_at: text("doAt"),
        due_at: text("dueAt"),
        completed_at: text("completedAt"),
    })
}

/// Sorts finished and open tasks into the three lenses. Done today stays done, open work planned
/// for today slipped, and open work planned for an earlier day carries forward.
pub fn partition(completed: &[Value], open: &[Value], now: DateTime<Utc>, zone: Tz) -> Lenses {
    let today = now.with_timezone(&zone).date_naive();
    let mut out = Lenses::default();
    for item in completed.iter().filter_map(task) {
        if item.completed_at.as_deref().and_then(|t| local_day(&Value::from(t), zone)) == Some(today) {
            out.completed_today.push(item);
        }
    }
    for item in open.iter().filter_map(task) {
        let days: Vec<NaiveDate> = [&item.do_at, &item.due_at]
            .into_iter()
            .filter_map(|t| t.as_deref().and_then(|t| local_day(&Value::from(t), zone)))
            .collect();
        if days.contains(&today) {
            out.slipped.push(item);
        } else if days.iter().any(|d| *d < today) {
            out.carrying_forward.push(item);
        }
    }
    out
}

fn date_of(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text.get(..10)?, "%Y-%m-%d").ok()
}

/// All-day rows are UTC midnights with an exclusive end date, so they compare as dates.
fn all_day_covers(event: &Value, starts: &str, day: NaiveDate) -> bool {
    let Some(start) = date_of(starts) else { return false };
    match event["endsAt"].as_str().and_then(date_of) {
        Some(end) if end > start => start <= day && day < end,
        _ => start == day,
    }
}

/// Keeps tomorrow's events and the rest of this evening's.
pub fn filter_calendar(events: &[Value], now: DateTime<Utc>, zone: Tz) -> Vec<Value> {
    let today = now.with_timezone(&zone).date_naive();
    let tomorrow = today + Duration::days(1);
    events
        .iter()
        .filter(|event| {
            let Some(starts) = event["startsAt"].as_str() else { return false };
            let Some(start) = instant(starts) else { return false };
            if event["allDay"] == true {
                return all_day_covers(event, starts, tomorrow);
            }
            let day = start.with_timezone(&zone).date_naive();
            day == tomorrow || (day == today && start > now)
        })
        .cloned()
        .collect()
}
