//! Calendar writes for the signed-in person's one active Google account. Calendar's tools call
//! these through Connectors' public API. Each write checks the calendar scope and the saved
//! grant first, talks to Google through the host and then mirrors the result into Calendar's
//! cache through Calendar's public API. Answers hold plain messages and ids, never tokens.
use crate::{kv, Error, Result};
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, TimeZone, Utc};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CALENDAR_SCOPES: [&str; 2] = ["https://www.googleapis.com/auth/calendar", "calendar"];
const STEP_MINUTES: i64 = 15;
const NO_SCOPE: &str =
    "Your Google connection doesn't have calendar-write permission yet — reconnect in Settings to grant it.";
const DISABLED: &str = "Calendar access is disabled for this account in Settings.";
const OUTLOOK: &str = "Outlook calendar is read-only. Change this event in Outlook.";
const GONE: &str = "That event isn't in your calendar — it may already be gone.";

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn instant(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|t| t.with_timezone(&Utc))
}

/// The active Google account that may write the calendar, or the refusal text.
struct Target {
    id: String,
    timezone: chrono_tz::Tz,
}

fn target(host: &impl Host) -> Result<std::result::Result<Target, &'static str>> {
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let found = setup["accounts"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["providerId"] == "google" && a["status"] == "active");
    let Some(found) = found else {
        return Ok(Err("Connect Google in Settings first."));
    };
    let scoped = found["scopes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|s| s.as_str().is_some_and(|s| CALENDAR_SCOPES.contains(&s)));
    if !scoped {
        return Ok(Err(NO_SCOPE));
    }
    let id = found["id"].as_str().unwrap_or("").to_string();
    if !crate::grants::is_granted(&setup["grants"][id.as_str()], "calendar") {
        return Ok(Err(DISABLED));
    }
    let timezone = setup["timezone"].as_str().and_then(|z| z.parse().ok()).unwrap_or(chrono_tz::UTC);
    Ok(Ok(Target { id, timezone }))
}

fn local_midnight(zone: chrono_tz::Tz, day: NaiveDate) -> DateTime<Utc> {
    let wall = day.and_hms_opt(0, 0, 0).expect("midnight");
    zone.from_local_datetime(&wall)
        .earliest()
        .or_else(|| zone.from_local_datetime(&(wall + Duration::hours(1))).earliest())
        .map_or_else(|| Utc.from_utc_datetime(&wall), |t| t.with_timezone(&Utc))
}

/// Whole local days around the window, so busy blocks keep their real ends.
fn query_window(zone: chrono_tz::Tz, start: DateTime<Utc>, end: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let first = start.with_timezone(&zone).date_naive();
    let last = (end - Duration::milliseconds(1)).max(start).with_timezone(&zone).date_naive();
    (local_midnight(zone, first), local_midnight(zone, last.succ_opt().unwrap_or(last)))
}

/// An all-day event comes back from freeBusy as whole local days from midnight to midnight.
fn all_day(zone: chrono_tz::Tz, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
    let span = end - start;
    let midnight = |t: DateTime<Utc>| {
        let local = t.with_timezone(&zone).time();
        local == chrono::NaiveTime::MIN
    };
    span > Duration::zero() && span.num_seconds() % 86_400 == 0 && midnight(start) && midnight(end)
}

/// The first free step inside the window, or None when every step collides.
fn choose_slot(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    busy: &[(DateTime<Utc>, DateTime<Utc>)],
    minutes: i64,
) -> Option<DateTime<Utc>> {
    let (step, length) = (Duration::minutes(STEP_MINUTES), Duration::minutes(minutes));
    let mut at = start;
    while at + length <= end {
        if !busy.iter().any(|(b, e)| *b < at + length && *e > at) {
            return Some(at);
        }
        at += step;
    }
    None
}

/// The id Google gets for a new block. The same request always makes the same id, so a repeat
/// is refused by Google instead of creating a second block.
fn block_id(account: &str, start: DateTime<Utc>, end: DateTime<Utc>, minutes: i64, title: &str) -> String {
    let canonical = format!("{account}|{}|{}|{minutes}|{title}", iso(start), iso(end));
    let alphabet = b"0123456789abcdefghijklmnopqrstuv";
    let tail: String = Sha256::digest(canonical.as_bytes()).iter().map(|b| alphabet[(b & 0x1f) as usize] as char).collect();
    format!("jfb{tail}")
}

fn refusal(message: &str, extra: Value) -> Value {
    let mut out = extra;
    out["message"] = json!(message);
    out
}

/// A failed Google write as a plain message. Sign-in problems ask for a reconnect.
fn google_failed(write: &Value, fallback: &'static str) -> (&'static str, Option<&'static str>) {
    let denied = write["error"]["status"] == 403;
    match (write["result"].as_str(), denied) {
        (Some("inactive") | Some("auth_failed"), _) => ("Connect Google in Settings first.", None),
        (_, true) => (fallback, Some("denied")),
        _ => (fallback, None),
    }
}

pub fn create(host: &impl Host, input: &Value) -> Result<Value> {
    let (Some(start), Some(end)) = (instant(&input["windowStart"]), instant(&input["windowEnd"])) else {
        return Err(Error::new(400, "windowStart and windowEnd are required"));
    };
    let minutes = input["durationMinutes"].as_i64().filter(|m| *m > 0).ok_or_else(|| Error::new(400, "durationMinutes is required"))?;
    let title = input["title"].as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| Error::new(400, "title is required"))?;
    let shown = json!({"created":false,"resolvedStart":iso(start),"resolvedEnd":iso(end),"shifted":false,"conflict":"none"});
    let account = match target(host)? {
        Ok(account) => account,
        Err(text) => return Ok(refusal(text, {let mut o = shown; o["calendarMirror"] = json!("skipped-error"); o})),
    };
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let clock = host.call("context", "read", "call", json!({}))?;
    let now = instant(&clock["now"]).ok_or_else(|| Error::new(500, "Clock unavailable"))?;
    if let Some(text) = crate::outlook_availability::issue(&setup, start, end, now) {
        return Ok(refusal(text, {let mut o = shown; o["calendarMirror"] = json!("skipped-error"); o}));
    }
    let (min, max) = query_window(account.timezone, start, end);
    let free = kv(
        host,
        "set",
        "connectors.write-calendar-freebusy",
        json!({"accountId":account.id,"timeMin":iso(min),"timeMax":iso(max)}),
    )?;
    if free["result"] != "ok" {
        let mut out = shown;
        out["calendarMirror"] = json!("skipped-error");
        return Ok(refusal("Couldn't check your calendar availability — try again.", out));
    }
    let mut busy: Vec<(DateTime<Utc>, DateTime<Utc>)> = free["busy"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| Some((instant(&b["start"])?, instant(&b["end"])?)))
        .filter(|(b, e)| !all_day(account.timezone, *b, *e))
        .collect();
    busy.extend(mirrored_busy(host, min, max));
    let length = Duration::minutes(minutes);
    let Some(at) = choose_slot(start, end, &busy, minutes) else {
        let mut out = shown;
        out["resolvedEnd"] = json!(iso(start + length));
        out["conflict"] = json!("no-clear-slot");
        out["calendarMirror"] = json!("skipped-error");
        return Ok(refusal("No clear slot in that window — try a different time.", out));
    };
    let (from, to) = (at, at + length);
    let event_id = block_id(&account.id, start, end, minutes, title);
    let event = json!({
        "id": event_id, "summary": title,
        "start": {"dateTime": iso(from), "timeZone": "UTC"},
        "end": {"dateTime": iso(to), "timeZone": "UTC"},
        "extendedProperties": {"private": {"jarvisCreated": "true", "jarvisTool": "createEvent"}},
    });
    let write = kv(host, "set", "connectors.write-calendar-insert", json!({"accountId":account.id,"event":event}))?;
    let mut out = json!({
        "created": false, "resolvedStart": iso(from), "resolvedEnd": iso(to),
        "shifted": at != start, "conflict": if at != start { "shifted" } else { "none" },
    });
    if write["result"] != "ok" {
        out["shifted"] = json!(false);
        out["conflict"] = json!("none");
        out["calendarMirror"] = json!("skipped-error");
        return Ok(refusal(google_failed(&write, "Couldn't create the calendar event — try again.").0, out));
    }
    let (mirror, row) = mirror(host, &account.id, &event_id, title, from, to, json!({}));
    out["googleEventId"] = json!(event_id);
    out["calendarEventId"] = row;
    out["calendarMirror"] = json!(mirror);
    if write["created"] == false {
        out["message"] = json!("This focus block is already on your calendar.");
    } else {
        out["created"] = json!(true);
    }
    Ok(out)
}

/// Outlook mirror events already in Calendar block time too. A read failure adds nothing.
fn mirrored_busy(host: &impl Host, min: DateTime<Utc>, max: DateTime<Utc>) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    let Ok(reply) = Client(host).api("calendar", "listEvents", json!({})) else {
        return vec![];
    };
    reply["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["readOnly"] == true)
        .filter_map(|e| Some((instant(&e["startsAt"])?, instant(&e["endsAt"])?)))
        .filter(|(b, e)| *b < max && *e > min)
        .collect()
}

/// Writes the event into Calendar's cache. Google already has it, so a failure here only means
/// the next sync adds it.
fn mirror(
    host: &impl Host,
    account: &str,
    external: &str,
    title: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    metadata: Value,
) -> (&'static str, Value) {
    let reply = Client(host).api(
        "calendar",
        "upsertCachedEvent",
        json!({
            "connectorAccountId": account, "externalId": external, "title": title,
            "startsAt": iso(from), "endsAt": iso(to), "externalMetadata": metadata,
        }),
    );
    match reply {
        Ok(row) => ("written", row["event"]["id"].clone()),
        Err(_) => ("skipped-error", Value::Null),
    }
}

/// A cached event by Moss id or, failing that, by its Google id on the active account.
fn find(host: &impl Host, account: &str, reference: &str) -> Option<Value> {
    if let Ok(reply) = Client(host).api("calendar", "getEvent", json!({"id":reference})) {
        return Some(reply["event"].clone()).filter(|e| e["connectorAccountId"] == account);
    }
    let reply = Client(host).api("calendar", "listEvents", json!({})).ok()?;
    reply["events"]
        .as_array()?
        .iter()
        .find(|e| e["externalId"] == reference && e["connectorAccountId"] == account)
        .cloned()
}

pub fn delete(host: &impl Host, input: &Value) -> Result<Value> {
    let skipped = |text: &str, how: &str| json!({"deleted":false,"googleDeleted":how,"cacheMirror":"not-cached","message":text});
    let Some(reference) = input["eventId"].as_str().filter(|r| !r.is_empty()) else {
        return Ok(skipped("eventId is required", "skipped-error"));
    };
    let account = match target(host)? {
        Ok(account) => account,
        Err(text) => return Ok(skipped(text, if text == NO_SCOPE { "skipped-no-scope" } else { "skipped-error" })),
    };
    let Some(event) = find(host, &account.id, reference) else {
        // An Outlook mirror event belongs to another account, so it is refused by name.
        let outlook = Client(host).api("calendar", "getEvent", json!({"id":reference})).ok().is_some_and(|r| r["event"]["readOnly"] == true);
        return Ok(skipped(if outlook { OUTLOOK } else { GONE }, "skipped-error"));
    };
    if event["readOnly"] == true {
        return Ok(skipped(OUTLOOK, "skipped-error"));
    }
    let write = kv(
        host,
        "set",
        "connectors.write-calendar-delete",
        json!({"accountId":account.id,"eventId":event["externalId"]}),
    )?;
    if write["result"] != "ok" {
        let (text, why) = google_failed(&write, "Couldn't delete the event — try again.");
        let text = if why == Some("denied") { "You don't have permission to delete events on that calendar." } else { text };
        return Ok(skipped(text, "skipped-error"));
    }
    let evicted = Client(host).api("calendar", "evictCachedEvent", json!({"id":event["id"]})).is_ok();
    Ok(json!({
        "deleted": true, "googleDeleted": write["deleted"],
        "cacheMirror": if evicted { "evicted" } else { "skipped-error" },
        "deletedTitle": event["title"],
    }))
}

pub fn reschedule(host: &impl Host, input: &Value) -> Result<Value> {
    let fail = |reason: &str, text: &str| json!({"ok":false,"reason":reason,"message":text});
    let (Some(reference), Some(start), Some(end)) =
        (input["eventRef"].as_str().filter(|r| !r.is_empty()), instant(&input["newStart"]), instant(&input["newEnd"]))
    else {
        return Ok(fail("not_found", "eventRef, newStart and newEnd are required"));
    };
    if end <= start {
        return Ok(fail("provider_error", "The new end must be after the new start."));
    }
    let account = match target(host)? {
        Ok(account) => account,
        Err(text) => return Ok(fail(if text == NO_SCOPE { "no_scope" } else { "provider_error" }, text)),
    };
    let Some(event) = find(host, &account.id, reference) else {
        let outlook = Client(host).api("calendar", "getEvent", json!({"id":reference})).ok().is_some_and(|r| r["event"]["readOnly"] == true);
        return Ok(if outlook { fail("provider_error", OUTLOOK) } else { fail("not_found", GONE) });
    };
    if event["readOnly"] == true {
        return Ok(fail("provider_error", OUTLOOK));
    }
    if event["attendeeCount"].as_u64().unwrap_or(0) > 0 {
        return Ok(fail("has_attendees", "This event has other attendees, so Moss will not move it. Change it in Google Calendar."));
    }
    let write = kv(
        host,
        "set",
        "connectors.write-calendar-patch",
        json!({
            "accountId": account.id, "eventId": event["externalId"],
            "start": {"dateTime": iso(start), "timeZone": "UTC"},
            "end": {"dateTime": iso(end), "timeZone": "UTC"},
        }),
    )?;
    match write["result"].as_str() {
        Some("ok") => {}
        Some("gone") => return Ok(fail("not_found", GONE)),
        _ => {
            let (text, why) = google_failed(&write, "Couldn't reschedule the event — try again.");
            let text = if why == Some("denied") { "You don't have permission to reschedule events on that calendar." } else { text };
            return Ok(fail("provider_error", text));
        }
    }
    let title = event["title"].as_str().unwrap_or("");
    let (_, row) = mirror(host, &account.id, event["externalId"].as_str().unwrap_or(""), title, start, end, json!({}));
    Ok(json!({"ok":true,"calendarEventId":if row.is_null() { event["id"].clone() } else { row }}))
}
