//! `calendar.createEvent`, `calendar.deleteEvent` and `calendar.rescheduleEvent`.
//!
//! The guest validates input, resolves the requested window in the saved account timezone and
//! shapes the result. Every provider effect goes through the public Connectors interface, so a
//! missing Connectors package fails the call closed and nothing is written.
use crate::{
    draft_tool::trim,
    visible_events::{clock_and_zone, iso, resolve_zone, Zone},
    Error, Result,
};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};

const MIN_DURATION: i64 = 15;
const MAX_DURATION: i64 = 480;
const DEFAULT_DURATION: i64 = 120;
const DEFAULT_TITLE: &str = "Focus time";

/// A resolved request window. `start..end` is the search window; `duration_minutes` is the
/// requested block length and is what the provider inserts.
#[derive(Debug, PartialEq)]
pub struct Window {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub duration_minutes: i64,
    pub title: String,
}

fn invalid(message: &str) -> Error {
    Error::new(400, message)
}

fn clamp_duration(value: Option<&Value>) -> i64 {
    match value.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => (n.trunc() as i64).clamp(MIN_DURATION, MAX_DURATION),
        _ => DEFAULT_DURATION,
    }
}

/// An RFC 3339 instant, or a date or zoneless date-time read as UTC (as `new Date` does).
fn parse_instant(text: &str) -> Option<DateTime<Utc>> {
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Some(at.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(at) = NaiveDateTime::parse_from_str(text, format) {
            return Some(at.and_utc());
        }
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|at| at.and_utc())
}

/// `yyyy-mm-dd` with ASCII digits only, and a real calendar date.
fn parse_date(text: &str) -> Option<NaiveDate> {
    let b = text.as_bytes();
    let shaped = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        });
    if !shaped {
        return None;
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}

fn wall_clock<Z: TimeZone>(zone: &Z, date: NaiveDate, hour: u32) -> Option<DateTime<Utc>> {
    let mut at = date.and_hms_opt(hour, 0, 0)?;
    // A clock change can remove the hour; step forward to the first instant that exists.
    for _ in 0..3 {
        if let Some(local) = zone.from_local_datetime(&at).earliest() {
            return Some(local.with_timezone(&Utc));
        }
        at += Duration::hours(1);
    }
    None
}

fn band(part: &str) -> Option<(u32, u32)> {
    match part {
        "morning" => Some((9, 12)),
        "afternoon" => Some((12, 17)),
        "evening" => Some((17, 21)),
        _ => None,
    }
}

/// Resolves the create request. A relative request with no date means tomorrow.
pub fn resolve_window(input: &Value, now: DateTime<Utc>, saved_zone: &str) -> Result<Window> {
    let duration_minutes = clamp_duration(input.get("durationMinutes"));
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(DEFAULT_TITLE)
        .to_string();
    let text = |key: &str| input.get(key).and_then(Value::as_str);

    if let Some(start) = text("start").filter(|s| !s.is_empty()) {
        let start = parse_instant(start)
            .ok_or_else(|| invalid("start must be a valid RFC3339 datetime"))?;
        let end = start + Duration::minutes(duration_minutes);
        return Ok(Window {
            start,
            end,
            duration_minutes,
            title,
        });
    }
    let date = match text("date") {
        Some(date) => Some(parse_date(date).ok_or_else(|| {
            if date.len() == 10 && date.bytes().filter(u8::is_ascii_digit).count() == 8 {
                invalid("date is not a valid calendar date")
            } else {
                invalid("date must be in yyyy-mm-dd format")
            }
        })?),
        None => None,
    };
    let part = text("partOfDay").unwrap_or("morning");
    let (from, to) =
        band(part).ok_or_else(|| invalid("partOfDay must be morning, afternoon or evening"))?;
    let zone = resolve_zone(saved_zone)
        .ok_or_else(|| Error::new(503, "Calendar timezone is unavailable"))?;
    let unreadable = || invalid("date is not a valid calendar date");
    let (start, end) = match &zone {
        Zone::Named(z) => band_window(z, date, now, from, to),
        Zone::Fixed(z) => band_window(z, date, now, from, to),
    }
    .ok_or_else(unreadable)?;
    Ok(Window {
        start,
        end,
        duration_minutes,
        title,
    })
}

fn band_window<Z: TimeZone>(
    zone: &Z,
    date: Option<NaiveDate>,
    now: DateTime<Utc>,
    from: u32,
    to: u32,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let day = match date {
        Some(day) => day,
        None => now.with_timezone(zone).date_naive().succ_opt()?,
    };
    Some((wall_clock(zone, day, from)?, wall_clock(zone, day, to)?))
}

pub fn create(host: &impl Host, input: &Value) -> Result<Value> {
    if !input.is_object() {
        return Err(invalid("Invalid calendar event request"));
    }
    let (now, zone) = clock_and_zone(host)?;
    let window = resolve_window(input, now, &zone)?;
    let reply = Client(host).api(
        "connectors",
        "createCalendarEvent",
        json!({
            "windowStart": iso(window.start),
            "windowEnd": iso(window.end),
            "durationMinutes": window.duration_minutes,
            "title": window.title,
        }),
    )?;
    Ok(json!({"data": reply}))
}

pub fn delete(host: &impl Host, input: &Value) -> Result<Value> {
    let event_id = input
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let Some(event_id) = event_id else {
        return Ok(json!({"data":{
            "deleted": false,
            "googleDeleted": "skipped-error",
            "cacheMirror": "not-cached",
            "message": "eventId is required"
        }}));
    };
    let reply = Client(host).api(
        "connectors",
        "deleteCalendarEvent",
        json!({"eventId": event_id}),
    )?;
    Ok(json!({"data": reply}))
}

pub fn reschedule(host: &impl Host, input: &Value) -> Result<Value> {
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    let reference = text("eventRef").filter(|r| !r.is_empty());
    let start = text("newStart").and_then(parse_instant);
    let end = text("newEnd").and_then(parse_instant);
    let (Some(reference), Some(start), Some(end)) = (reference, start, end) else {
        return Ok(json!({"data":{
            "ok": false,
            "reason": "not_found",
            "message": "eventRef, newStart and newEnd are required"
        }}));
    };
    let reply = Client(host).api(
        "connectors",
        "rescheduleCalendarEvent",
        json!({"eventRef": reference, "newStart": iso(start), "newEnd": iso(end)}),
    )?;
    Ok(json!({"data": reply}))
}
