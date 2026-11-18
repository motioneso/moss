//! Medication list, create, change and dose logging (`app.medications`, `app.medication_logs`).
use crate::{
    medication_input::{self, Schedule},
    util::{bad_request, error, iso, iso_or_null, values},
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const MEDICATIONS: &str = "app.medications";
pub const LOGS: &str = "app.medication_logs";

/// The person's calendar day, zone and current moment.
pub fn today<H: Host + ?Sized>(host: &H) -> Result<Value> {
    host.call("context", "local-date", "account", json!({}))
}

/// `GET /wellness/local-day`. The person's calendar day and zone, for the screen's date maths.
pub fn local_day<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let day = today(host)?;
    Ok(Response::new(200, json!({"date": day["date"], "timezone": day["timezone"]})))
}

fn date_text(row: &Value, key: &str) -> Value {
    row[key].as_str().map_or(Value::Null, |t| json!(t.get(..10).unwrap_or(t)))
}

fn dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid medication row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "ownerUserId": text("owner_user_id")?,
        "name": text("name")?,
        "dosage": row["dosage"],
        "form": row["form"],
        "frequencyType": text("frequency_type")?,
        "timesPerDay": row["times_per_day"],
        "intervalHours": row["interval_hours"],
        "weekdays": row["weekdays"],
        "scheduleTimes": row["schedule_times"],
        "cycleDaysOn": row["cycle_days_on"],
        "cycleDaysOff": row["cycle_days_off"],
        "cycleAnchorDate": date_text(row, "cycle_anchor_date"),
        "active": row["active"],
        "notes": row["notes"],
        "createdAt": iso_or_null(&row["created_at"])?,
        "updatedAt": iso_or_null(&row["updated_at"])?,
        "scheduleStartDate": date_text(row, "schedule_start_date"),
        "scheduleEndDate": date_text(row, "schedule_end_date"),
        "timeZone": row["time_zone"],
        "intervalUnit": row["interval_unit"],
        "intervalCount": row["interval_count"],
        "monthKind": row["month_kind"],
        "monthDay": row["month_day"],
        "monthDayIsLast": row["month_day_is_last"],
        "monthWeekdayPosition": row["month_weekday_position"],
        "monthWeekday": row["month_weekday"],
        "remindersEnabled": row["reminders_enabled"],
    }))
}

fn log_dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid dose row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "medicationId": text("medication_id")?,
        "status": text("status")?,
        "dose": row["dose"],
        "prnReason": row["prn_reason"],
        "scheduledFor": iso_or_null(&row["scheduled_for"])?,
        "loggedAt": iso(&row["logged_at"])?,
    }))
}

/// Every schedule column. A column the chosen type does not use is written as null, so a change
/// from one type to another leaves nothing behind.
fn schedule_pairs(s: &Schedule, zone: &str) -> Vec<(&'static str, Value)> {
    let list = |v: &Option<Vec<i64>>| v.as_ref().map_or(Value::Null, |d| json!(d));
    vec![
        ("frequency_type", json!(s.frequency_type)),
        ("times_per_day", json!(s.times_per_day)),
        ("interval_hours", json!(s.interval_hours)),
        ("weekdays", list(&s.weekdays)),
        ("schedule_times", s.schedule_times.as_ref().map_or(Value::Null, |t| json!(t))),
        ("cycle_days_on", json!(s.cycle_days_on)),
        ("cycle_days_off", json!(s.cycle_days_off)),
        ("cycle_anchor_date", json!(s.cycle_anchor_date)),
        ("schedule_start_date", json!(s.start_date)),
        ("schedule_end_date", json!(s.end_date)),
        ("time_zone", json!(zone)),
        ("interval_unit", json!(s.interval_unit)),
        ("interval_count", json!(s.interval_count)),
        ("month_kind", json!(s.month_kind)),
        ("month_day", json!(s.month_day)),
        ("month_day_is_last", json!(s.month_day_is_last)),
        ("month_weekday_position", json!(s.month_weekday_position)),
        ("month_weekday", json!(s.month_weekday)),
    ]
}

fn or_null(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// Every medication of the person, active ones first, then by name.
pub fn all<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "active".into(), descending: true },
        Order { column: "name".into(), descending: false },
    ];
    Client(host).query(MEDICATIONS, &query)
}

fn find<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq("id", id));
    query.limit = Some(1);
    Ok(Client(host).query(MEDICATIONS, &query)?.into_iter().next())
}

/// `GET /wellness/medications`.
pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let medications = all(host)?.iter().map(dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"medications": medications})))
}

/// `POST /wellness/medications`.
pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let data = match medication_input::create(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let zone = today(host)?["timezone"].as_str().unwrap_or("UTC").to_owned();
    let mut pairs = vec![
        ("name", json!(data.name)),
        ("dosage", or_null(data.dosage)),
        ("form", or_null(data.form)),
        ("notes", or_null(data.notes)),
        ("reminders_enabled", json!(data.reminders_enabled.unwrap_or(false))),
    ];
    pairs.extend(schedule_pairs(&data.schedule, &zone));
    let row = Client(host)
        .query(MEDICATIONS, &Query::insert(values(pairs)))?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("Medication could not be saved"))?;
    Ok(Response::new(201, json!({"medication": dto(&row)?})))
}

/// `PATCH /wellness/medications/:id`. A schedule change replaces the whole schedule.
pub fn change<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default().to_owned();
    let data = match medication_input::change(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    if data.reminders_enabled == Some(true) && data.schedule.is_none() {
        let stored = find(host, &id)?;
        if stored.is_some_and(|m| m["frequency_type"] == "as_needed") {
            return Ok(bad_request("remindersEnabled is not allowed for as_needed"));
        }
    }
    let day = today(host)?;
    let zone = day["timezone"].as_str().unwrap_or("UTC").to_owned();
    let mut pairs = vec![("updated_at", json!(iso_now(&day)?))];
    if let Some(v) = data.name { pairs.push(("name", json!(v))); }
    if let Some(v) = data.dosage { pairs.push(("dosage", or_null(v))); }
    if let Some(v) = data.form { pairs.push(("form", or_null(v))); }
    if let Some(v) = data.active { pairs.push(("active", json!(v))); }
    if let Some(v) = data.notes { pairs.push(("notes", or_null(v))); }
    if let Some(v) = data.reminders_enabled { pairs.push(("reminders_enabled", json!(v))); }
    if let Some(schedule) = &data.schedule {
        pairs.extend(schedule_pairs(schedule, &zone));
        // An as-needed medication has no time for a reminder, so the switch goes off with the change.
        if schedule.frequency_type == "as_needed" {
            pairs.retain(|(k, _)| *k != "reminders_enabled");
            pairs.push(("reminders_enabled", json!(false)));
        }
    }
    let rows = Client(host).query(MEDICATIONS, &Query::update(Filter::eq("id", id.as_str()), values(pairs)))?;
    match rows.first() {
        None => Ok(error(404, "Medication not found")),
        Some(row) => Ok(Response::new(200, json!({"medication": dto(row)?}))),
    }
}

fn iso_now(day: &Value) -> Result<String> {
    iso(&day["now"])
}

/// Any moment text the old server read: a full timestamp, one with no zone (taken as UTC), or a date.
fn parse_moment(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(at.timestamp_millis());
    }
    for pattern in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(at) = NaiveDateTime::parse_from_str(trimmed, pattern) {
            return Some(at.and_utc().timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
}

/// `POST /wellness/medications/:id/logs`. A repeat for the same slot corrects the earlier record.
pub fn log_dose<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default().to_owned();
    let data = match medication_input::dose(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let slot = match data.scheduled_for.as_deref() {
        None => None,
        Some(text) => match parse_moment(text) {
            Some(ms) => Some(DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis, true)),
            None => return Ok(bad_request("scheduledFor must be an ISO timestamp")),
        },
    };
    if find(host, &id)?.is_none() {
        return Ok(error(404, "Medication not found"));
    }
    let client = Client(host);
    let fields = |extra: Vec<(&'static str, Value)>| {
        let mut pairs = vec![
            ("status", json!(data.status)),
            ("dose", data.dose.clone().map_or(Value::Null, Value::String)),
            ("prn_reason", data.prn_reason.clone().map_or(Value::Null, Value::String)),
        ];
        pairs.extend(extra);
        values(pairs)
    };
    let insert = || client.query(LOGS, &Query::insert(fields(vec![("medication_id", json!(id)), ("scheduled_for", json!(slot))])));
    let row = match &slot {
        None => insert()?.into_iter().next(),
        Some(at) => {
            let same_slot = || Filter::And { filters: vec![Filter::eq("medication_id", id.as_str()), Filter::eq("scheduled_for", at.as_str())] };
            let correct = |now: &Value| client.query(LOGS, &Query::update(same_slot(), fields(vec![("logged_at", now.clone())])));
            let now = json!(iso_now(&today(host)?)?);
            let mut query = Query::select(same_slot());
            query.limit = Some(1);
            if client.query(LOGS, &query)?.is_empty() {
                match insert() {
                    Ok(rows) => rows.into_iter().next(),
                    // A second request took the slot first, so this one corrects that record.
                    Err(_) => correct(&now)?.into_iter().next(),
                }
            } else {
                correct(&now)?.into_iter().next()
            }
        }
    };
    let row = row.ok_or_else(|| Error::new("Dose could not be saved"))?;
    Ok(Response::new(201, json!({"log": log_dto(&row)?})))
}
