//! Calendar calculations from Tasks' public recurrence contract. No wall clock access.
use chrono::{Datelike, Duration, Months, NaiveDate};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct Recurrence {
    pub freq: String,
    // Keep the JavaScript numeric domain when parsing stored JSON. Arithmetic is checked.
    pub interval: f64,
    pub occurrence_date: String,
}
impl Recurrence {
    pub fn dto(&self) -> Value {
        json!({"freq":self.freq,"interval":self.interval,"occurrence_date":self.occurrence_date})
    }
    pub fn next(&self) -> Option<String> {
        let day = date(&self.occurrence_date)?;
        let next = match self.freq.as_str() {
            "daily" | "weekly" => {
                let days = self.interval * if self.freq == "weekly" { 7.0 } else { 1.0 };
                // JS Date's TimeClip is bounded to 100 million days.
                if days > 100_000_000.0 {
                    return None;
                }
                day.checked_add_signed(Duration::days(days as i64))?
            }
            "monthly" => {
                if self.interval > u32::MAX as f64 {
                    return None;
                }
                day.checked_add_months(Months::new(self.interval as u32))?
            }
            _ => return None,
        };
        // The stored contract is a four-digit calendar date.
        if !(0..=9999).contains(&next.year()) {
            return None;
        }
        Some(next.format("%Y-%m-%d").to_string())
    }
    pub fn at_or_after(&self, today: &str) -> Option<String> {
        date(today)?;
        let mut spec = self.clone();
        for _ in 0..10_000 {
            if spec.occurrence_date.as_str() >= today {
                break;
            }
            spec.occurrence_date = spec.next()?;
        }
        Some(spec.occurrence_date)
    }
}
fn date(text: &str) -> Option<NaiveDate> {
    let b = text.as_bytes();
    if b.len() != 10
        || b[4] != b'-'
        || b[7] != b'-'
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return None;
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}
pub fn parse(value: &Value) -> Option<Recurrence> {
    let value = value.as_object()?;
    let freq = value.get("freq")?.as_str()?;
    if !["daily", "weekly", "monthly"].contains(&freq) {
        return None;
    }
    let interval = value.get("interval")?.as_f64()?;
    if !interval.is_finite() || interval < 1.0 || interval.fract() != 0.0 {
        return None;
    }
    let occurrence_date = value.get("occurrence_date")?.as_str()?;
    date(occurrence_date)?;
    Some(Recurrence {
        freq: freq.into(),
        interval,
        occurrence_date: occurrence_date.into(),
    })
}
