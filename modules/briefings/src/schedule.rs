//! Schedule rules for briefings. The pure functions take the clock and zones as inputs so tests
//! can fix them. `reconcile` is the only function that talks to the host.
use chrono::{DateTime, Datelike, Timelike, Utc};
use chrono_tz::Tz;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Map, Value};

pub const QUEUE: &str = "briefings-run";
const DEFAULT_CRON: &str = "0 7 * * *";
const DEFAULT_ZONE: &str = "UTC";

/// A misaligned scheduled fire still runs when it lands at most this long after the target.
pub const LATE_FIRE_GRACE_MINUTES: i64 = 180;

pub type Metadata = Map<String, Value>;

/// Zones the old app accepted. A name is valid when the time zone database knows it.
pub fn valid_zone(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 64 && name.parse::<Tz>().is_ok()
}

pub fn timezone_for(metadata: &Metadata) -> String {
    match metadata.get("timezone").and_then(Value::as_str) {
        Some(zone) if valid_zone(zone) => zone.to_owned(),
        _ => DEFAULT_ZONE.to_owned(),
    }
}

/// `^([01]?\d|2[0-3]):([0-5]\d)$` on the trimmed text, as hour and minute.
fn target_time(raw: &str) -> Option<(u32, u32)> {
    let (hour, minute) = crate::text::js_trim(raw).split_once(':')?;
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(hour) || !digits(minute) || minute.len() != 2 || hour.is_empty() || hour.len() > 2 {
        return None;
    }
    let (h, m) = (hour.parse::<u32>().ok()?, minute.parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

pub fn cron_expr_for(cadence: &str, metadata: &Metadata) -> String {
    let Some((hour, minute)) = metadata
        .get("targetTime")
        .and_then(Value::as_str)
        .and_then(target_time)
    else {
        return DEFAULT_CRON.to_owned();
    };
    if cadence == "weekly" {
        let day = match metadata.get("dayOfWeek") {
            Some(Value::Number(n)) => n.to_string(),
            _ => "1".to_owned(),
        };
        return format!("{minute} {hour} * * {day}");
    }
    format!("{minute} {hour} * * *")
}

/// The schedule a new definition gets when the caller sent none.
pub fn default_metadata_for(kind: &str, zone: &str) -> Metadata {
    let value = match kind {
        "evening" => json!({"targetTime":"19:00","timezone":zone}),
        "weekly_review" => json!({"targetTime":"09:00","timezone":zone,"dayOfWeek":0}),
        _ => json!({"targetTime":"07:00","timezone":zone}),
    };
    value.as_object().cloned().unwrap_or_default()
}

pub struct Scheduled<'a> {
    pub id: &'a str,
    pub briefing_type: &'a str,
    pub cadence: &'a str,
    pub enabled: bool,
    pub metadata: &'a Metadata,
}

fn schedule_params(definition: &Scheduled<'_>, cron: &str, zone: &str) -> Value {
    json!({
        "cron": cron,
        "timezone": zone,
        "key": definition.id,
        "params": {
            "definition-id": definition.id,
            "run-kind": "scheduled",
            "briefing-type": definition.briefing_type,
        },
    })
}

/// Registers the definition's cron in the owner's zone, or removes it when the definition is
/// manual or switched off. The owner's zone wins over the one stored on the definition.
pub fn reconcile<H: Host + ?Sized>(
    host: &H,
    definition: &Scheduled<'_>,
    owner_zone: Option<&str>,
) -> Result<()> {
    if definition.enabled && matches!(definition.cadence, "daily" | "weekly") {
        let cron = cron_expr_for(definition.cadence, definition.metadata);
        let zone = owner_zone
            .map(str::to_owned)
            .unwrap_or_else(|| timezone_for(definition.metadata));
        host.call("jobs", "schedule", QUEUE, schedule_params(definition, &cron, &zone))?;
        return Ok(());
    }
    // The keyed schedule call is idempotent and returns the stable id to cancel.
    let registered = host.call(
        "jobs",
        "schedule",
        QUEUE,
        schedule_params(definition, DEFAULT_CRON, DEFAULT_ZONE),
    )?;
    if let Some(id) = registered["id"].as_str() {
        host.call("jobs", "unschedule", QUEUE, json!({"id":id}))?;
    }
    Ok(())
}

/// A schedule write that never fails its caller.
pub fn reconcile_quietly<H: Host + ?Sized>(
    host: &H,
    definition: &Scheduled<'_>,
    owner_zone: Option<&str>,
) {
    let _ = reconcile(host, definition, owner_zone);
}

#[derive(Debug, PartialEq, Eq)]
pub struct Alignment {
    /// The cron was registered in another zone and must be registered again in the owner's.
    pub realigned: bool,
    /// Whether this fire should produce a run.
    pub run: bool,
}

/// An aligned fire always runs. A misaligned fire runs only when it lands on the target day
/// within the grace after the target time in the owner's zone.
pub fn align_fire(
    definition: &Scheduled<'_>,
    registered_zone: Option<&str>,
    owner_zone: &str,
    now: DateTime<Utc>,
) -> Alignment {
    match registered_zone {
        None => Alignment { realigned: false, run: true },
        Some(zone) if zone == owner_zone => Alignment { realigned: false, run: true },
        Some(_) => Alignment {
            realigned: true,
            run: fires_within_grace(definition, owner_zone, now),
        },
    }
}

pub fn fires_within_grace(definition: &Scheduled<'_>, zone: &str, now: DateTime<Utc>) -> bool {
    let cron = cron_expr_for(definition.cadence, definition.metadata);
    let fields: Vec<&str> = cron.split(' ').collect();
    let (Ok(minute), Ok(hour)) = (fields[0].parse::<i64>(), fields[1].parse::<i64>()) else {
        return false;
    };
    let Ok(tz) = zone.parse::<Tz>() else { return false };
    let local = now.with_timezone(&tz);
    if fields[4] != "*" {
        let weekday = i64::from(local.weekday().num_days_from_sunday());
        if fields[4].parse::<f64>().ok() != Some(weekday as f64) {
            return false;
        }
    }
    let late = i64::from(local.hour()) * 60 + i64::from(local.minute()) - (hour * 60 + minute);
    (0..=LATE_FIRE_GRACE_MINUTES).contains(&late)
}
