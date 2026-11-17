//! Reads what the Outlook web calendar shows. Only English labels and the Gregorian calendar are
//! understood. Anything else fails closed with a bare code, never a label, address or event id.
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

/// Why a scan stopped. The code is one of `source-changed`, `partial`, `sign-in-needed` or
/// `settings-not-found`. No page text ever goes in here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceError {
    pub code: &'static str,
    pub stage: Option<&'static str>,
}

impl SourceError {
    pub const fn new(code: &'static str) -> Self {
        Self { code, stage: None }
    }
    pub const fn at(code: &'static str, stage: &'static str) -> Self {
        Self { code, stage: Some(stage) }
    }
}

pub type Result<T> = std::result::Result<T, SourceError>;

const PARTIAL: SourceError = SourceError::new("partial");
const CHANGED: SourceError = SourceError::new("source-changed");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub occurrence_key: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub all_day: bool,
    pub time_zone: String,
}

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];
const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

pub fn zone(name: &str) -> Option<Tz> {
    name.parse::<Tz>().ok()
}

/// JavaScript string length, so size limits match the old reader.
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn digits(text: &str, min: usize, max: usize) -> Option<(&str, &str)> {
    let n = text.bytes().take(max).take_while(u8::is_ascii_digit).count();
    (n >= min).then(|| text.split_at(n))
}

fn word<'a>(text: &'a str, names: &[&str]) -> Option<(usize, &'a str)> {
    names.iter().position(|name| text.starts_with(name)).map(|i| (i, &text[names[i].len()..]))
}

fn strip<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.strip_prefix(prefix)
}

/// `Wednesday, October 21, 2026` as (weekday, month, day, year, rest).
fn date_at(text: &str) -> Option<(usize, usize, &str, &str, &str)> {
    let (weekday, text) = word(text, &DAYS)?;
    let (month, text) = word(strip(text, ", ")?, &MONTHS)?;
    let (day, text) = digits(strip(text, " ")?, 1, 2)?;
    let (year, text) = digits(strip(text, ", ")?, 4, 4)?;
    Some((weekday, month, day, year, text))
}

fn at_boundary(rest: &str) -> bool {
    rest.is_empty() || rest.starts_with(',')
}

fn clock_at(text: &str) -> Option<(&str, &str)> {
    let (_, mut rest) = digits(text, 1, 2)?;
    if let Some(after) = strip(rest, ":") {
        if let Some((_, after)) = digits(after, 2, 2) {
            rest = after;
        }
    }
    let rest = strip(rest, " ")?;
    let rest = rest.strip_prefix('A').or_else(|| rest.strip_prefix('P'))?;
    let rest = strip(rest, "M")?;
    let used = text.len() - rest.len();
    Some((&text[..used], rest))
}

type Day<'a> = (usize, usize, &'a str, &'a str);

enum Hit<'a> {
    Timed(&'a str, &'a str, Day<'a>),
    AllDay(Day<'a>, Option<Day<'a>>),
}

/// The label text of one match, plus what it holds. `from` starts at a ", ".
fn hit_at(from: &str) -> Option<(usize, Hit<'_>)> {
    let body = strip(from, ", ")?;
    if let Some(rest) = strip(body, "all day event, ") {
        let (w, m, d, y, rest) = date_at(rest)?;
        if let Some((w2, m2, d2, y2, after)) = strip(rest, " to ").and_then(date_at) {
            if at_boundary(after) {
                return Some((from.len() - after.len(), Hit::AllDay((w, m, d, y), Some((w2, m2, d2, y2)))));
            }
        }
        return at_boundary(rest).then(|| (from.len() - rest.len(), Hit::AllDay((w, m, d, y), None)));
    }
    let (first, rest) = clock_at(body)?;
    let (second, rest) = clock_at(strip(rest, " to ")?)?;
    let (w, m, d, y, rest) = date_at(strip(rest, ", ")?)?;
    at_boundary(rest).then(|| (from.len() - rest.len(), Hit::Timed(first, second, (w, m, d, y))))
}

fn day_key(month: usize, day: &str, year: &str) -> Result<NaiveDate> {
    let (y, m, d) = (year.parse::<i32>().map_err(|_| PARTIAL)?, month as u32 + 1, day.parse::<u32>().map_err(|_| PARTIAL)?);
    NaiveDate::from_ymd_opt(y, m, d).ok_or(PARTIAL)
}

fn check_weekday(day: &Day<'_>) -> Result<NaiveDate> {
    let date = day_key(day.1, day.2, day.3)?;
    if date.weekday().num_days_from_sunday() as usize != day.0 {
        return Err(PARTIAL);
    }
    Ok(date)
}

fn clock(value: &str) -> Result<NaiveTime> {
    let (time, half) = value.split_at(value.len() - 2);
    let time = time.trim_end();
    let (hour, minute) = match time.split_once(':') {
        Some((h, m)) => (h.parse::<u32>(), m.parse::<u32>()),
        None => (time.parse::<u32>(), Ok(0)),
    };
    let (hour, minute) = (hour.map_err(|_| PARTIAL)?, minute.map_err(|_| PARTIAL)?);
    if !(1..=12).contains(&hour) || minute > 59 {
        return Err(PARTIAL);
    }
    NaiveTime::from_hms_opt(hour % 12 + if half == "PM" { 12 } else { 0 }, minute, 0).ok_or(PARTIAL)
}

fn instant(date: NaiveDate, time: NaiveTime, zone: Tz) -> Result<DateTime<Utc>> {
    match zone.from_local_datetime(&date.and_time(time)) {
        LocalResult::Single(at) => Ok(at.with_timezone(&Utc)),
        // A skipped or repeated wall-clock time has no single answer.
        _ => Err(PARTIAL),
    }
}

fn iso(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Drops the `Name icon, ` prefix Outlook may put before a title.
fn without_charm(text: &str) -> &str {
    let Some(comma) = text.find(',') else { return text };
    let name = &text[..comma];
    let Some(name) = name.strip_suffix(" icon") else { return text };
    let long = name.chars().count();
    if (1..=40).contains(&long) && text[comma..].starts_with(", ") {
        &text[comma + 2..]
    } else {
        text
    }
}

pub fn normalize_label(occurrence_key: &str, label: &str, time_zone: &str) -> Result<Observation> {
    let Some(tz) = zone(time_zone) else { return Err(PARTIAL) };
    if occurrence_key.is_empty() || units(occurrence_key) > 512 || units(label) > 4000 {
        return Err(PARTIAL);
    }
    let mut hits = vec![];
    let mut at = 0;
    while let Some(found) = label[at..].find(", ") {
        let start = at + found;
        match hit_at(&label[start..]) {
            Some((len, hit)) => {
                hits.push((start, hit));
                at = start + len;
            }
            None => at = start + 1,
        }
    }
    let [(index, hit)] = hits.as_slice() else { return Err(PARTIAL) };
    let title = without_charm(&label[..*index]).trim();
    if title.is_empty() || units(title) > 1000 {
        return Err(PARTIAL);
    }
    let base = |starts: DateTime<Utc>, ends: DateTime<Utc>, all_day: bool| Observation {
        occurrence_key: occurrence_key.into(),
        title: title.into(),
        starts_at: iso(starts),
        ends_at: iso(ends),
        all_day,
        time_zone: time_zone.into(),
    };
    let midnight = |date: NaiveDate| date.and_time(NaiveTime::MIN).and_utc();
    match hit {
        Hit::AllDay(first, last) => {
            let start = check_weekday(first)?;
            let last = match last {
                Some(day) => check_weekday(day)?,
                None => start,
            };
            // Outlook shows the last included date. Moss stores an exclusive end date.
            if last < start {
                return Err(PARTIAL);
            }
            Ok(base(midnight(start), midnight(last + Duration::days(1)), true))
        }
        Hit::Timed(from, to, day) => {
            let date = check_weekday(day)?;
            let (start, end) = (instant(date, clock(from)?, tz)?, instant(date, clock(to)?, tz)?);
            if end <= start {
                return Err(PARTIAL);
            }
            Ok(base(start, end, false))
        }
    }
}

/// The calendar's zone setting is a Windows display name, not an IANA name.
pub fn display_time_zone(display: &str) -> Result<&'static str> {
    match display {
        "(UTC-08:00) Pacific Time (US & Canada)" => Ok("America/Los_Angeles"),
        "(UTC-07:00) Mountain Time (US & Canada)" => Ok("America/Denver"),
        "(UTC-06:00) Central Time (US & Canada)" => Ok("America/Chicago"),
        "(UTC-05:00) Eastern Time (US & Canada)" => Ok("America/New_York"),
        "(UTC) Coordinated Universal Time" => Ok("UTC"),
        _ => Err(CHANGED),
    }
}

pub fn add_days(day: &str, days: i64) -> Result<String> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| PARTIAL)?;
    Ok((date + Duration::days(days)).format("%Y-%m-%d").to_string())
}

fn dash(text: &str) -> Option<&str> {
    text.strip_prefix('\u{2013}').or_else(|| text.strip_prefix('-'))
}

/// `October 18-24, 2026, Jump to a specific date or date range.` as (first day, day after the last).
pub fn parse_week_header(label: &str) -> Result<(String, String)> {
    let head = label.strip_suffix(", Jump to a specific date or date range.").ok_or(CHANGED)?;
    let (m1, rest) = word(head, &MONTHS).ok_or(CHANGED)?;
    let (d1, rest) = digits(strip(rest, " ").ok_or(CHANGED)?, 1, 2).ok_or(CHANGED)?;
    let (start, last) = if let Some(rest) = dash(rest) {
        let (d2, rest) = digits(rest, 1, 2).ok_or(CHANGED)?;
        let (year, rest) = digits(strip(rest, ", ").ok_or(CHANGED)?, 4, 4).ok_or(CHANGED)?;
        if !rest.is_empty() {
            return Err(CHANGED);
        }
        (day_key(m1, d1, year)?, day_key(m1, d2, year)?)
    } else {
        let (first_year, rest) = match strip(rest, ", ").and_then(|r| digits(r, 4, 4)) {
            Some((year, rest)) => (Some(year), rest),
            None => (None, rest),
        };
        let rest = strip(rest, " ").and_then(dash).and_then(|r| strip(r, " ")).ok_or(CHANGED)?;
        let (m2, rest) = word(rest, &MONTHS).ok_or(CHANGED)?;
        let (d2, rest) = digits(strip(rest, " ").ok_or(CHANGED)?, 1, 2).ok_or(CHANGED)?;
        let (year, rest) = digits(strip(rest, ", ").ok_or(CHANGED)?, 4, 4).ok_or(CHANGED)?;
        if !rest.is_empty() {
            return Err(CHANGED);
        }
        (day_key(m1, d1, first_year.unwrap_or(year))?, day_key(m2, d2, year)?)
    };
    let end = last + Duration::days(1);
    if start + Duration::days(7) != end {
        return Err(CHANGED);
    }
    Ok((start.to_string(), end.to_string()))
}

/// The instant a local day begins, for window checks. A day with no midnight starts at its first
/// valid instant.
pub fn day_start(day: &str, time_zone: &str) -> Option<DateTime<Utc>> {
    let tz = zone(time_zone)?;
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    (0..24).find_map(|hour| {
        match tz.from_local_datetime(&date.and_hms_opt(hour, 0, 0)?) {
            LocalResult::Single(at) => Some(at.with_timezone(&Utc)),
            LocalResult::Ambiguous(first, _) => Some(first.with_timezone(&Utc)),
            LocalResult::None => None,
        }
    })
}

pub fn day_key_of(at: DateTime<Utc>, time_zone: &str) -> Option<String> {
    Some(at.with_timezone(&zone(time_zone)?).format("%Y-%m-%d").to_string())
}
