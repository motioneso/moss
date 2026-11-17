//! Small helpers shared by the Meals routes and tools.
use moss_module_sdk::{Response, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn bad_request(message: impl Into<String>) -> Response {
    error(400, message)
}

pub fn error(status: u16, message: impl Into<String>) -> Response {
    Response::new(status, json!({"error":message.into()}))
}

pub fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// The host clock and the signed-in person's id, in one call.
pub fn context<H: moss_module_sdk::Host + ?Sized>(host: &H) -> Result<(String, String)> {
    let context = host.call("context", "read", "call", json!({}))?;
    let field = |key: &str| {
        context[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| moss_module_sdk::Error::new("Host context unavailable"))
    };
    Ok((field("actorUserId")?, field("now")?))
}

/// A fresh id from the host.
pub fn new_id<H: moss_module_sdk::Host + ?Sized>(host: &H) -> Result<String> {
    host.call("context", "uuid", "new", json!({}))?["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| moss_module_sdk::Error::new("Host id unavailable"))
}

/// A number as a person writes it: no trailing ".0".
pub fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// A number in a reply the way JSON.stringify writes it: whole values carry no ".0".
pub fn jnum(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

pub fn jopt(value: Option<f64>) -> Value {
    value.map_or(Value::Null, jnum)
}

/// Days since 1970-01-01 for a civil date.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// The weekday of a "YYYY-MM-DD" date, 0 for Sunday.
pub fn weekday(date: &str) -> Option<usize> {
    let mut parts = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    Some((days_from_civil(y, m, d) + 4).rem_euclid(7) as usize)
}

/// Milliseconds since the epoch for an ISO timestamp such as 2026-11-11T10:00:00.250+00:00.
pub fn epoch_ms(stamp: &str) -> Option<i64> {
    let (date, time) = stamp.split_once(['T', ' '])?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let days = days_from_civil(d.next()??, d.next()??, d.next()??);
    let split = time.find(['Z', '+', '-']).unwrap_or(time.len());
    let (clock, zone) = time.split_at(split);
    let mut c = clock.split(':');
    let hours: i64 = c.next()?.parse().ok()?;
    let minutes: i64 = c.next()?.parse().ok()?;
    let seconds: f64 = c.next().unwrap_or("0").parse().ok()?;
    let offset = match zone.as_bytes().first() {
        Some(b'+' | b'-') => {
            let (h, m) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
            let minutes = h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?;
            if zone.starts_with('-') { -minutes } else { minutes }
        }
        _ => 0,
    };
    Some(((days * 24 + hours) * 60 + minutes - offset) * 60_000 + (seconds * 1000.0).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weekdays_and_timestamps() {
        assert_eq!(weekday("2026-11-16"), Some(1));
        assert_eq!(weekday("2026-11-15"), Some(0));
        let a = epoch_ms("2026-11-11T10:00:00.250+00:00").unwrap();
        assert_eq!(epoch_ms("2026-11-11T10:00:00.250Z"), Some(a));
        assert_eq!(epoch_ms("2026-11-11T02:00:00.250-08:00"), Some(a));
        assert_eq!(epoch_ms("2026-11-12T10:00:00.250Z"), Some(a + 86_400_000));
        assert_eq!(jnum(250.0), json!(250));
        assert_eq!(jnum(0.5), json!(0.5));
    }
}
