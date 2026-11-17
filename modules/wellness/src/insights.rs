//! Wellness insights, worked out in code from the person's own rows. Every figure and every word
//! comes from stored records and fixed text, and nothing here reaches a model.
use crate::{
    adherence::{self, DAY_MS},
    checkins::CHECKINS,
    medications,
    schedule::{self, Log, Med},
};
use chrono::{DateTime, Datelike, NaiveDate};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Response, Result,
};
use serde_json::{json, Value};

const WINDOW_DAYS: i64 = 30;
const MIN_CHECKINS: usize = 7;
const MIN_DAYS: f64 = 7.0;
const DAY_NAMES: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// The parts of one check-in an insight reads.
pub struct Checkin {
    pub at_ms: i64,
    pub local_date: Option<NaiveDate>,
    pub core: String,
    pub note: Option<String>,
}

fn polarity(core: &str) -> f64 {
    match core {
        "happy" => 1.0,
        "sad" => -1.0,
        "fear" => -0.8,
        "anger" | "disgust" => -0.7,
        "surprise" => 0.2,
        _ => 0.0,
    }
}

/// Rounds half up, as the old code's `Math.round` did.
pub fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Polarity times intensity, to one decimal place.
pub fn mood_index(core: &str, intensity: f64) -> f64 {
    round(polarity(core) * intensity * 10.0) / 10.0
}

/// The weekday (Sunday is 0) of the check-in's own calendar day. Older rows with no saved day use
/// the UTC day of the moment.
fn weekday(c: &Checkin) -> Option<usize> {
    let day = c.local_date.or_else(|| DateTime::from_timestamp_millis(c.at_ms).map(|d| d.date_naive()))?;
    Some(day.weekday().num_days_from_sunday() as usize)
}

fn percent(part: u32, whole: u32) -> i64 {
    round(f64::from(part) / f64::from(whole) * 100.0) as i64
}

#[derive(Default)]
struct Bucket {
    dow: usize,
    total: u32,
    off: u32,
    on: u32,
}

/// An insight line. The lead is the bold part and the rest follows it.
fn line(key: &str, icon: &str, tone: &str, lead: String, rest: String) -> Value {
    json!({"key": key, "icon": icon, "tone": tone, "lead": lead, "rest": rest})
}

fn common(checkins: &[Checkin]) -> Option<Value> {
    let mut tally: Vec<(&str, u32)> = Vec::new();
    for c in checkins.iter().filter(|c| !c.core.is_empty()) {
        match tally.iter_mut().find(|(core, _)| *core == c.core) {
            Some(entry) => entry.1 += 1,
            None => tally.push((&c.core, 1)),
        }
    }
    // The first feeling to reach the top count keeps it, as in the old order of arrival.
    let mut top: Option<(&str, u32)> = None;
    for &(core, count) in &tally {
        if count > top.map_or(0, |t| t.1) {
            top = Some((core, count));
        }
    }
    let (core, count) = top?;
    let tone = if polarity(core) > 0.0 { "pine" } else { "amber" };
    let mut name = core.to_owned();
    name[..1].make_ascii_uppercase();
    let mut out = line(
        "common",
        "Activity",
        tone,
        name,
        format!(" was your most-logged feeling this month \u{2014} {count} of {} check-ins.", checkins.len()),
    );
    out["emotion"] = json!(core);
    Some(out)
}

fn weekdays(checkins: &[Checkin]) -> (Option<Value>, Option<Value>) {
    let mut buckets: Vec<Bucket> = Vec::new();
    for c in checkins {
        let Some(dow) = weekday(c) else { continue };
        let on_track = polarity(&c.core) > 0.0;
        let at = match buckets.iter().position(|b| b.dow == dow) {
            Some(at) => at,
            None => {
                buckets.push(Bucket { dow, ..Bucket::default() });
                buckets.len() - 1
            }
        };
        let bucket = &mut buckets[at];
        bucket.total += 1;
        if on_track { bucket.on += 1 } else { bucket.off += 1 }
    }
    // Only weekdays with two or more check-ins count, and only at 80 percent or more.
    let (mut hardest, mut strongest): (Option<(usize, i64, u32)>, Option<(usize, i64, u32)>) = (None, None);
    for b in buckets.iter().filter(|b| b.total >= 2) {
        let (off, on) = (percent(b.off, b.total), percent(b.on, b.total));
        if off >= 80 && hardest.is_none_or(|(_, best, total)| off > best || (off == best && b.total > total)) {
            hardest = Some((b.dow, off, b.total));
        }
        if on >= 80 && strongest.is_none_or(|(_, best, total)| on > best || (on == best && b.total > total)) {
            strongest = Some((b.dow, on, b.total));
        }
    }
    let hardest = hardest.map(|(dow, pct, _)| {
        line(
            "hardest",
            "CloudRain",
            "amber",
            format!("{}s", DAY_NAMES[dow]),
            format!(" tend to be hardest \u{2014} {pct}% of them landed in off-track states. Worth a gentler plan."),
        )
    });
    let strongest = strongest.map(|(dow, pct, _)| {
        line("strongest", "Sun", "pine", format!("{}s", DAY_NAMES[dow]), format!(" are your strongest day \u{2014} {pct}% on-track check-ins."))
    });
    (hardest, strongest)
}

fn notes(checkins: &[Checkin]) -> Option<Value> {
    let n = checkins
        .iter()
        .filter(|c| (c.core == "sad" || c.core == "anger") && c.note.as_deref().is_some_and(|t| !t.is_empty()))
        .count();
    if n == 0 {
        return None;
    }
    let mut out = line(
        "notes",
        "NotebookPen",
        "steel",
        format!("{n} sad or angry check-in{}", if n > 1 { "s" } else { "" }),
        " carry a note. Reading them together may surface a recurring trigger.".into(),
    );
    out["action"] = json!("review-notes");
    Some(out)
}

fn adherence_line(logs: &[Log], meds: &[Med], expected: i64) -> Value {
    let scheduled: Vec<&str> = meds.iter().filter(|m| m.frequency_type != "as_needed").map(|m| m.id.as_str()).collect();
    let taken = logs
        .iter()
        .filter(|l| l.scheduled_for.is_some() && scheduled.contains(&l.medication_id.as_str()) && l.status == "taken")
        .count() as i64;
    let rate = if expected > 0 { round(taken as f64 / expected as f64 * 100.0) as i64 } else { 0 };
    let missed = (expected - taken).max(0);
    let steady = rate >= 85;
    let rest = if steady {
        " on your medication over the last 30 days \u{2014} steady.".to_owned()
    } else {
        format!(" on your medication over the last 30 days \u{2014} {missed} dose{} missed.", if missed == 1 { "" } else { "s" })
    };
    line("adherence", "Pill", if steady { "pine" } else { "amber" }, format!("{rate}% adherence"), rest)
}

/// The insight lines for the last 30 days. `expected` is the number of scheduled dose slots in the
/// window, so doses that were never logged count as missed. With under a week of history there are none.
pub fn compute(checkins: &[Checkin], logs: &[Log], meds: &[Med], now_ms: i64, expected: i64) -> Vec<Value> {
    if checkins.len() < MIN_CHECKINS {
        return vec![];
    }
    let earliest = checkins.iter().map(|c| c.at_ms).min().unwrap_or(i64::MAX);
    if ((now_ms - earliest) as f64 / DAY_MS as f64) < MIN_DAYS {
        return vec![];
    }
    let (hardest, strongest) = weekdays(checkins);
    [common(checkins), hardest, strongest, notes(checkins), Some(adherence_line(logs, meds, expected))]
        .into_iter()
        .flatten()
        .collect()
}

fn checkin_from_row(row: &Value) -> Result<Checkin> {
    let bad = || Error::new("Invalid check-in row");
    let at = DateTime::parse_from_rfc3339(row["checked_in_at"].as_str().ok_or_else(bad)?).map_err(|_| bad())?;
    Ok(Checkin {
        at_ms: at.timestamp_millis(),
        local_date: row["local_date"].as_str().and_then(|t| NaiveDate::parse_from_str(t.get(..10)?, "%Y-%m-%d").ok()),
        core: row["feeling_core"].as_str().unwrap_or_default().to_owned(),
        note: row["note"].as_str().map(str::to_owned),
    })
}

/// `GET /wellness/insights`. The person's own rows only, as the old route read them.
pub fn route<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let context = medications::today(host)?;
    let zone = context["timezone"].as_str().unwrap_or("UTC");
    let today = NaiveDate::parse_from_str(context["date"].as_str().unwrap_or(""), "%Y-%m-%d").map_err(|_| Error::new("Invalid date"))?;
    let now = DateTime::parse_from_rfc3339(context["now"].as_str().unwrap_or("")).map_err(|_| Error::new("Invalid moment"))?.timestamp_millis();
    let since = now - WINDOW_DAYS * DAY_MS;
    let mut query = Query::select(Filter::Compare { column: "checked_in_at".into(), op: Compare::Ge, value: json!(schedule::iso_ms(since)) });
    query.order = vec![Order { column: "checked_in_at".into(), descending: false }];
    let checkins = Client(host).query(CHECKINS, &query)?.iter().map(checkin_from_row).collect::<Result<Vec<_>>>()?;
    let (meds, logs) = (adherence::meds(host)?, adherence::logs_since(host, since)?);
    let mut expected = 0_i64;
    for back in (0..WINDOW_DAYS).rev() {
        expected += adherence::scheduled(&adherence::day_slots(&meds, &logs, schedule::previous_day(today, back), zone)).count() as i64;
    }
    Ok(Response::new(200, json!({"insights": compute(&checkins, &logs, &meds, now, expected)})))
}
