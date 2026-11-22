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
    tagged_id("jfb", &canonical)
}

/// The operation identity one reserved day-plan addition carries onto the provider, matching
/// the TypeScript apply (applyAdditionEventId): the same operation always makes the same id,
/// so a retried insert collides instead of duplicating.
fn apply_id(provenance: &Provenance) -> String {
    let canonical = format!(
        "{}|{}|{}|{}|{}",
        provenance.actor_user_id, provenance.plan_id, provenance.block_id,
        provenance.plan_revision, provenance.operation_id
    );
    tagged_id("jap", &canonical)
}

/// `jfb`/`jap` ids: the base32-shaped sha256 tail both writers share.
fn tagged_id(prefix: &str, canonical: &str) -> String {
    let alphabet = b"0123456789abcdefghijklmnopqrstuv";
    let tail: String = Sha256::digest(canonical.as_bytes()).iter().map(|b| alphabet[(b & 0x1f) as usize] as char).collect();
    format!("{prefix}{tail}")
}

/// One reserved day-plan addition, as the TypeScript apply records it onto the provider event.
struct Provenance {
    actor_user_id: String,
    plan_id: String,
    block_id: String,
    plan_revision: i64,
    operation_id: String,
}

impl Provenance {
    /// The private properties the provider event carries, exactly as the TypeScript apply
    /// writes them (applyProvenanceProperties), so a readback can prove ownership.
    fn properties(&self) -> Value {
        json!({
            "jarvisCreated": "true", "jarvisTool": "applyAddition",
            "jarvisActorUserId": self.actor_user_id, "jarvisPlanId": self.plan_id,
            "jarvisBlockId": self.block_id, "jarvisPlanRevision": self.plan_revision.to_string(),
            "jarvisOperationId": self.operation_id,
        })
    }

    /// The cache-mirror metadata, so Calendar's row agrees with the provider tag.
    fn mirror_metadata(&self) -> Value {
        json!({
            "attendeeCount": 0, "source": "applyAddition",
            "provenance": {
                "actorUserId": self.actor_user_id, "planId": self.plan_id, "blockId": self.block_id,
                "planRevision": self.plan_revision, "operationId": self.operation_id,
            },
        })
    }
}

/// The provenance of a reserved addition, or None when the call is an ordinary focus block.
/// A present but unusable provenance is refused rather than silently downgraded: the apply
/// caller must never get an untagged event back.
fn provenance_of(input: &Value) -> Result<Option<Provenance>> {
    let Some(given) = input.get("provenance").filter(|p| !p.is_null()) else {
        return Ok(None);
    };
    let text = |key: &str| {
        given[key]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from)
    };
    let revision = given["planRevision"].as_i64().filter(|r| *r >= 0);
    let (Some(actor), Some(plan), Some(block), Some(revision), Some(operation)) = (
        text("actorUserId"),
        text("planId"),
        text("blockId"),
        revision,
        text("operationId"),
    ) else {
        return Err(Error::new(
            400,
            "provenance requires actorUserId, planId, blockId, planRevision and operationId",
        ));
    };
    Ok(Some(Provenance {
        actor_user_id: actor,
        plan_id: plan,
        block_id: block,
        plan_revision: revision,
        operation_id: operation,
    }))
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
    let provenance = provenance_of(input)?;
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
        // The TypeScript apply refuses a filled window with its own words.
        let text = if provenance.is_some() {
            "That time just filled on your calendar — the addition was not created."
        } else {
            "No clear slot in that window — try a different time."
        };
        return Ok(refusal(text, out));
    };
    let (from, to) = (at, at + length);
    // A reserved addition carries its operation identity; an ordinary focus block keeps the
    // request-derived id. Both are deterministic, so a repeat is refused by Google instead of
    // creating a second event.
    let (event_id, private, mirror_metadata) = match &provenance {
        Some(p) => (apply_id(p), p.properties(), p.mirror_metadata()),
        None => (
            block_id(&account.id, start, end, minutes, title),
            json!({"jarvisCreated": "true", "jarvisTool": "createEvent"}),
            json!({}),
        ),
    };
    let event = json!({
        "id": event_id, "summary": title,
        "start": {"dateTime": iso(from), "timeZone": "UTC"},
        "end": {"dateTime": iso(to), "timeZone": "UTC"},
        "extendedProperties": {"private": private},
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
    if write["created"] == false && provenance.is_some() {
        // This exact reservation is already on the calendar: idempotent success with the known
        // id, exactly as the TypeScript apply answers a 409. The cache is only read, never
        // written here, so the mirror state stays honest.
        out["created"] = json!(true);
        out["googleEventId"] = json!(event_id);
        match find(host, &account.id, &event_id) {
            Some(row) => {
                out["calendarEventId"] = row["id"].clone();
                out["calendarMirror"] = json!("written");
            }
            None => out["calendarMirror"] = json!("not-cached"),
        }
        return Ok(refusal("This addition is already on your calendar.", out));
    }
    // Only a newly created attendee-free request establishes zero; an existing event stays unknown.
    let metadata = if write["created"] == true {
        if provenance.is_some() { mirror_metadata } else { json!({"attendeeCount":0}) }
    } else {
        json!({})
    };
    let (mirror, row) = mirror(host, &account.id, &event_id, title, from, to, metadata);
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
    let Some(attendee_count) = event["attendeeCount"].as_u64() else {
        return Ok(fail("provider_error", "Couldn't verify this event's guest count. Change it in Google Calendar."));
    };
    if attendee_count > 0 {
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
    let (_, row) = mirror(host, &account.id, event["externalId"].as_str().unwrap_or(""), title, start, end, json!({"attendeeCount":attendee_count}));
    Ok(json!({"ok":true,"calendarEventId":if row.is_null() { event["id"].clone() } else { row },
        "changed":[
            {"label":"Event start","before":event["startsAt"].as_str().unwrap_or(""),"after":iso(start)},
            {"label":"Event end","before":event["endsAt"].as_str().unwrap_or(""),"after":iso(end)}
        ]}))
}

/// Reads one provider event by id on the signed-in person's active Google account, exactly as
/// the TypeScript apply does (lookupEvent): a clean miss answers `found:false`, a cancelled
/// event reads as gone, and every other failure is an error so the caller records an unknown
/// outcome instead of trusting absence. The answer carries the private provenance our own
/// writes recorded and the attendee count the move and removal path refuses guests by.
pub fn lookup(host: &impl Host, input: &Value) -> Result<Value> {
    let Some(event_id) = input["eventId"].as_str().map(str::trim).filter(|id| !id.is_empty()) else {
        return Err(Error::new(400, "eventId is required"));
    };
    let account = target(host)?.map_err(|text| Error::new(409, text))?;
    let read = kv(
        host,
        "get",
        "connectors.live-calendar-get",
        json!({"accountId": account.id, "eventId": event_id}),
    )?;
    match read["result"].as_str() {
        Some("ok") => {}
        // A sign-in problem or an unreachable provider is an error, never a miss: the caller
        // must not mistake a failed read for a proven absence.
        Some("inactive") | Some("auth_failed") => return Err(Error::new(409, "Connect Google in Settings first.")),
        _ => return Err(Error::new(502, "Google could not be reached. Try again shortly.")),
    }
    let event = &read["event"];
    if event.is_null() || event["status"] == "cancelled" {
        return Ok(json!({"found": false}));
    }
    Ok(json!({
        "found": true,
        "id": event["id"],
        "summary": event["summary"],
        "start": event["start"],
        "end": event["end"],
        "provenance": event["provenance"],
        "attendeeCount": event["attendeeCount"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct EventHost {
        event: Value,
        effects: RefCell<Vec<(String, Value)>>,
    }
    impl Host for EventHost {
        fn call(&self, port: &str, operation: &str, resource: &str, params: Value) -> moss_module_sdk::Result<Value> {
            Ok(match (port, operation, resource) {
                ("kv", "get", "connectors.context-setup") => json!({
                    "accounts":[{"id":"g1","providerId":"google","status":"active","scopes":["calendar"]}],
                    "grants":{"g1":{"calendar":true}},"timezone":"UTC"
                }),
                ("api", "call", "calendar") if params["name"] == "getEvent" => json!({"event":self.event}),
                ("kv", "set", "connectors.write-calendar-patch") => {
                    self.effects.borrow_mut().push((resource.into(), params));
                    json!({"result":"ok"})
                }
                ("api", "call", "calendar") if params["name"] == "upsertCachedEvent" => {
                    self.effects.borrow_mut().push(("mirror".into(), params));
                    json!({"event":{"id":"cached"}})
                }
                _ => panic!("Unexpected call {port}.{operation}.{resource}: {params}"),
            })
        }
    }
    fn host(count: Option<Value>) -> EventHost {
        let mut event = json!({"id":"cached","connectorAccountId":"g1","externalId":"provider-id",
            "title":"Saved title","startsAt":"2026-11-20T10:00:00.000Z","endsAt":"2026-11-20T11:00:00.000Z"});
        if let Some(count) = count { event["attendeeCount"] = count; }
        EventHost { event, effects: RefCell::default() }
    }
    fn input() -> Value {
        json!({"eventRef":"cached","newStart":"2026-11-21T10:00:00Z","newEnd":"2026-11-21T11:00:00Z"})
    }

    #[test]
    fn reschedule_refuses_unverified_attendee_counts() {
        // Float zero reproduces Calendar's old serializer and the old default-to-zero bypass.
        for count in [Some(json!(0.0)), Some(json!(1.0)), None, Some(Value::Null), Some(json!(-1)),
            Some(json!("0")), Some(json!(false)), Some(json!({})), Some(json!([]))] {
            let h = host(count.clone());
            let reply = reschedule(&h, &input()).unwrap();
            assert_eq!(reply["ok"], false, "Unverified count {count:?} was accepted: {reply}");
            assert_eq!(reply["reason"], "provider_error");
            assert!(h.effects.borrow().is_empty(), "Unverified count caused a provider or cache write");
        }
    }

    #[test]
    fn reschedule_refuses_events_with_guests() {
        for count in [1, 3] {
            let h = host(Some(json!(count)));
            let reply = reschedule(&h, &input()).unwrap();
            assert_eq!(reply["reason"], "has_attendees");
            assert!(h.effects.borrow().is_empty());
        }
    }

    #[test]
    fn reschedule_zero_guests_returns_saved_before_and_after() {
        let h = host(Some(json!(0)));
        let reply = reschedule(&h, &input()).unwrap();
        assert_eq!(reply, json!({"ok":true,"calendarEventId":"cached","changed":[
            {"label":"Event start","before":"2026-11-20T10:00:00.000Z","after":"2026-11-21T10:00:00.000Z"},
            {"label":"Event end","before":"2026-11-20T11:00:00.000Z","after":"2026-11-21T11:00:00.000Z"}
        ]}));
        let effects = h.effects.borrow();
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[0], ("connectors.write-calendar-patch".into(), json!({
            "accountId":"g1","eventId":"provider-id",
            "start":{"dateTime":"2026-11-21T10:00:00.000Z","timeZone":"UTC"},
            "end":{"dateTime":"2026-11-21T11:00:00.000Z","timeZone":"UTC"}
        })));
        assert_eq!(effects[1].0, "mirror");
        assert_eq!(effects[1].1["parameters"]["externalMetadata"]["attendeeCount"].as_u64(), Some(0));
    }

    /// Everything the apply create and lookup paths say to the host, in order, with scripted
    /// answers and a cache the tests fill.
    struct ApplyHost {
        insert_created: bool,
        busy: Value,
        cached: Option<Value>,
        provider: Value,
        failing_provider: bool,
        effects: RefCell<Vec<(String, Value)>>,
    }
    impl Default for ApplyHost {
        fn default() -> Self {
            Self {
                insert_created: true,
                busy: json!([]),
                cached: None,
                provider: Value::Null,
                failing_provider: false,
                effects: RefCell::default(),
            }
        }
    }
    impl Host for ApplyHost {
        fn call(&self, port: &str, operation: &str, resource: &str, params: Value) -> moss_module_sdk::Result<Value> {
            self.effects.borrow_mut().push((resource.into(), params.clone()));
            Ok(match (port, operation, resource) {
                ("context", "read", "call") => json!({"now":"2026-11-20T08:00:00.000Z"}),
                ("kv", "get", "connectors.context-setup") => json!({
                    "accounts":[{"id":"g1","providerId":"google","status":"active","scopes":["calendar"]}],
                    "grants":{"g1":{"calendar":true}},"timezone":"UTC"
                }),
                ("kv", "set", "connectors.write-calendar-freebusy") => json!({"result":"ok","busy":self.busy}),
                ("kv", "set", "connectors.write-calendar-insert") if self.insert_created => json!({"result":"ok","created":true}),
                ("kv", "set", "connectors.write-calendar-insert") => json!({"result":"ok","created":false}),
                ("api", "call", "calendar") if params["name"] == "listEvents" => json!({"events":[]}),
                ("api", "call", "calendar") if params["name"] == "getEvent" => {
                    self.cached.clone().map(|row| json!({"event":row})).unwrap_or(json!({}))
                }
                ("api", "call", "calendar") if params["name"] == "upsertCachedEvent" => json!({"event":{"id":"cal-1"}}),
                ("kv", "get", "connectors.live-calendar-get") => {
                    if self.failing_provider {
                        json!({"result":"failed","error":{"status":500}})
                    } else {
                        json!({"result":"ok","event":self.provider})
                    }
                }
                _ => panic!("Unexpected call {port}.{operation}.{resource}: {params}"),
            })
        }
    }

    fn provenance_input() -> Value {
        json!({
            "windowStart":"2026-11-21T09:00:00Z","windowEnd":"2026-11-21T10:00:00Z",
            "durationMinutes":60,"title":"Write the chapter",
            "provenance":{"actorUserId":"actor-1","planId":"plan-1","blockId":"block-1",
                "planRevision":2,"operationId":"op-1"},
        })
    }

    fn inserted_event(host: &ApplyHost) -> Value {
        host.effects
            .borrow()
            .iter()
            .find(|(r, _)| r == "connectors.write-calendar-insert")
            .expect("an insert was made")
            .1["event"]
            .clone()
    }

    #[test]
    fn apply_ids_match_the_typescript_shape_and_separate_every_reference() {
        let base = apply_id(&Provenance {
            actor_user_id: "actor-1".into(),
            plan_id: "plan-1".into(),
            block_id: "block-1".into(),
            plan_revision: 2,
            operation_id: "op-1".into(),
        });
        let same = apply_id(&Provenance {
            actor_user_id: "actor-1".into(),
            plan_id: "plan-1".into(),
            block_id: "block-1".into(),
            plan_revision: 2,
            operation_id: "op-1".into(),
        });
        assert_eq!(base, same);
        assert!(base.starts_with("jap") && base.len() == 35, "jap plus 32 tail chars: {base}");
        assert!(base[3..].chars().all(|c| "0123456789abcdefghijklmnopqrstuv".contains(c)));
        let changed = |p: Provenance| apply_id(&p) != base;
        assert!(changed(Provenance { actor_user_id: "actor-2".into(), plan_id: "plan-1".into(), block_id: "block-1".into(), plan_revision: 2, operation_id: "op-1".into() }));
        assert!(changed(Provenance { actor_user_id: "actor-1".into(), plan_id: "plan-9".into(), block_id: "block-1".into(), plan_revision: 2, operation_id: "op-1".into() }));
        assert!(changed(Provenance { actor_user_id: "actor-1".into(), plan_id: "plan-1".into(), block_id: "block-2".into(), plan_revision: 2, operation_id: "op-1".into() }));
        assert!(changed(Provenance { actor_user_id: "actor-1".into(), plan_id: "plan-1".into(), block_id: "block-1".into(), plan_revision: 3, operation_id: "op-1".into() }));
        assert!(changed(Provenance { actor_user_id: "actor-1".into(), plan_id: "plan-1".into(), block_id: "block-1".into(), plan_revision: 2, operation_id: "op-2".into() }));
    }

    #[test]
    fn a_provenance_create_writes_the_operation_identity() {
        let h = ApplyHost::default();
        let reply = create(&h, &provenance_input()).unwrap();
        assert_eq!(reply["created"], true, "{reply}");
        assert_eq!(reply["conflict"], "none");
        assert_eq!(reply["shifted"], false);
        let id = reply["googleEventId"].as_str().unwrap();
        assert!(id.starts_with("jap"), "{reply}");
        let event = inserted_event(&h);
        assert_eq!(event["id"], json!(id));
        assert_eq!(event["extendedProperties"]["private"], json!({
            "jarvisCreated":"true","jarvisTool":"applyAddition",
            "jarvisActorUserId":"actor-1","jarvisPlanId":"plan-1","jarvisBlockId":"block-1",
            "jarvisPlanRevision":"2","jarvisOperationId":"op-1",
        }));
        let mirror = h
            .effects
            .borrow()
            .iter()
            .find(|(_, p)| p["name"] == "upsertCachedEvent")
            .map(|(_, p)| p["parameters"].clone())
            .expect("a mirror was written");
        assert_eq!(mirror["externalMetadata"], json!({
            "attendeeCount":0,"source":"applyAddition",
            "provenance":{"actorUserId":"actor-1","planId":"plan-1","blockId":"block-1",
                "planRevision":2,"operationId":"op-1"},
        }));
    }

    #[test]
    fn a_retried_provenance_insert_is_an_idempotent_success() {
        // The same operation id collides at Google: created:false with the id already taken.
        let mut h = ApplyHost::default();
        h.insert_created = false;
        let reply = create(&h, &provenance_input()).unwrap();
        assert_eq!(reply["created"], true, "a retried insert is not a failure: {reply}");
        assert_eq!(reply["conflict"], "none");
        assert!(reply["googleEventId"].as_str().unwrap().starts_with("jap"));
        assert_eq!(reply["calendarMirror"], "not-cached");
        assert_eq!(reply["message"], "This addition is already on your calendar.");
        assert!(
            !h.effects.borrow().iter().any(|(_, p)| p["name"] == "upsertCachedEvent"),
            "the retry only reads the cache, it never mirrors"
        );
        // With the event already cached, the same retry reports the cached row.
        let mut h = ApplyHost::default();
        h.insert_created = false;
        h.cached = Some(json!({"id":"cal-9","connectorAccountId":"g1","externalId":"anything"}));
        let reply = create(&h, &provenance_input()).unwrap();
        assert_eq!(reply["created"], true);
        assert_eq!(reply["calendarMirror"], "written");
        assert_eq!(reply["calendarEventId"], "cal-9");
        assert_eq!(reply["message"], "This addition is already on your calendar.");
    }

    #[test]
    fn a_provenance_create_refuses_a_filled_window_with_the_apply_words() {
        let mut h = ApplyHost::default();
        h.busy = json!([{"start":"2026-11-21T09:00:00.000Z","end":"2026-11-21T10:00:00.000Z"}]);
        let reply = create(&h, &provenance_input()).unwrap();
        assert_eq!(reply["created"], false, "{reply}");
        assert_eq!(reply["conflict"], "no-clear-slot");
        assert_eq!(
            reply["message"], "That time just filled on your calendar — the addition was not created."
        );
        assert!(!h.effects.borrow().iter().any(|(r, _)| r == "connectors.write-calendar-insert"));
    }

    #[test]
    fn an_unusable_provenance_is_refused_before_any_call() {
        for broken in [
            json!({"actorUserId":"","planId":"plan-1","blockId":"block-1","planRevision":2,"operationId":"op-1"}),
            json!({"planId":"plan-1","blockId":"block-1","planRevision":2,"operationId":"op-1"}),
            json!({"actorUserId":"actor-1","planId":"plan-1","blockId":"block-1","planRevision":-2,"operationId":"op-1"}),
            json!({"actorUserId":"actor-1","planId":"plan-1","blockId":"block-1","operationId":"op-1"}),
            json!({"actorUserId":"actor-1","planId":"plan-1","blockId":"block-1","planRevision":"2","operationId":"op-1"}),
            json!("not an object"),
        ] {
            let mut input = provenance_input();
            input["provenance"] = broken.clone();
            let h = ApplyHost::default();
            let reply = create(&h, &input);
            assert!(reply.is_err(), "broken provenance {broken:?} was accepted");
            assert!(h.effects.borrow().is_empty(), "a broken provenance still called the host");
        }
    }

    #[test]
    fn an_ordinary_create_keeps_today_s_behaviour() {
        let mut input = provenance_input();
        input.as_object_mut().unwrap().remove("provenance");
        let h = ApplyHost::default();
        let reply = create(&h, &input).unwrap();
        assert_eq!(reply["created"], true, "{reply}");
        let event = inserted_event(&h);
        assert!(event["id"].as_str().unwrap().starts_with("jfb"));
        assert_eq!(event["extendedProperties"]["private"], json!({"jarvisCreated":"true","jarvisTool":"createEvent"}));
        // A collided ordinary block keeps today's answer: not created, still mirrored.
        let mut h = ApplyHost::default();
        h.insert_created = false;
        let reply = create(&h, &input).unwrap();
        assert_eq!(reply["created"], false, "{reply}");
        assert_eq!(reply["message"], "This focus block is already on your calendar.");
        assert_eq!(reply["calendarMirror"], "written");
    }

    #[test]
    fn lookup_answers_with_the_provider_event_and_its_provenance() {
        let mut h = ApplyHost::default();
        h.provider = json!({
            "id":"jap00000000000000000000000000000000","status":"confirmed","summary":"Write the chapter",
            "start":"2026-11-21T09:00:00.000Z","end":"2026-11-21T10:00:00.000Z",
            "attendeeCount":0,
            "provenance":{"jarvisTool":"applyAddition","jarvisActorUserId":"actor-1",
                "jarvisPlanId":"plan-1","jarvisBlockId":"block-1","jarvisPlanRevision":"2",
                "jarvisOperationId":"op-1"},
        });
        let reply = lookup(&h, &json!({"eventId":"jap00000000000000000000000000000000"})).unwrap();
        assert_eq!(reply, json!({
            "found":true,"id":"jap00000000000000000000000000000000","summary":"Write the chapter",
            "start":"2026-11-21T09:00:00.000Z","end":"2026-11-21T10:00:00.000Z",
            "provenance":{"jarvisTool":"applyAddition","jarvisActorUserId":"actor-1",
                "jarvisPlanId":"plan-1","jarvisBlockId":"block-1","jarvisPlanRevision":"2",
                "jarvisOperationId":"op-1"},
            "attendeeCount":0,
        }));
    }

    #[test]
    fn lookup_reads_a_miss_and_a_cancelled_event_as_not_found() {
        let mut h = ApplyHost::default();
        let reply = lookup(&h, &json!({"eventId":"jap-whatever"})).unwrap();
        assert_eq!(reply, json!({"found":false}));
        h.provider = json!({"id":"jap-x","status":"cancelled","summary":"Gone"});
        let reply = lookup(&h, &json!({"eventId":"jap-x"})).unwrap();
        assert_eq!(reply, json!({"found":false}));
    }

    #[test]
    fn lookup_never_mistakes_a_failed_read_for_absence() {
        let mut h = ApplyHost::default();
        h.failing_provider = true;
        let reply = lookup(&h, &json!({"eventId":"jap-x"}));
        assert!(reply.is_err(), "a failed provider read must surface as an error");
        assert!(reply.unwrap_err().message.contains("Google could not be reached"));
        // A missing id is the only bad input that stays a plain 400.
        assert!(lookup(&ApplyHost::default(), &json!({"eventId":" "})).is_err());
    }

    #[test]
    fn a_provenance_create_and_lookup_use_the_active_account_only() {
        let h = ApplyHost::default();
        create(&h, &provenance_input()).unwrap();
        let lookup_host = ApplyHost::default();
        lookup(&lookup_host, &json!({"eventId":"jap-x"})).unwrap();
        for host in [&h, &lookup_host] {
            for (resource, params) in host.effects.borrow().iter() {
                if resource.starts_with("connectors.write-") || resource == "connectors.live-calendar-get" {
                    assert_eq!(params["accountId"], "g1", "the account always comes from the caller's own setup");
                }
            }
        }
    }
}
