//! JavaScript `Date` behaviour the TypeScript server exposes.
//!
//! The TypeScript routes parse timestamps with `new Date(value)`, store them at millisecond
//! precision and answer with `toISOString()`. This module reproduces the ISO branch of V8's
//! parser. V8's legacy fallback (free text such as `Nov 7, 2026`, or ISO text padded with
//! spaces) is not reproduced and parses to `None` here.

use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone, Utc};

/// Formats like `Date.prototype.toISOString()`: UTC, three fraction digits, `Z`.
pub fn to_iso_string(value: DateTime<Utc>) -> String {
    truncate_ms(value).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Drops sub-millisecond digits, the precision of a JavaScript `Date`.
pub fn truncate_ms(value: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(value.timestamp_millis()).unwrap_or(value)
}

/// The current time at JavaScript precision.
pub fn js_now() -> DateTime<Utc> {
    truncate_ms(Utc::now())
}

/// `new Date(input)` in the process's local zone.
pub fn parse_js_date(input: &str) -> Option<DateTime<Utc>> {
    parse_js_date_in(input, &chrono::Local)
}

/// `new Date(input)` with an explicit zone for date-times that carry no offset.
pub fn parse_js_date_in<Tz: TimeZone>(input: &str, local: &Tz) -> Option<DateTime<Utc>> {
    let mut cursor = Cursor::new(input);
    let year = cursor.year()?;
    let (month, day) = if cursor.eat(b'-') {
        let month = cursor.digits(2)?;
        let day = if cursor.eat(b'-') { cursor.digits(2)? } else { 1 };
        (month, day)
    } else {
        (1, 1)
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // V8 rolls an overflowing day into the next month (2026-02-30 is 2 March).
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let date = first.checked_add_signed(Duration::days(i64::from(day) - 1))?;

    if cursor.done() {
        return Some(Utc.from_utc_datetime(&date.and_time(NaiveTime::MIN)));
    }
    if !(cursor.eat(b'T') || cursor.eat(b't') || cursor.eat(b' ')) {
        return None;
    }

    let hour = cursor.digits(2)?;
    if !cursor.eat(b':') {
        return None;
    }
    let minute = cursor.digits(2)?;
    let mut second = 0;
    let mut millis = 0;
    if cursor.eat(b':') {
        second = cursor.digits(2)?;
        if cursor.eat(b'.') {
            millis = cursor.fraction_millis()?;
        }
    }
    if minute > 59 || second > 59 || hour > 24 || (hour == 24 && (minute, second, millis) != (0, 0, 0)) {
        return None;
    }

    let naive = NaiveDateTime::new(date, NaiveTime::MIN)
        + Duration::hours(i64::from(hour))
        + Duration::minutes(i64::from(minute))
        + Duration::seconds(i64::from(second))
        + Duration::milliseconds(i64::from(millis));

    let offset_minutes = cursor.offset()?;
    if !cursor.done() {
        return None;
    }
    match offset_minutes {
        Some(minutes) => Some(Utc.from_utc_datetime(&(naive - Duration::minutes(minutes)))),
        None => local_to_utc(naive, local),
    }
}

/// Resolves a wall-clock time the way V8 does: the earlier instant when the clock repeats,
/// and the pre-transition offset when the time falls in a spring-forward gap.
fn local_to_utc<Tz: TimeZone>(naive: NaiveDateTime, local: &Tz) -> Option<DateTime<Utc>> {
    match local.from_local_datetime(&naive) {
        LocalResult::Single(value) => Some(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(earliest, _) => Some(earliest.with_timezone(&Utc)),
        LocalResult::None => {
            let before = naive - Duration::hours(3);
            let offset = match local.from_local_datetime(&before) {
                LocalResult::Single(value) | LocalResult::Ambiguous(value, _) => {
                    value.offset().fix().local_minus_utc()
                }
                LocalResult::None => return None,
            };
            Some(Utc.from_utc_datetime(&(naive - Duration::seconds(i64::from(offset)))))
        }
    }
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(input: &'a str) -> Self {
        Self { bytes: input.as_bytes(), at: 0 }
    }

    fn done(&self) -> bool {
        self.at == self.bytes.len()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.bytes.get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self, count: usize) -> Option<u32> {
        let slice = self.bytes.get(self.at..self.at + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += count;
        Some(slice.iter().fold(0, |acc, b| acc * 10 + u32::from(b - b'0')))
    }

    fn year(&mut self) -> Option<i32> {
        let sign = if self.eat(b'+') {
            Some(1)
        } else if self.eat(b'-') {
            Some(-1)
        } else {
            None
        };
        match sign {
            Some(sign) => Some(sign * i32::try_from(self.digits(6)?).ok()?),
            None => i32::try_from(self.digits(4)?).ok(),
        }
    }

    /// Reads one or more fraction digits; digits past the third are dropped, as V8 does.
    fn fraction_millis(&mut self) -> Option<u32> {
        let start = self.at;
        while self.bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
            self.at += 1;
        }
        let digits = &self.bytes[start..self.at];
        if digits.is_empty() {
            return None;
        }
        let mut millis = 0;
        for index in 0..3 {
            millis = millis * 10 + digits.get(index).map_or(0, |b| u32::from(b - b'0'));
        }
        Some(millis)
    }

    /// `Ok(None)` style: outer `None` is a syntax error, inner `None` means no offset given.
    fn offset(&mut self) -> Option<Option<i64>> {
        if self.eat(b'Z') || self.eat(b'z') {
            return Some(Some(0));
        }
        let sign = if self.eat(b'+') {
            1
        } else if self.eat(b'-') {
            -1
        } else {
            return Some(None);
        };
        let hours = self.digits(2)?;
        self.eat(b':');
        let minutes = self.digits(2)?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        Some(Some(sign * i64::from(hours * 60 + minutes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inputs V8 sends through its legacy free-text parser; the spike does not port it.
    const LEGACY_PARSER_INPUTS: [&str; 2] = ["Nov 7, 2026", "  2026-11-07  "];

    #[test]
    fn matches_v8_on_recorded_vectors() {
        let vectors: Vec<(String, Option<String>)> =
            serde_json::from_str(include_str!("../tests/fixtures/js-date-vectors.json")).unwrap();
        let zone = chrono_tz::America::Los_Angeles;
        let mut checked = 0;
        for (input, expected) in &vectors {
            if LEGACY_PARSER_INPUTS.contains(&input.as_str()) {
                continue;
            }
            let actual = parse_js_date_in(input, &zone).map(to_iso_string);
            assert_eq!(&actual, expected, "input {input:?}");
            checked += 1;
        }
        assert_eq!(checked, vectors.len() - LEGACY_PARSER_INPUTS.len());
    }

    #[test]
    fn iso_string_truncates_to_milliseconds() {
        let value = Utc.timestamp_opt(1_762_500_000, 123_987_000).unwrap();
        assert_eq!(to_iso_string(value), "2025-11-07T07:20:00.123Z");
    }
}
