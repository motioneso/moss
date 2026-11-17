//! One day's dose slots from a person's medications and that day's logs. It follows the old
//! schedule rules, including their plain calendar model. The caller sends its own local date.
//! Each medication then places its dose times on that date in UTC, except the two families that
//! carry a start date (every interval and monthly), which use the medication's own time zone.
use crate::occurrence::{expand, Family, Plan, DAY_MS};
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat};
use moss_module_sdk::{Error, Result};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default)]
pub struct Med {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub frequency_type: String,
    pub interval_hours: Option<i64>,
    pub weekdays: Vec<u32>,
    pub schedule_times: Vec<String>,
    pub cycle_days_on: Option<i64>,
    pub cycle_days_off: Option<i64>,
    pub cycle_anchor_date: Option<NaiveDate>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub time_zone: Option<String>,
    pub interval_unit: Option<String>,
    pub interval_count: Option<i64>,
    pub month_kind: Option<String>,
    pub month_day: Option<i64>,
    pub month_day_is_last: bool,
    pub month_weekday_position: Option<String>,
    pub month_weekday: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Log {
    pub medication_id: String,
    pub status: String,
    pub scheduled_for: Option<i64>,
    pub logged_at: i64,
}

fn bad() -> Error {
    Error::new("Invalid medication row")
}

fn date_of(value: &Value) -> Result<Option<NaiveDate>> {
    match value.as_str() {
        None => Ok(None),
        Some(text) => NaiveDate::parse_from_str(text.get(..10).ok_or_else(bad)?, "%Y-%m-%d").map(Some).map_err(|_| bad()),
    }
}

fn whole(value: &Value) -> Option<i64> {
    value.as_i64()
}

/// A medication from a database row.
pub fn med_from_row(row: &Value) -> Result<Med> {
    let text = |key: &str| row[key].as_str().map(str::to_owned);
    Ok(Med {
        id: text("id").ok_or_else(bad)?,
        name: text("name").ok_or_else(bad)?,
        active: row["active"].as_bool().unwrap_or(true),
        frequency_type: text("frequency_type").ok_or_else(bad)?,
        interval_hours: whole(&row["interval_hours"]),
        weekdays: row["weekdays"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect()),
        schedule_times: row["schedule_times"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()),
        cycle_days_on: whole(&row["cycle_days_on"]),
        cycle_days_off: whole(&row["cycle_days_off"]),
        cycle_anchor_date: date_of(&row["cycle_anchor_date"])?,
        start_date: date_of(&row["schedule_start_date"])?,
        end_date: date_of(&row["schedule_end_date"])?,
        time_zone: text("time_zone"),
        interval_unit: text("interval_unit"),
        interval_count: whole(&row["interval_count"]),
        month_kind: text("month_kind"),
        month_day: whole(&row["month_day"]),
        month_day_is_last: row["month_day_is_last"].as_bool().unwrap_or(false),
        month_weekday_position: text("month_weekday_position"),
        month_weekday: whole(&row["month_weekday"]),
    })
}

/// A dose-log row.
pub fn log_from_row(row: &Value) -> Result<Log> {
    let moment = |value: &Value| -> Result<Option<i64>> {
        match value.as_str() {
            None => Ok(None),
            Some(t) => DateTime::parse_from_rfc3339(t).map(|d| Some(d.timestamp_millis())).map_err(|_| Error::new("Invalid dose row")),
        }
    };
    Ok(Log {
        medication_id: row["medication_id"].as_str().ok_or_else(bad)?.to_owned(),
        status: row["status"].as_str().ok_or_else(bad)?.to_owned(),
        scheduled_for: moment(&row["scheduled_for"])?,
        logged_at: moment(&row["logged_at"])?.ok_or_else(bad)?,
    })
}

pub fn iso_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The clock times an every-N-hours medication takes in one day, from its first time.
pub fn every_n_hours_times(interval_hours: Option<i64>, anchor: Option<&str>) -> Vec<String> {
    let Some(hours) = interval_hours.filter(|h| *h > 0) else { return vec![] };
    let mut parts = anchor.unwrap_or("00:00").split(':');
    let hour: i64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minute: i64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let step = hours * 60;
    let mut times = Vec::new();
    let mut t = (hour * 60 + minute) % step;
    while t < 24 * 60 {
        times.push(format!("{:02}:{:02}", t / 60, t % 60));
        t += step;
    }
    times
}

fn within_window(med: &Med, day: NaiveDate) -> bool {
    med.start_date.map_or(true, |s| day >= s) && med.end_date.map_or(true, |e| day <= e)
}

/// The engine plan for a medication. `None` means it makes no scheduled doses.
fn plan_for(med: &Med) -> Option<Plan> {
    let open = NaiveDate::from_ymd_opt(1970, 1, 1)?;
    let times = med.schedule_times.clone();
    let weekdays = med.weekdays.clone();
    let plan = |family: Family, dose_times: Vec<String>, start: NaiveDate, end: Option<NaiveDate>, zone: String| {
        Some(Plan { family, dose_times, start, end, zone })
    };
    let utc = || "UTC".to_owned();
    match med.frequency_type.as_str() {
        "specific_weekdays" => plan(Family::SelectedDays { weekdays }, times, open, None, utc()),
        "every_n_hours" => plan(Family::Daily, every_n_hours_times(med.interval_hours, times.first().map(String::as_str)), open, None, utc()),
        "cyclical" => {
            let on = med.cycle_days_on.unwrap_or(0);
            let off = med.cycle_days_off.unwrap_or(0);
            match med.cycle_anchor_date {
                Some(anchor) if on > 0 && on + off > 0 => plan(Family::Cycle { days_on: on, days_off: off }, times, anchor, None, utc()),
                _ => plan(Family::Daily, times, open, None, utc()),
            }
        }
        "every_interval" => {
            let zone = med.time_zone.clone().unwrap_or_else(utc);
            let interval = med.interval_count?;
            let family = match med.interval_unit.as_deref() {
                Some("weeks") => Family::EveryWeeks { interval, weekdays },
                Some("months") => Family::EveryMonths { interval },
                _ => Family::EveryDays { interval },
            };
            plan(family, times, med.start_date?, med.end_date, zone)
        }
        "monthly" => {
            let zone = med.time_zone.clone().unwrap_or_else(utc);
            let family = if med.month_kind.as_deref() == Some("weekdayPosition") {
                Family::MonthlyWeekday { position: med.month_weekday_position.clone()?, weekday: med.month_weekday? as u32 }
            } else {
                Family::MonthlyDate { last: med.month_day_is_last, day: med.month_day.unwrap_or(0) as u32 }
            };
            plan(family, times, med.start_date?, med.end_date, zone)
        }
        _ => plan(Family::Daily, times, open, None, utc()),
    }
}

fn slot_status(medication_id: &str, at: i64, logs: &[Log]) -> &'static str {
    for log in logs {
        if log.medication_id != medication_id {
            continue;
        }
        let Some(scheduled) = log.scheduled_for else { continue };
        if (scheduled - at).abs() < 60_000 {
            if log.status == "taken" {
                return "taken";
            }
            if log.status == "skipped" {
                return "skipped";
            }
        }
    }
    "pending"
}

fn prn_count(medication_id: &str, logs: &[Log]) -> usize {
    logs.iter().filter(|l| l.medication_id == medication_id && l.scheduled_for.is_none() && l.status == "prn").count()
}

/// The ordered slots for one local date. Scheduled slots come first, in time order.
pub fn compute(meds: &[Med], logs: &[Log], day: NaiveDate) -> Vec<Value> {
    let midnight = day.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc().timestamp_millis();
    let (from, to) = (midnight - DAY_MS, midnight + 2 * DAY_MS);
    let mut slots: Vec<(bool, String, Value)> = Vec::new();
    for med in meds.iter().filter(|m| m.active && within_window(m, day)) {
        if med.frequency_type == "as_needed" {
            slots.push((
                true,
                String::new(),
                json!({"medicationId":med.id,"name":med.name,"scheduledFor":null,"asNeeded":true,"status":"pending","prnCount":prn_count(&med.id, logs)}),
            ));
            continue;
        }
        let Some(plan) = plan_for(med) else { continue };
        for o in expand(&plan, from, to).into_iter().filter(|o| o.date == day) {
            let at = iso_ms(o.at);
            let local: String = o.time.chars().take(5).collect();
            slots.push((
                false,
                at.clone(),
                json!({"medicationId":med.id,"name":med.name,"scheduledFor":at,"localTime":local,"asNeeded":false,"status":slot_status(&med.id, o.at, logs)}),
            ));
        }
    }
    slots.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    slots.into_iter().map(|(_, _, v)| v).collect()
}

pub fn previous_day(day: NaiveDate, back: i64) -> NaiveDate {
    day - Duration::days(back)
}

/// The instant a local calendar day starts in a zone.
pub fn local_day_start(day: NaiveDate, zone: &str) -> i64 {
    let zone: chrono_tz::Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    let local_as_utc = day.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc().timestamp_millis();
    let first = local_as_utc - crate::occurrence::offset_seconds_at(&zone, local_as_utc) * 1000;
    local_as_utc - crate::occurrence::offset_seconds_at(&zone, first) * 1000
}

/// Does a dose log belong to a local date? A scheduled log goes by its slot, with a day of
/// slack either side. An unscheduled one goes by when it was logged, in the person's zone.
pub fn log_in_day(log: &Log, day: NaiveDate, zone: &str) -> bool {
    let midnight = day.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc().timestamp_millis();
    match log.scheduled_for {
        Some(at) => at >= midnight - DAY_MS && at < midnight + 2 * DAY_MS,
        None => log.logged_at >= local_day_start(day, zone) && log.logged_at < local_day_start(day + Duration::days(1), zone),
    }
}
