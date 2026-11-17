//! The day's dose slots, the daily adherence summary and the counts other modules may read.
//! Counts never carry a medication name or id.
use crate::{
    medications::{self, LOGS},
    schedule::{self, Log, Med},
    util::bad_request,
};
use chrono::{DateTime, Duration, NaiveDate};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub(crate) const DAY_MS: i64 = 86_400_000;

fn query_text(request: &RouteRequest, name: &str) -> Option<String> {
    match request.query.get(name)? {
        Value::String(t) => Some(t.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

pub(crate) fn meds<H: Host + ?Sized>(host: &H) -> Result<Vec<Med>> {
    medications::all(host)?.iter().map(schedule::med_from_row).collect()
}

fn logs_where<H: Host + ?Sized>(host: &H, filter: Filter) -> Result<Vec<Log>> {
    let mut query = Query::select(filter);
    query.order = vec![Order { column: "logged_at".into(), descending: true }];
    Client(host).query(LOGS, &query)?.iter().map(schedule::log_from_row).collect()
}

fn at_least(column: &str, ms: i64) -> Filter {
    Filter::Compare { column: column.into(), op: Compare::Ge, value: json!(schedule::iso_ms(ms)) }
}

fn before(column: &str, ms: i64) -> Filter {
    Filter::Compare { column: column.into(), op: Compare::Lt, value: json!(schedule::iso_ms(ms)) }
}

/// Logs that can belong to one local date.
fn logs_for_date<H: Host + ?Sized>(host: &H, day: NaiveDate, zone: &str) -> Result<Vec<Log>> {
    let midnight = day.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc().timestamp_millis();
    let scheduled = Filter::And { filters: vec![at_least("scheduled_for", midnight - DAY_MS), before("scheduled_for", midnight + 2 * DAY_MS)] };
    let unscheduled = Filter::And {
        filters: vec![
            Filter::Null { column: "scheduled_for".into(), not: false },
            at_least("logged_at", schedule::local_day_start(day, zone)),
            before("logged_at", schedule::local_day_start(day + Duration::days(1), zone)),
        ],
    };
    logs_where(host, Filter::Or { filters: vec![scheduled, unscheduled] })
}

/// Logs over a rolling window. A scheduled log goes by its slot, any other by when it was logged.
pub(crate) fn logs_since<H: Host + ?Sized>(host: &H, since_ms: i64) -> Result<Vec<Log>> {
    let scheduled = Filter::And { filters: vec![Filter::Null { column: "scheduled_for".into(), not: true }, at_least("scheduled_for", since_ms)] };
    let unscheduled = Filter::And { filters: vec![Filter::Null { column: "scheduled_for".into(), not: false }, at_least("logged_at", since_ms)] };
    logs_where(host, Filter::Or { filters: vec![scheduled, unscheduled] })
}

/// `GET /wellness/medications/schedule?date=YYYY-MM-DD`.
pub fn day<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let text = match query_text(request, "date") {
        Some(t) if t.len() == 10 && NaiveDate::parse_from_str(&t, "%Y-%m-%d").is_ok() => t,
        _ => return Ok(bad_request("date must be an ISO date (YYYY-MM-DD)")),
    };
    let date = NaiveDate::parse_from_str(&text, "%Y-%m-%d").map_err(|_| Error::new("Invalid date"))?;
    let context = medications::today(host)?;
    let zone = context["timezone"].as_str().unwrap_or("UTC");
    let (meds, logs) = (meds(host)?, logs_for_date(host, date, zone)?);
    Ok(Response::new(200, json!({"date": text, "slots": schedule::compute(&meds, &logs, date)})))
}

fn since_days(request: &RouteRequest) -> Option<i64> {
    match query_text(request, "sinceDays") {
        None => Some(30),
        Some(t) if t.is_empty() => Some(30),
        Some(t) => t.trim().parse::<f64>().ok().filter(|n| n.fract() == 0.0 && (1.0..=90.0).contains(n)).map(|n| n as i64),
    }
}

/// One day's slots and counts, from the logs that belong to that day.
pub(crate) fn day_slots(meds: &[Med], logs: &[Log], date: NaiveDate, zone: &str) -> Vec<Value> {
    let todays: Vec<Log> = logs.iter().filter(|l| schedule::log_in_day(l, date, zone)).cloned().collect();
    schedule::compute(meds, &todays, date)
}

pub(crate) fn scheduled(slots: &[Value]) -> impl Iterator<Item = &Value> {
    slots.iter().filter(|s| s["asNeeded"] == false)
}

/// `GET /wellness/medications/logs?sinceDays=N`. Missed doses count in the day's total.
pub fn summary<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let Some(since) = since_days(request) else { return Ok(bad_request("sinceDays must be 1\u{2013}90")) };
    let context = medications::today(host)?;
    let zone = context["timezone"].as_str().unwrap_or("UTC");
    let today = NaiveDate::parse_from_str(context["date"].as_str().unwrap_or(""), "%Y-%m-%d").map_err(|_| Error::new("Invalid date"))?;
    let now = DateTime::parse_from_rfc3339(context["now"].as_str().unwrap_or("")).map_err(|_| Error::new("Invalid moment"))?.timestamp_millis();
    let (meds, logs) = (meds(host)?, logs_since(host, now - since * DAY_MS)?);
    let mut days = Vec::new();
    for back in (0..since).rev() {
        let date = schedule::previous_day(today, back);
        let slots = day_slots(&meds, &logs, date, zone);
        days.push(json!({
            "date": date.format("%Y-%m-%d").to_string(),
            "scheduledCount": scheduled(&slots).count(),
            "takenCount": scheduled(&slots).filter(|s| s["status"] == "taken").count(),
            "doses": slots.iter().map(|s| json!({"medicationId":s["medicationId"],"name":s["name"],"status":s["status"],"prn":s["asNeeded"]})).collect::<Vec<_>>(),
        }));
    }
    Ok(Response::new(200, json!({"days": days})))
}

const WINDOW_DAYS: i64 = 7;

/// The seven-day counts another module may read, and only while the person allows assistant
/// access. The answer holds numbers and no medication name, id, dose or reason.
pub fn counts<H: Host + ?Sized>(host: &H) -> Result<Value> {
    if !crate::consent::effective(host)? {
        return Ok(json!({"error":"Consent not granted","code":"WELLNESS_CONSENT_REQUIRED"}));
    }
    let context = medications::today(host)?;
    let zone = context["timezone"].as_str().unwrap_or("UTC");
    let today = NaiveDate::parse_from_str(context["date"].as_str().unwrap_or(""), "%Y-%m-%d").map_err(|_| Error::new("Invalid date"))?;
    let now = DateTime::parse_from_rfc3339(context["now"].as_str().unwrap_or("")).map_err(|_| Error::new("Invalid moment"))?.timestamp_millis();
    let meds = meds(host)?;
    // Logged rows go by when they were logged, as the old summary did.
    let logged = logs_where(host, at_least("logged_at", now - WINDOW_DAYS * DAY_MS))?;
    let count = |status: &str| logged.iter().filter(|l| l.status == status).count() as i64;
    let (taken, skipped, prn) = (count("taken"), count("skipped"), count("prn"));
    let mut expected = 0_i64;
    for back in 0..WINDOW_DAYS {
        expected += scheduled(&day_slots(&meds, &logged, schedule::previous_day(today, back), zone)).count() as i64;
    }
    let total = expected.max(taken + skipped);
    let rate = if total > 0 {
        let share = ((taken as f64 / total as f64) * 100.0).round() / 100.0;
        // 0 and 1 are written without a decimal point, as the old server wrote them.
        if share.fract() == 0.0 { json!(share as i64) } else { json!(share) }
    } else {
        Value::Null
    };
    Ok(json!({"windowDays": WINDOW_DAYS, "scheduled": total, "taken": taken, "skipped": skipped, "prn": prn, "adherenceRate": rate}))
}
