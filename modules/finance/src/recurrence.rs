//! Bill dates. Every date derives from the anchor, so a February clamp never moves March.
//! No clock and no host calls.
use crate::envelope::day_number;
use crate::input::is_calendar_date;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cadence {
    Once,
    Weekly,
    Fortnightly,
    Monthly,
    Yearly,
}

impl Cadence {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "once" => Self::Once,
            "weekly" => Self::Weekly,
            "fortnightly" => Self::Fortnightly,
            "monthly" => Self::Monthly,
            "yearly" => Self::Yearly,
            _ => return None,
        })
    }
}

pub struct Schedule<'a> {
    pub anchor: &'a str,
    pub cadence: Cadence,
    pub end: Option<&'a str>,
}

fn parts(day: &str) -> (i64, i64, i64) {
    let n = |r: std::ops::Range<usize>| day[r].parse::<i64>().unwrap_or(0);
    (n(0..4), n(5..7), n(8..10))
}

/// The date for a day number (days since 1970-01-01), or None outside years 1 to 9999.
pub fn from_day_number(days: i64) -> Option<String> {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (1..=9999).contains(&y).then(|| format!("{y:04}-{m:02}-{d:02}"))
}

/// Day `day` of the month, clamped down to the month's last valid day (not below 28).
fn day_string(year: i64, month: i64, day: i64) -> Option<String> {
    if !(1..=9999).contains(&year) {
        return None;
    }
    let prefix = format!("{year:04}-{month:02}");
    for candidate in (28..=day).rev() {
        let value = format!("{prefix}-{candidate:02}");
        if is_calendar_date(&value) {
            return Some(value);
        }
    }
    Some(format!("{prefix}-{day:02}"))
}

/// The `index`th planned date, or None past the end date or the supported calendar.
pub fn occurrence(schedule: &Schedule, index: i64) -> Option<String> {
    if !is_calendar_date(schedule.anchor) || !(0..=3_652_058).contains(&index) {
        return None;
    }
    let (year, month, day) = parts(schedule.anchor);
    let result = match schedule.cadence {
        Cadence::Once => (index == 0).then(|| schedule.anchor.to_owned()),
        Cadence::Weekly => from_day_number(day_number(schedule.anchor) + index * 7),
        Cadence::Fortnightly => from_day_number(day_number(schedule.anchor) + index * 14),
        Cadence::Monthly => {
            let absolute = year * 12 + month - 1 + index;
            day_string(absolute.div_euclid(12), absolute.rem_euclid(12) + 1, day)
        }
        Cadence::Yearly => day_string(year + index, month, day),
    };
    result.filter(|r| schedule.end.is_none_or(|e| r.as_str() <= e))
}

/// Planned dates inside `from..=to`, a window of at most 366 days and at most 55 steps.
pub fn occurrences(schedule: &Schedule, from: &str, to: &str) -> Option<Vec<String>> {
    if !is_calendar_date(from) || !is_calendar_date(to) || from > to || day_number(to) - day_number(from) > 366 {
        return None;
    }
    if !is_calendar_date(schedule.anchor) {
        return None;
    }
    let (year, month, _) = parts(schedule.anchor);
    let (from_year, from_month, _) = parts(from);
    let days = day_number(from) - day_number(schedule.anchor);
    let mut index = match schedule.cadence {
        Cadence::Monthly => (from_year - year) * 12 + from_month - month,
        Cadence::Yearly => from_year - year,
        Cadence::Once => 0,
        Cadence::Weekly => days.div_euclid(7),
        Cadence::Fortnightly => days.div_euclid(14),
    }
    .max(0);
    let mut out = Vec::new();
    for _ in 0..55 {
        let Some(date) = occurrence(schedule, index) else { break };
        if date.as_str() > to {
            break;
        }
        if date.as_str() >= from {
            out.push(date);
        }
        index += 1;
    }
    Some(out)
}

/// Where a bill's payment may land, a week either side of its month.
pub fn match_window(from: &str, to: &str) -> (String, String) {
    let shift = |day: &str, by: i64| from_day_number(day_number(day) + by);
    (
        shift(from, -7).unwrap_or_else(|| "0001-01-01".into()),
        shift(to, 7).unwrap_or_else(|| "9999-12-31".into()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s<'a>(anchor: &'a str, cadence: Cadence) -> Schedule<'a> {
        Schedule { anchor, cadence, end: None }
    }

    #[test]
    fn monthly_clamps_from_the_anchor_and_recovers() {
        let sch = s("2026-01-31", Cadence::Monthly);
        let got: Vec<_> = (0..4).map(|i| occurrence(&sch, i).unwrap()).collect();
        assert_eq!(got, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
        assert_eq!(occurrence(&s("2024-01-31", Cadence::Monthly), 1).unwrap(), "2024-02-29");
    }

    #[test]
    fn yearly_leap_day_clamps_then_returns() {
        let sch = s("2024-02-29", Cadence::Yearly);
        assert_eq!(occurrence(&sch, 1).unwrap(), "2025-02-28");
        assert_eq!(occurrence(&sch, 4).unwrap(), "2028-02-29");
    }

    #[test]
    fn weekly_and_fortnightly_step_by_days() {
        assert_eq!(occurrence(&s("2026-12-28", Cadence::Weekly), 1).unwrap(), "2027-01-04");
        assert_eq!(occurrence(&s("2026-12-28", Cadence::Fortnightly), 1).unwrap(), "2027-01-11");
    }

    #[test]
    fn once_stops_at_the_end_date_and_the_calendar_edge() {
        assert_eq!(occurrence(&s("2026-05-05", Cadence::Once), 1), None);
        let sch = Schedule { anchor: "2026-01-10", cadence: Cadence::Monthly, end: Some("2026-02-10") };
        assert_eq!(occurrence(&sch, 1).unwrap(), "2026-02-10");
        assert_eq!(occurrence(&sch, 2), None);
        assert_eq!(occurrence(&s("9999-12-25", Cadence::Weekly), 1), None);
    }

    #[test]
    fn a_window_lists_dates_and_refuses_over_a_year() {
        let sch = s("2026-01-31", Cadence::Monthly);
        assert_eq!(occurrences(&sch, "2026-02-01", "2026-04-30").unwrap(), ["2026-02-28", "2026-03-31", "2026-04-30"]);
        assert!(occurrences(&sch, "2026-01-01", "2027-01-03").is_none());
        assert!(occurrences(&sch, "2026-01-01", "2027-01-02").is_some());
        assert_eq!(occurrences(&s("2026-03-01", Cadence::Weekly), "2026-01-01", "2026-03-20").unwrap(), ["2026-03-01", "2026-03-08", "2026-03-15"]);
    }

    #[test]
    fn the_match_window_is_a_week_either_side() {
        assert_eq!(match_window("2026-03-01", "2026-03-31"), ("2026-02-22".into(), "2026-04-07".into()));
        assert_eq!(match_window("0001-01-03", "9999-12-28"), ("0001-01-01".into(), "9999-12-31".into()));
    }
}
