//! Times for the meal log. The person's own time zone comes from the host, which is the only
//! source of zone rules a guest has. An entry stores its calendar day and zone offset when it is
//! made, so a later change of zone never moves a past entry to another day.
use crate::util::{days_from_civil, epoch_ms};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

/// The calendar day and zone offset in minutes that an instant falls on for the person.
pub struct Day {
    pub date: String,
    pub offset_minutes: i64,
}

/// "YYYY-MM-DDTHH:MM:SS.mmmZ" for a count of milliseconds since the epoch.
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// A stored timestamp in the one form the module shows, whatever form the host sent.
pub fn normalise(stamp: &str) -> String {
    epoch_ms(stamp).map_or_else(|| stamp.to_owned(), iso_from_ms)
}

/// The person's calendar day and offset at an instant.
pub fn day_at<H: Host + ?Sized>(host: &H, ms: i64) -> Result<Day> {
    let answer: Value = host.call(
        "context",
        "local-date",
        "account",
        json!({"instant": iso_from_ms(ms), "offsetDays": 0}),
    )?;
    match (answer["date"].as_str(), answer["offsetMinutes"].as_i64()) {
        (Some(date), Some(offset_minutes)) => Ok(Day {
            date: date.to_owned(),
            offset_minutes,
        }),
        _ => Err(moss_module_sdk::Error::new("Host day unavailable")),
    }
}

/// The calendar parts of "YYYY-MM-DDTHH:MM[:SS[.f]]" and the rest of the text, when it fits.
struct Wall {
    days: i64,
    ms_of_day: i64,
}

fn digits(text: &str, width: usize) -> Option<i64> {
    (text.len() == width && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// Splits a wall-clock stamp with no zone. The second and fraction are optional.
fn wall(text: &str) -> Option<Wall> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day) = (digits(d.next()?, 4)?, digits(d.next()?, 2)?, digits(d.next()?, 2)?);
    if d.next().is_some() {
        return None;
    }
    let mut t = time.split(':');
    let hour = digits(t.next()?, 2)?;
    let minute = digits(t.next()?, 2)?;
    let (second, millis) = match t.next() {
        None => (0, 0),
        Some(s) => match s.split_once('.') {
            None => (digits(s, 2)?, 0),
            Some((s, f)) => {
                let width = f.len();
                if !(1..=3).contains(&width) {
                    return None;
                }
                (digits(s, 2)?, digits(f, width)? * 10_i64.pow(3 - width as u32))
            }
        },
    };
    if t.next().is_some() || !(1..=12).contains(&m) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let longest = civil_days_in_month(y, m);
    if day < 1 || day > longest {
        return None;
    }
    Some(Wall {
        days: days_from_civil(y, m, day),
        ms_of_day: ((hour * 60 + minute) * 60 + second) * 1000 + millis,
    })
}

fn civil_days_in_month(y: i64, m: i64) -> i64 {
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    match m {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The zone ending of an instant stamp as minutes east of UTC, when it is one.
fn zone_ending(text: &str) -> Option<(&str, i64)> {
    if let Some(rest) = text.strip_suffix('Z') {
        return Some((rest, 0));
    }
    let cut = text.len().checked_sub(6)?;
    let (rest, zone) = (text.get(..cut)?, text.get(cut..)?);
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let (h, m) = (digits(zone.get(1..3)?, 2)?, digits(zone.get(4..6)?, 2)?);
    (zone.as_bytes()[3] == b':' && h <= 23 && m <= 59).then_some((rest, sign * (h * 60 + m)))
}

/// Why a consumed-at value was refused. The wording is the same for every cause, because the
/// person's fix is the same: give a plain instant or an explicit offset.
#[derive(Debug, PartialEq)]
pub struct Unreadable;

/// The instant a consumed-at text names. An instant with an offset is taken as written. A
/// local date-time is read in the person's zone, and is refused where that zone has no such
/// wall-clock time (a clock change skipped it) or two (a clock change repeated it).
pub fn parse_consumed_at<H: Host + ?Sized>(host: &H, raw: &str) -> Result<std::result::Result<i64, Unreadable>> {
    if let Some((rest, offset)) = zone_ending(raw) {
        return Ok(wall(rest)
            .map(|w| (w.days * 86_400_000 + w.ms_of_day) - offset * 60_000)
            .ok_or(Unreadable));
    }
    let Some(w) = wall(raw) else {
        return Ok(Err(Unreadable));
    };
    let as_utc = w.days * 86_400_000 + w.ms_of_day;
    let mut found: Vec<i64> = vec![];
    // The offset in force a day either side of the wall time covers one clock change.
    for probe in [-86_400_000, 86_400_000] {
        let offset = day_at(host, as_utc + probe)?.offset_minutes;
        let instant = as_utc - offset * 60_000;
        if day_at(host, instant)?.offset_minutes == offset && !found.contains(&instant) {
            found.push(instant);
        }
    }
    Ok(match found.as_slice() {
        [one] => Ok(*one),
        _ => Err(Unreadable),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants_round_trip_through_text() {
        let ms = epoch_ms("2026-11-11T10:00:00.250Z").unwrap();
        assert_eq!(iso_from_ms(ms), "2026-11-11T10:00:00.250Z");
        assert_eq!(normalise("2026-11-11T02:00:00.250-08:00"), "2026-11-11T10:00:00.250Z");
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn wall_clock_texts_are_checked_for_real_calendar_parts() {
        assert!(wall("2026-11-11T10:00").is_some());
        assert!(wall("2026-11-11T10:00:30.5").is_some());
        assert!(wall("2026-02-29T10:00").is_none());
        assert!(wall("2028-02-29T10:00").is_some());
        assert!(wall("2026-13-01T10:00").is_none());
        assert!(wall("2026-11-11T24:00").is_none());
        assert!(wall("2026-11-11T10:60").is_none());
        assert!(wall("2026-11-11T10:00:60").is_none());
        assert!(wall("2026-11-11T10:00:00.1234").is_none());
        assert!(wall("2026-11-11").is_none());
    }

    #[test]
    fn explicit_offsets_are_taken_as_written() {
        assert_eq!(zone_ending("2026-11-11T10:00Z"), Some(("2026-11-11T10:00", 0)));
        assert_eq!(zone_ending("2026-11-11T10:00-08:00"), Some(("2026-11-11T10:00", -480)));
        assert_eq!(zone_ending("2026-11-11T10:00+24:00"), None);
    }
}
