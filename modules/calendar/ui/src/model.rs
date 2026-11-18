//! Plain calendar dates and clipped event segments, independent of the browser timezone.
use chrono::{DateTime, Datelike, Days, Duration, Months, NaiveDate, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub is_moss_block: bool,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub attendee_count: f64,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub unconfirmed: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub event: Event,
    pub day: NaiveDate,
    pub first_day: bool,
    pub start_min: u32,
    pub end_min: u32,
    pub column: usize,
    pub columns: usize,
}

pub fn zone(value: &str) -> Option<Tz> {
    chrono_tz::TZ_VARIANTS
        .iter()
        .find(|z| z.name().eq_ignore_ascii_case(value))
        .copied()
}

/// Initial grid position; a retained user position takes precedence on remount.
pub fn grid_scroll_top(now_min: u32, viewport_height: i32, saved: Option<i32>) -> i32 {
    saved.unwrap_or_else(|| {
        (now_min as f64 * 58.0 / 60.0 - viewport_height as f64 / 2.0).max(0.0) as i32
    })
}

pub fn today(now: &str, zone: Tz) -> Option<NaiveDate> {
    Some(
        DateTime::parse_from_rfc3339(now)
            .ok()?
            .with_timezone(&zone)
            .date_naive(),
    )
}
fn clock(date: DateTime<Tz>) -> u32 {
    date.hour() * 60 + date.minute()
}
pub fn week(cursor: NaiveDate, work: bool) -> Vec<NaiveDate> {
    let sunday = cursor - Duration::days(cursor.weekday().num_days_from_sunday() as i64);
    let range = if work { 1..6 } else { 0..7 };
    range.map(|i| sunday + Duration::days(i)).collect()
}
pub fn month(cursor: NaiveDate) -> Vec<NaiveDate> {
    let first = cursor.with_day(1).unwrap();
    let start = first - Duration::days(first.weekday().num_days_from_sunday() as i64);
    let length = if (start + Duration::days(35)).month() == cursor.month() {
        42
    } else {
        35
    };
    (0..length).map(|i| start + Duration::days(i)).collect()
}
pub fn navigate(cursor: NaiveDate, view: &str, dir: i32) -> NaiveDate {
    match view {
        "month" if dir < 0 => cursor.checked_sub_months(Months::new(1)).unwrap_or(cursor),
        "month" => cursor.checked_add_months(Months::new(1)).unwrap_or(cursor),
        "week" => cursor + Duration::days(7 * dir as i64),
        _ => cursor + Duration::days(dir as i64),
    }
}
pub fn group(events: &[Event], zone: Tz) -> BTreeMap<NaiveDate, Vec<Segment>> {
    let mut days: BTreeMap<NaiveDate, Vec<Segment>> = BTreeMap::new();
    for event in events {
        let Ok(start) = DateTime::parse_from_rfc3339(&event.starts_at) else {
            continue;
        };
        let end = DateTime::parse_from_rfc3339(&event.ends_at).ok();
        let local_start = start.with_timezone(&zone);
        let first = if event.all_day {
            start.with_timezone(&Utc).date_naive()
        } else {
            local_start.date_naive()
        };
        let start_min = clock(local_start);
        let end_min = end
            .map(|d| clock(d.with_timezone(&zone)))
            .unwrap_or(start_min + 60);
        let valid_end = end.filter(|d| *d > start);
        let last = match valid_end {
            Some(end) if event.all_day => {
                (end.with_timezone(&Utc).date_naive() - Duration::days(1)).max(first)
            }
            Some(end) => {
                let last = end.with_timezone(&zone).date_naive();
                if end_min == 0 && last > first {
                    last - Duration::days(1)
                } else {
                    last
                }
            }
            None => first,
        }
        .max(first);
        // Iterate only real covered days. No wall-clock duration arithmetic across DST.
        let mut day = first;
        loop {
            let segment = Segment {
                event: event.clone(),
                day,
                first_day: day == first,
                start_min: if event.all_day || day == first {
                    start_min
                } else {
                    0
                },
                end_min: if event.all_day || valid_end.is_none() {
                    end_min
                } else if day < last || end_min == 0 {
                    1440
                } else {
                    end_min
                },
                column: 0,
                columns: 1,
            };
            days.entry(day).or_default().push(segment);
            if day >= last {
                break;
            }
            let Some(next) = day.checked_add_days(Days::new(1)) else {
                break;
            };
            day = next;
        }
    }
    days
}

pub fn pack(events: &[Segment]) -> Vec<Segment> {
    let mut items: Vec<_> = events
        .iter()
        .filter(|e| !e.event.all_day)
        .cloned()
        .collect();
    items.sort_by(|a, b| {
        a.start_min
            .cmp(&b.start_min)
            .then(b.end_min.cmp(&a.end_min))
    });
    let mut start = 0;
    while start < items.len() {
        let mut end = start + 1;
        let mut boundary = items[start].end_min;
        while end < items.len() && items[end].start_min < boundary {
            boundary = boundary.max(items[end].end_min);
            end += 1;
        }
        let mut columns = Vec::new();
        for event in &mut items[start..end] {
            let column = columns
                .iter()
                .position(|last| event.start_min >= *last)
                .unwrap_or(columns.len());
            if column == columns.len() {
                columns.push(event.end_min);
            } else {
                columns[column] = event.end_min;
            }
            event.column = column;
        }
        for event in &mut items[start..end] {
            event.columns = columns.len();
        }
        start = end;
    }
    items
}

pub fn time(minutes: u32, twelve: bool) -> String {
    let hour = minutes / 60 % 24;
    if twelve {
        let shown = if hour.is_multiple_of(12) {
            12
        } else {
            hour % 12
        };
        let suffix = if hour < 12 { "AM" } else { "PM" };
        if minutes.is_multiple_of(60) {
            format!("{shown} {suffix}")
        } else {
            format!("{shown}:{:02} {suffix}", minutes % 60)
        }
    } else {
        format!("{hour:02}:{:02}", minutes % 60)
    }
}

/// Match Calendar's dateRangeLabel: all-day and local-midnight ends are exclusive.
/// Wording currently uses the default English locale, as the other packaged date labels do.
pub fn date_range(event: &Event, zone: Tz) -> String {
    let Ok(start) = DateTime::parse_from_rfc3339(&event.starts_at) else {
        return String::new();
    };
    let end = DateTime::parse_from_rfc3339(&event.ends_at)
        .ok()
        .filter(|e| *e > start);
    let first = if event.all_day {
        start.with_timezone(&Utc).date_naive()
    } else {
        start.with_timezone(&zone).date_naive()
    };
    let last = end
        .map(|e| {
            if event.all_day {
                (e.with_timezone(&Utc).date_naive() - Duration::days(1)).max(first)
            } else {
                let local = e.with_timezone(&zone);
                let day = local.date_naive();
                if clock(local) == 0 {
                    day - Duration::days(1)
                } else {
                    day
                }
            }
        })
        .unwrap_or(first)
        .max(first);
    if first == last {
        first.format("%A, %B %-d").to_string()
    } else {
        format!(
            "{} – {}",
            first.format("%A, %B %-d"),
            last.format("%A, %B %-d")
        )
    }
}

/// Default English wording from the existing Calendar rangeLabel.
pub fn range_label(cursor: NaiveDate, view: &str, work: bool) -> String {
    match view {
        "day" => cursor.format("%B %-d").to_string(),
        "week" => {
            let days = week(cursor, work);
            format!(
                "{} – {}",
                days[0].format("%b %-d"),
                days.last().unwrap().format("%b %-d")
            )
        }
        _ => cursor.format("%B %Y").to_string(),
    }
}

pub fn twelve(format: Option<&str>) -> bool {
    format == Some("12")
}

/// Match Calendar's fmtDur for rounded elapsed minutes, including signed input.
pub fn duration(minutes: i64) -> String {
    let hours = minutes.div_euclid(60);
    let rest = minutes % 60;
    if hours == 0 {
        format!("{rest} min")
    } else if rest == 0 {
        format!("{hours} hr")
    } else {
        format!("{hours} hr {rest} min")
    }
}
