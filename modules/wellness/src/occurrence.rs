//! When the doses of one schedule fall. Pure, with no storage and no host calls. It follows the
//! old occurrence engine: eligible days are counted on the calendar, and each dose time is then
//! placed in the schedule's time zone, with the daylight-saving gap and fold rules the old engine
//! used (a skipped time moves to the moment clocks change, a repeated time uses the earlier one).
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Offset, TimeZone, Weekday as ChronoWeekday};
use chrono_tz::Tz;

pub const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Debug)]
pub enum Family {
    Daily,
    SelectedDays { weekdays: Vec<u32> },
    EveryDays { interval: i64 },
    EveryWeeks { interval: i64, weekdays: Vec<u32> },
    EveryMonths { interval: i64 },
    MonthlyDate { last: bool, day: u32 },
    MonthlyWeekday { position: String, weekday: u32 },
    Cycle { days_on: i64, days_off: i64 },
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub family: Family,
    pub dose_times: Vec<String>,
    pub start: NaiveDate,
    pub end: Option<NaiveDate>,
    pub zone: String,
}

#[derive(Clone, Debug)]
pub struct Occurrence {
    pub date: NaiveDate,
    pub time: String,
    /// Milliseconds since the epoch.
    pub at: i64,
}

fn iso_weekday(date: NaiveDate) -> u32 {
    match date.weekday() {
        ChronoWeekday::Mon => 1,
        ChronoWeekday::Tue => 2,
        ChronoWeekday::Wed => 3,
        ChronoWeekday::Thu => 4,
        ChronoWeekday::Fri => 5,
        ChronoWeekday::Sat => 6,
        ChronoWeekday::Sun => 7,
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next = if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1) } else { NaiveDate::from_ymd_opt(year, month + 1, 1) };
    next.and_then(|n| n.pred_opt()).map_or(31, |d| d.day())
}

fn diff_days(from: NaiveDate, to: NaiveDate) -> i64 {
    (to - from).num_days()
}

fn eligible(plan: &Plan, date: NaiveDate) -> bool {
    if date < plan.start {
        return false;
    }
    match &plan.family {
        Family::Daily => true,
        Family::SelectedDays { weekdays } => weekdays.contains(&iso_weekday(date)),
        Family::EveryDays { interval } => *interval >= 1 && diff_days(plan.start, date) % interval == 0,
        Family::EveryWeeks { interval, weekdays } => {
            if *interval < 1 || !weekdays.contains(&iso_weekday(date)) {
                return false;
            }
            let week_start = |d: NaiveDate| d - Duration::days(i64::from(iso_weekday(d)) - 1);
            let weeks = diff_days(week_start(plan.start), week_start(date)) / 7;
            weeks % interval == 0
        }
        Family::EveryMonths { interval } => {
            if *interval < 1 || date.day() != plan.start.day() {
                return false;
            }
            let months = i64::from(date.year() - plan.start.year()) * 12 + i64::from(date.month()) - i64::from(plan.start.month());
            months >= 0 && months % interval == 0
        }
        Family::MonthlyDate { last, day } => {
            if *last {
                date.day() == days_in_month(date.year(), date.month())
            } else {
                date.day() == *day
            }
        }
        Family::MonthlyWeekday { position, weekday } => {
            if iso_weekday(date) != *weekday {
                return false;
            }
            if position == "last" {
                return date.day() + 7 > days_in_month(date.year(), date.month());
            }
            let wanted = match position.as_str() {
                "first" => 1,
                "second" => 2,
                "third" => 3,
                _ => 4,
            };
            date.day().div_ceil(7) == wanted
        }
        Family::Cycle { days_on, days_off } => {
            let length = days_on + days_off;
            length > 0 && *days_on > 0 && diff_days(plan.start, date) % length < *days_on
        }
    }
}

/// The zone's offset from UTC at an instant, in whole seconds.
pub fn offset_seconds_at(zone: &Tz, instant_ms: i64) -> i64 {
    let naive = chrono::DateTime::from_timestamp_millis(instant_ms).map_or_else(NaiveDateTime::default, |t| t.naive_utc());
    i64::from(zone.offset_from_utc_datetime(&naive).fix().local_minus_utc())
}

fn offset_minutes_at(zone: &Tz, instant_ms: i64) -> i64 {
    (offset_seconds_at(zone, instant_ms) as f64 / 60.0).round() as i64
}

/// The instant a wall clock names in a zone.
fn zoned_to_utc(zone: &Tz, date: NaiveDate, time: &str) -> i64 {
    let mut parts = time.split(':');
    let hour: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minute: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let wall = date.and_hms_opt(hour, minute, 0).unwrap_or_default().and_utc().timestamp_millis();
    let before = offset_minutes_at(zone, wall - DAY_MS);
    let after = offset_minutes_at(zone, wall + DAY_MS);
    if before == after {
        return wall - before * 60_000;
    }
    let candidate_before = wall - before * 60_000;
    let candidate_after = wall - after * 60_000;
    let before_round = offset_minutes_at(zone, candidate_before) == before;
    let after_round = offset_minutes_at(zone, candidate_after) == after;
    if before_round && after_round {
        return candidate_before.min(candidate_after);
    }
    if before_round != after_round {
        return if before_round { candidate_before } else { candidate_after };
    }
    // The wall clock never happened. Search for the moment the clocks change.
    let (mut lo, mut hi) = (candidate_before.min(candidate_after), candidate_before.max(candidate_after));
    while hi - lo > 1000 {
        let mid = (lo + hi).div_euclid(2);
        if offset_minutes_at(zone, mid) == before {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi
}

fn local_day(instant_ms: i64, zone: &Tz) -> NaiveDate {
    let utc = chrono::DateTime::from_timestamp_millis(instant_ms).unwrap_or_default();
    zone.from_utc_datetime(&utc.naive_utc()).date_naive()
}

/// Doses of `plan` whose instant falls inside `[from, to]` (milliseconds), oldest first.
pub fn expand(plan: &Plan, from: i64, to: i64) -> Vec<Occurrence> {
    let zone: Tz = plan.zone.parse().unwrap_or(chrono_tz::UTC);
    let scan_from = plan.start.max(local_day(from, &zone) - Duration::days(1));
    let unbounded = local_day(to, &zone) + Duration::days(1);
    let scan_to = plan.end.map_or(unbounded, |e| e.min(unbounded));
    let mut out = Vec::new();
    let mut day = scan_from;
    while day <= scan_to {
        if eligible(plan, day) {
            for time in &plan.dose_times {
                let at = zoned_to_utc(&zone, day, time);
                if at >= from && at <= to {
                    out.push(Occurrence { date: day, time: time.clone(), at });
                }
            }
        }
        day += Duration::days(1);
    }
    out.sort_by_key(|o| o.at);
    out
}
