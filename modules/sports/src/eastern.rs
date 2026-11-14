//! The US Eastern calendar day. ESPN reads scoreboard dates in Eastern time, so the day sent to it
//! (and cached under) must use that boundary. The package has no time zone database, so the
//! daylight saving rule is written out: it starts the second Sunday of March at 02:00 local and
//! ends the first Sunday of November at 02:00 local.
use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};

const HOUR_MS: i64 = 3_600_000;

fn nth_sunday(year: i32, month: u32, nth: u32) -> NaiveDate {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    let to_sunday = (7 + Weekday::Sun.num_days_from_monday() as i64 - first.weekday().num_days_from_monday() as i64) % 7;
    first + Duration::days(to_sunday + 7 * (nth as i64 - 1))
}

fn utc_ms(day: NaiveDate, hour: i64) -> i64 {
    Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).expect("midnight")).timestamp_millis() + hour * HOUR_MS
}

/// Hours Eastern is behind UTC at this instant, 4 in daylight time and 5 otherwise.
pub fn offset_hours(now_ms: i64) -> i64 {
    let year = Utc.timestamp_millis_opt(now_ms).single().map(|t| t.year()).unwrap_or(1970);
    // 02:00 EST is 07:00 UTC. 02:00 EDT is 06:00 UTC.
    let starts = utc_ms(nth_sunday(year, 3, 2), 7);
    let ends = utc_ms(nth_sunday(year, 11, 1), 6);
    if now_ms >= starts && now_ms < ends { 4 } else { 5 }
}

/// The Eastern calendar day of an instant, as YYYY-MM-DD.
pub fn day_of(now_ms: i64) -> String {
    let local = now_ms - offset_hours(now_ms) * HOUR_MS;
    let at = Utc.timestamp_millis_opt(local).single().unwrap_or_default();
    at.format("%Y-%m-%d").to_string()
}

/// `day` shifted by `n` calendar days. Pure date arithmetic, so daylight changes never matter.
pub fn add_days(day: &str, n: i64) -> String {
    match NaiveDate::parse_from_str(day, "%Y-%m-%d") {
        Ok(d) => (d + Duration::days(n)).format("%Y-%m-%d").to_string(),
        Err(_) => day.to_owned(),
    }
}

/// Every calendar day from `from` to `to`, inclusive.
pub fn days_inclusive(from: &str, to: &str) -> Vec<String> {
    let mut days = vec![];
    let mut day = from.to_owned();
    while day.as_str() <= to && days.len() < 400 {
        days.push(day.clone());
        day = add_days(&day, 1);
    }
    days
}
