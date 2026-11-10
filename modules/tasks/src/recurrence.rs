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
        let interval = if self.interval.fract() == 0.0
            && (0.0..=9_007_199_254_740_991.0).contains(&self.interval)
        {
            json!(self.interval as u64)
        } else {
            json!(self.interval)
        };
        json!({"freq":self.freq,"interval":interval,"occurrence_date":self.occurrence_date})
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
        let today_date = date(today)?;
        // Daily and weekly steps are fixed day counts, so jump straight to the first
        // occurrence on or after today. Anything unusual (fractions, very long gaps)
        // takes the stepwise path below, which also owns the failure cases.
        if let (Some(start), true) = (date(&self.occurrence_date), self.interval.fract() == 0.0) {
            let step = match self.freq.as_str() {
                "daily" => Some(self.interval),
                "weekly" => Some(self.interval * 7.0),
                _ => None,
            };
            if let Some(step) = step.filter(|s| (1.0..=100_000_000.0).contains(s)) {
                let step = step as i64;
                let gap = (today_date - start).num_days();
                if gap <= 0 {
                    return Some(self.occurrence_date.clone());
                }
                let steps = (gap + step - 1) / step;
                if steps <= 10_000 {
                    let found = start.checked_add_signed(Duration::days(steps * step))?;
                    if !(0..=9999).contains(&found.year()) {
                        return None;
                    }
                    return Some(found.format("%Y-%m-%d").to_string());
                }
            }
        }
        self.at_or_after_stepwise(today)
    }
    /// Reference walk, one occurrence at a time, capped at 10,000 steps.
    fn at_or_after_stepwise(&self, today: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_matches_the_stepwise_walk() {
        let starts = ["2020-01-01", "2024-02-29", "2026-11-10", "2026-12-31", "0001-01-01"];
        let todays = ["2019-05-05", "2020-01-01", "2020-01-02", "2026-11-10", "2027-03-01", "9999-12-31"];
        for freq in ["daily", "weekly", "monthly"] {
            for interval in [1.0, 2.0, 3.0, 7.0, 30.0, 400.0, 0.0, 1.5] {
                for start in starts {
                    for today in todays {
                        let spec = Recurrence {
                            freq: freq.into(),
                            interval,
                            occurrence_date: start.into(),
                        };
                        assert_eq!(
                            spec.at_or_after(today),
                            spec.at_or_after_stepwise(today),
                            "{freq} {interval} {start} {today}"
                        );
                    }
                }
            }
        }
    }
}
