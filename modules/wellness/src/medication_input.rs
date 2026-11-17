//! Medication and dose-log request bodies. The old server first ran the route schema (which
//! turned text into numbers, wrapped single values into lists and read null as zero, empty
//! text or false in several places), then ran the route's own rules on the result. This file
//! does both steps in that order and reports the first failure with the same words.
use crate::input::{coerce_text, int_or_null, nullable_text, object, required, trimmed, union, unwrap_single};
use serde_json::{Map, Value};

pub const FREQUENCIES: [&str; 8] = [
    "once_daily",
    "times_per_day",
    "specific_weekdays",
    "every_n_hours",
    "as_needed",
    "cyclical",
    "every_interval",
    "monthly",
];
const POSITIONS: [&str; 5] = ["first", "second", "third", "fourth", "last"];

/// Everything that says when a medication is taken. Absent and null both read as `None`.
#[derive(Clone, Debug, Default)]
pub struct Schedule {
    pub frequency_type: String,
    pub times_per_day: Option<i64>,
    pub interval_hours: Option<i64>,
    pub weekdays: Option<Vec<i64>>,
    pub schedule_times: Option<Vec<String>>,
    pub cycle_days_on: Option<i64>,
    pub cycle_days_off: Option<i64>,
    pub cycle_anchor_date: Option<String>,
    pub interval_unit: Option<String>,
    pub interval_count: Option<i64>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub month_kind: Option<String>,
    pub month_day: Option<i64>,
    pub month_day_is_last: bool,
    pub month_weekday_position: Option<String>,
    pub month_weekday: Option<i64>,
}

pub struct NewMedication {
    pub name: String,
    pub dosage: Option<String>,
    pub form: Option<String>,
    pub notes: Option<String>,
    pub reminders_enabled: Option<bool>,
    pub schedule: Schedule,
}

pub struct MedicationChange {
    pub name: Option<String>,
    pub dosage: Option<Option<String>>,
    pub form: Option<Option<String>>,
    pub notes: Option<Option<String>>,
    pub active: Option<bool>,
    pub reminders_enabled: Option<bool>,
    pub schedule: Option<Schedule>,
}

pub struct NewDose {
    pub status: String,
    pub dose: Option<String>,
    pub prn_reason: Option<String>,
    pub scheduled_for: Option<String>,
}

type Fields = Map<String, Value>;

fn boolean(value: &Value) -> Option<bool> {
    match unwrap_single(value) {
        Value::Bool(b) => Some(*b),
        Value::Null => Some(false),
        Value::String(t) if t == "true" => Some(true),
        Value::String(t) if t == "false" || t.is_empty() => Some(false),
        Value::Number(n) if n.as_f64() == Some(1.0) => Some(true),
        Value::Number(n) if n.as_f64() == Some(0.0) => Some(false),
        _ => None,
    }
}

/// A true-or-false field that may also be null. Null reads as false first.
fn boolean_or_null(map: &Fields, name: &str) -> Result<Option<bool>, String> {
    match map.get(name) {
        None => Ok(None),
        Some(v) => boolean(v).map(Some).ok_or_else(|| union(&format!("body/{name}"), &["be boolean", "be null"])),
    }
}

fn plain_boolean(map: &Fields, name: &str) -> Result<Option<bool>, String> {
    match map.get(name) {
        None => Ok(None),
        Some(v) => boolean(v).map(Some).ok_or_else(|| format!("body/{name} must be boolean")),
    }
}

/// A choice from a list, or null. Empty text and null both mean none.
fn choice_or_null(map: &Fields, name: &str, allowed: &[&str]) -> Result<Option<String>, String> {
    let Some(value) = map.get(name) else { return Ok(None) };
    let at = format!("body/{name}");
    match coerce_text(value) {
        Some(t) if t.is_empty() => Ok(None),
        Some(t) if allowed.contains(&t.as_str()) => Ok(Some(t)),
        _ => Err(union(&at, &["be equal to one of the allowed values", "be null"])),
    }
}

fn int(map: &Fields, name: &str, min: i64, max: i64) -> Result<Option<i64>, String> {
    Ok(int_or_null(map, name, min, max)?.flatten())
}

/// A list of whole numbers from 1 to 7, or null.
fn weekdays(map: &Fields) -> Result<Option<Vec<i64>>, String> {
    let Some(value) = map.get("weekdays") else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let items: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        scalar => vec![scalar],
    };
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let at = format!("body/weekdays/{i}");
        let whole = match unwrap_single(item) {
            Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64),
            Value::Bool(b) => Some(*b as i64),
            Value::Null => Some(0),
            Value::String(t) => t.trim().parse::<f64>().ok().filter(|f| !t.trim().is_empty() && f.fract() == 0.0).map(|f| f as i64),
            _ => None,
        };
        let failure = match whole {
            None => Some("be integer"),
            Some(n) if n < 1 => Some("be >= 1"),
            Some(n) if n > 7 => Some("be <= 7"),
            Some(_) => None,
        };
        if let Some(f) = failure {
            return Err(format!("{at} must {f}, body/weekdays must be null, body/weekdays must match a schema in anyOf"));
        }
        out.push(whole.unwrap());
    }
    Ok(Some(out))
}

fn times(map: &Fields) -> Result<Option<Vec<String>>, String> {
    let Some(value) = map.get("scheduleTimes") else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let items: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        scalar => vec![scalar],
    };
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        match coerce_text(item) {
            Some(t) => out.push(t),
            None => {
                return Err(format!(
                    "body/scheduleTimes/{i} must be string, body/scheduleTimes must be null, body/scheduleTimes must match a schema in anyOf"
                ))
            }
        }
    }
    Ok(Some(out))
}

/// Clock times the table can store, as `HH:MM` or `HH:MM:SS`.
fn clock_ok(text: &str) -> bool {
    let parts: Vec<&str> = text.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return false;
    }
    let number = |p: &str, max: u32| p.len() == 2 && p.chars().all(|c| c.is_ascii_digit()) && p.parse::<u32>().is_ok_and(|n| n <= max);
    number(parts[0], 23) && number(parts[1], 59) && parts.get(2).map_or(true, |s| number(s, 59))
}

/// A calendar date in `YYYY-MM-DD` form that exists.
fn date_key(value: &Option<String>, field: &str) -> Result<(), String> {
    let Some(text) = value else { return Ok(()) };
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    if !shaped {
        return Err(format!("{field} must be a date in YYYY-MM-DD form"));
    }
    if chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_err() {
        return Err(format!("{field} must be a real calendar date"));
    }
    Ok(())
}

fn schedule_fields(map: &Fields) -> Result<Schedule, String> {
    let mut s = Schedule::default();
    // The route schema reads each field in this order and reports the first failure.
    s.frequency_type = crate::input::choice(map, "frequencyType", &FREQUENCIES)?.unwrap_or_default();
    s.times_per_day = int(map, "timesPerDay", 1, 24)?;
    s.interval_hours = int(map, "intervalHours", 1, 24)?;
    s.weekdays = weekdays(map)?;
    s.schedule_times = times(map)?;
    s.cycle_days_on = int(map, "cycleDaysOn", 1, i64::MAX)?;
    s.cycle_days_off = int(map, "cycleDaysOff", 0, i64::MAX)?;
    let anchor = nullable_text(map, "cycleAnchorDate")?;
    s.interval_unit = choice_or_null(map, "intervalUnit", &["days", "weeks", "months"])?;
    s.interval_count = int(map, "intervalCount", 1, i64::MAX)?;
    let start = nullable_text(map, "startDate")?;
    let end = nullable_text(map, "endDate")?;
    s.month_kind = choice_or_null(map, "monthKind", &["date", "weekdayPosition"])?;
    s.month_day = int(map, "monthDay", 1, 31)?;
    s.month_day_is_last = boolean_or_null(map, "monthDayIsLast")?.unwrap_or(false);
    s.month_weekday_position = choice_or_null(map, "monthWeekdayPosition", &POSITIONS)?;
    s.month_weekday = int(map, "monthWeekday", 1, 7)?;
    s.cycle_anchor_date = anchor;
    s.start_date = start;
    s.end_date = end;
    Ok(s)
}

fn non_empty<T>(value: &Option<Vec<T>>) -> bool {
    value.as_ref().is_some_and(|v| !v.is_empty())
}

fn bounds(value: &Option<i64>, field: &str, min: i64, max: i64) -> Result<(), String> {
    match value {
        Some(n) if !(min..=max).contains(n) => Err(format!("{field} must be an integer from {min} to {max}")),
        _ => Ok(()),
    }
}

fn iso_weekdays(days: &Option<Vec<i64>>) -> Result<(), String> {
    match days {
        Some(d) if d.iter().any(|n| !(1..=7).contains(n)) => {
            Err("weekdays must be ISO weekday integers 1 (Mon) to 7 (Sun)".into())
        }
        _ => Ok(()),
    }
}

/// The rules every schedule meets, on create and on a schedule change alike.
fn check_schedule(s: &Schedule) -> Result<(), String> {
    let f = s.frequency_type.as_str();
    bounds(&s.times_per_day, "timesPerDay", 1, 24)?;
    bounds(&s.interval_hours, "intervalHours", 1, 24)?;
    bounds(&s.cycle_days_on, "cycleDaysOn", 1, 366)?;
    bounds(&s.cycle_days_off, "cycleDaysOff", 0, 366)?;
    if f == "times_per_day" && s.times_per_day.is_none() {
        return Err("timesPerDay is required for times_per_day".into());
    }
    if f == "every_n_hours" && s.interval_hours.is_none() {
        return Err("intervalHours is required for every_n_hours".into());
    }
    if f == "specific_weekdays" {
        if !non_empty(&s.weekdays) {
            return Err("weekdays is required for specific_weekdays".into());
        }
        iso_weekdays(&s.weekdays)?;
    }
    let has_times = non_empty(&s.schedule_times);
    if ["once_daily", "times_per_day", "specific_weekdays", "cyclical"].contains(&f) && !has_times {
        return Err(format!("scheduleTimes is required for {f}"));
    }
    if f == "times_per_day" && has_times {
        let count = s.schedule_times.as_ref().map_or(0, Vec::len) as i64;
        if Some(count) != s.times_per_day {
            return Err("scheduleTimes length must equal timesPerDay".into());
        }
    }
    if f == "cyclical" && (s.cycle_anchor_date.is_none() || s.cycle_days_on.is_none()) {
        return Err("cycleAnchorDate and cycleDaysOn are required for cyclical".into());
    }
    bounds(&s.interval_count, "intervalCount", 1, 999)?;
    bounds(&s.month_day, "monthDay", 1, 31)?;
    bounds(&s.month_weekday, "monthWeekday", 1, 7)?;
    if f == "every_interval" {
        let unit = s.interval_unit.as_deref();
        if !matches!(unit, Some("days" | "weeks" | "months")) {
            return Err("intervalUnit must be one of days, weeks, months".into());
        }
        if s.interval_count.is_none() {
            return Err("intervalCount is required for every_interval".into());
        }
        if !has_times {
            return Err("scheduleTimes is required for every_interval".into());
        }
        if unit == Some("weeks") {
            if !non_empty(&s.weekdays) {
                return Err("weekdays is required for every_interval with weeks unit".into());
            }
            iso_weekdays(&s.weekdays)?;
        }
    }
    if f == "monthly" {
        let kind = s.month_kind.as_deref();
        if !matches!(kind, Some("date" | "weekdayPosition")) {
            return Err("monthKind must be one of date, weekdayPosition".into());
        }
        if kind == Some("date") && s.month_day.is_some() == s.month_day_is_last {
            return Err("exactly one of monthDay or monthDayIsLast is required for monthly by date".into());
        }
        if kind == Some("weekdayPosition") {
            if !s.month_weekday_position.as_deref().is_some_and(|p| POSITIONS.contains(&p)) {
                return Err("monthWeekdayPosition must be one of first, second, third, fourth, last".into());
            }
            if s.month_weekday.is_none() {
                return Err("monthWeekday is required for monthly by weekdayPosition".into());
            }
        }
        if !has_times {
            return Err("scheduleTimes is required for monthly".into());
        }
    }
    date_key(&s.start_date, "startDate")?;
    date_key(&s.end_date, "endDate")?;
    date_key(&s.cycle_anchor_date, "cycleAnchorDate")?;
    if f == "every_interval" || f == "monthly" {
        if s.start_date.as_deref().map_or(true, |d| d.trim().is_empty()) {
            return Err(format!("startDate is required for {f}"));
        }
    }
    if let (Some(end), Some(start)) = (&s.end_date, &s.start_date) {
        if end < start {
            return Err("endDate must not be before startDate".into());
        }
    }
    if f == "as_needed" {
        let named = [
            ("scheduleTimes", s.schedule_times.is_some()),
            ("timesPerDay", s.times_per_day.is_some()),
            ("intervalHours", s.interval_hours.is_some()),
            ("weekdays", s.weekdays.is_some()),
            ("cycleAnchorDate", s.cycle_anchor_date.is_some()),
            ("cycleDaysOn", s.cycle_days_on.is_some()),
            ("cycleDaysOff", s.cycle_days_off.is_some()),
            ("intervalUnit", s.interval_unit.is_some()),
            ("intervalCount", s.interval_count.is_some()),
            ("monthKind", s.month_kind.is_some()),
            ("monthDay", s.month_day.is_some()),
            ("monthDayIsLast", s.month_day_is_last),
            ("monthWeekdayPosition", s.month_weekday_position.is_some()),
            ("monthWeekday", s.month_weekday.is_some()),
        ];
        if let Some((field, _)) = named.iter().find(|(_, present)| *present) {
            return Err(format!("{field} is not allowed for as_needed"));
        }
    }
    if let Some(times) = &s.schedule_times {
        if times.iter().any(|t| !clock_ok(t)) {
            return Err("scheduleTimes must be clock times such as 08:00".into());
        }
    }
    Ok(())
}

/// A reminder switch. An as-needed medication has no time for a reminder to fire on.
fn reminders(map: &Fields, frequency: Option<&str>) -> Result<Option<bool>, String> {
    let Some(on) = boolean_or_null(map, "remindersEnabled")? else { return Ok(None) };
    if on && frequency == Some("as_needed") {
        return Err("remindersEnabled is not allowed for as_needed".into());
    }
    Ok(Some(on))
}

fn name_of(value: &Option<String>) -> Result<String, String> {
    match value.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => Ok(t.to_owned()),
        _ => Err("name is required".into()),
    }
}

fn optional(map: &Fields, name: &str) -> Result<Option<Option<String>>, String> {
    Ok(trimmed(nullable_text(map, name)?))
}

fn plain_text(map: &Fields, name: &str) -> Result<Option<String>, String> {
    match map.get(name) {
        None => Ok(None),
        Some(v) => coerce_text(v).map(Some).ok_or_else(|| format!("body/{name} must be string")),
    }
}

pub fn create(body: &Value) -> Result<NewMedication, String> {
    let map = object(body)?;
    required(map, "name")?;
    required(map, "frequencyType")?;
    let name = plain_text(map, "name")?;
    let dosage = optional(map, "dosage")?;
    let form = optional(map, "form")?;
    let notes = optional(map, "notes")?;
    let schedule = schedule_fields(map)?;
    let reminders_value = boolean_or_null(map, "remindersEnabled")?;
    let name = name_of(&name)?;
    check_schedule(&schedule)?;
    let reminders_enabled = match reminders_value {
        Some(true) if schedule.frequency_type == "as_needed" => {
            return Err("remindersEnabled is not allowed for as_needed".into())
        }
        other => other,
    };
    Ok(NewMedication {
        name,
        dosage: dosage.flatten(),
        form: form.flatten(),
        notes: notes.flatten(),
        reminders_enabled,
        schedule,
    })
}

const SCHEDULE_NAMES: [&str; 16] = [
    "timesPerDay",
    "intervalHours",
    "weekdays",
    "scheduleTimes",
    "cycleDaysOn",
    "cycleDaysOff",
    "cycleAnchorDate",
    "intervalUnit",
    "intervalCount",
    "startDate",
    "endDate",
    "monthKind",
    "monthDay",
    "monthDayIsLast",
    "monthWeekdayPosition",
    "monthWeekday",
];

pub fn change(body: &Value) -> Result<MedicationChange, String> {
    let map = object(body)?;
    let name = plain_text(map, "name")?;
    let dosage = optional(map, "dosage")?;
    let form = optional(map, "form")?;
    let active = plain_boolean(map, "active")?;
    let notes = optional(map, "notes")?;
    let schedule = schedule_fields(map)?;
    let changes_schedule = map.contains_key("frequencyType");
    if !changes_schedule {
        if let Some(stray) = SCHEDULE_NAMES.iter().find(|n| map.contains_key(**n)) {
            return Err(format!("frequencyType is required when changing {stray}"));
        }
    }
    let schedule = if changes_schedule {
        check_schedule(&schedule)?;
        Some(schedule)
    } else {
        None
    };
    let reminders_enabled = reminders(map, schedule.as_ref().map(|s| s.frequency_type.as_str()))?;
    Ok(MedicationChange {
        name: name.as_ref().map(|_| name_of(&name)).transpose()?,
        dosage,
        form,
        notes,
        active,
        reminders_enabled,
        schedule,
    })
}

pub fn dose(body: &Value) -> Result<NewDose, String> {
    let map = object(body)?;
    required(map, "status")?;
    let status = crate::input::choice(map, "status", &["taken", "skipped", "prn"])?.unwrap_or_default();
    let dose = optional(map, "dose")?;
    let prn_reason = optional(map, "prnReason")?;
    let scheduled = nullable_text(map, "scheduledFor")?;
    // A prn log may not name a slot. The route schema asks for null here, and empty text reads as null.
    if status == "prn" && scheduled.as_deref().is_some_and(|t| !t.is_empty()) {
        return Err("body/scheduledFor must be null, body must match \"then\" schema".into());
    }
    let scheduled = trimmed(scheduled).flatten();
    if status != "prn" && scheduled.is_none() {
        return Err("scheduledFor is required for taken/skipped doses".into());
    }
    Ok(NewDose { status, dose: dose.flatten(), prn_reason: prn_reason.flatten(), scheduled_for: scheduled })
}
