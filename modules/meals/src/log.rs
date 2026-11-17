//! The six meal-log tools and the estimate job. `list` and `summarize` only read. `add` saves
//! the entry and queues its estimate, so the call returns at once with a waiting entry.
//! `reestimate` retries a waiting or failed one, `correct` and `delete` change an entry the
//! person already has. Targets come from the self member of the kitchen and from nowhere else.
//! An entry shows its state, so an estimate is never mistaken for a measured value.
use crate::diary::{self, Entry, ItemPatch, NewEntry, Patch, Recorded, When};
use crate::estimate::{self, Outcome};
use crate::input::{invalid, no_unknown_keys, trim, Checked, Fields};
use crate::jobs::AiModel;
use crate::moments::{day_at, iso_from_ms, parse_consumed_at};
use crate::nutrients::{self, Figures};
use crate::util::{context, days_from_civil, epoch_ms, new_id};
use crate::{input, kitchen, md5};
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};

pub const LOG_ESTIMATE_QUEUE: &str = "meals-log-estimate";

const DEFAULT_LIMIT: i64 = 200;
const LIST_MAX_DAYS: i64 = 31;
const SUMMARIZE_MAX_DAYS: i64 = 92;
const NO_ENTRY: &str = "There is no log entry with that id";
const STALE: &str = "That entry changed since it was read. Read it again and retry.";
const UNREADABLE_TIME: &str = "consumedAt must be an ISO instant or local date-time; supply an explicit UTC offset for DST gaps or folds";

/// A string whose limit counts UTF-8 bytes, like the old readers.
fn bytes(input: &Fields, key: &str, required: bool, max: usize) -> Checked<Option<String>> {
    match input.get(key) {
        None | Some(Value::Null) if required => invalid(format!("{key} is required")),
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.len() > max => {
            invalid(format!("{key} exceeds {max} bytes of UTF-8"))
        }
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => invalid(format!("{key} must be a string")),
    }
}

fn whole(input: &Fields, key: &str, required: bool, min: i64, max: i64) -> Checked<Option<i64>> {
    let number = match input.get(key) {
        None | Some(Value::Null) if required => return invalid(format!("{key} is required")),
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9e15).map(|f| f as i64)),
        Some(_) => None,
    };
    let Some(n) = number else {
        return invalid(format!("{key} must be an integer"));
    };
    if n < min {
        return invalid(format!("{key} must be at least {min}"));
    }
    if n > max {
        return invalid(format!("{key} must be at most {max}"));
    }
    Ok(Some(n))
}

fn not_blank(key: &str, value: Option<String>) -> Checked<Option<String>> {
    match value {
        Some(text) if trim(&text).is_empty() => invalid(format!("{key} must not be blank")),
        other => Ok(other),
    }
}

/// An id the log could hold. Anything else names no entry.
fn entry_id(input: &Fields) -> Checked<String> {
    Ok(bytes(input, "entryId", true, usize::MAX)?.unwrap_or_default())
}

/// A YYYY-MM-DD text and its day number. A day from 1 to 31 passes, as in the old reader.
fn local_date(input: &Fields, key: &str, required: bool) -> Checked<Option<(String, i64)>> {
    let Some(value) = bytes(input, key, required, usize::MAX)? else {
        return Ok(None);
    };
    let part = |range: std::ops::Range<usize>| value.get(range).and_then(|p| p.parse::<i64>().ok());
    let shaped = value.len() == 10
        && value.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    match (shaped, part(0..4), part(5..7), part(8..10)) {
        (true, Some(y), Some(m @ 1..=12), Some(d @ 1..=31)) => {
            Ok(Some((value.clone(), days_from_civil(y, m, d))))
        }
        _ => invalid(format!("{key} must be an ISO calendar date (YYYY-MM-DD)")),
    }
}

fn span(from: i64, to: i64) -> i64 {
    to - from + 1
}

fn date_range(input: &Fields, max_days: i64) -> Checked<(String, String)> {
    let (from, from_day) = local_date(input, "fromLocalDate", true)?.unwrap_or_default();
    let (to, to_day) = local_date(input, "toLocalDate", true)?.unwrap_or_default();
    check_span(from_day, to_day, max_days)?;
    Ok((from, to))
}

fn check_span(from: i64, to: i64, max_days: i64) -> Checked<()> {
    if span(from, to) < 1 {
        return invalid("toLocalDate must not be before fromLocalDate");
    }
    if span(from, to) > max_days {
        return invalid(format!("date range must not exceed {max_days} days"));
    }
    Ok(())
}

/// The self member's daily targets. Null means no target set.
fn targets<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let view = kitchen::view(host)?;
    let me = view["members"]
        .as_array()
        .and_then(|all| all.iter().find(|m| m["isSelf"] == true))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({
        "caloriesKcal": me["calorieTarget"],
        "proteinG": me["macroTargets"]["proteinG"],
        "carbG": me["macroTargets"]["carbG"],
        "fatG": me["macroTargets"]["fatG"],
    }))
}

/// The most recent `limit` entries, with the count before the cut, so a caller can tell a
/// short list from a complete one.
fn limited(all: &[Entry], limit: usize) -> (Vec<Value>, bool, usize) {
    let kept = &all[all.len().saturating_sub(limit)..];
    (kept.iter().map(Entry::view).collect(), all.len() > limit, all.len())
}

pub fn list<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = (|| {
        no_unknown_keys(input, &["localDate", "fromLocalDate", "toLocalDate", "limit"])?;
        Ok((
            local_date(input, "localDate", false)?,
            local_date(input, "fromLocalDate", false)?,
            local_date(input, "toLocalDate", false)?,
            whole(input, "limit", false, 1, DEFAULT_LIMIT)?.unwrap_or(DEFAULT_LIMIT) as usize,
        ))
    })();
    let (day, from, to, limit) = match checked {
        Ok(parts) => parts,
        Err(error) => return Ok(Err(error)),
    };
    let targets = targets(host)?;
    if let Some((date, _)) = day {
        if from.is_some() || to.is_some() {
            return Ok(invalid("localDate cannot be combined with fromLocalDate/toLocalDate"));
        }
        let all = diary::list_day(host, &date)?;
        // Totalled over the whole day, not the cut list, because the person compares it to a target.
        let totals = diary::totals(&date, &all);
        let kcal = totals["nutrients"]["caloriesKcal"].as_f64();
        let fit = match (targets["caloriesKcal"].as_i64(), kcal) {
            (Some(target), Some(kcal)) => diary::calorie_fit(target, kcal),
            _ => Value::Null,
        };
        let (entries, truncated, total) = limited(&all, limit);
        return Ok(Ok(json!({
            "entries": entries, "totals": totals, "targets": targets, "calorieFit": fit,
            "truncated": truncated, "totalCount": total,
        })));
    }
    let (Some((from, from_day)), Some((to, to_day))) = (from, to) else {
        return Ok(invalid("either localDate or both fromLocalDate and toLocalDate are required"));
    };
    if let Err(error) = check_span(from_day, to_day, LIST_MAX_DAYS) {
        return Ok(Err(error));
    }
    let all = diary::list_range(host, &from, &to)?;
    let (entries, truncated, total) = limited(&all, limit);
    Ok(Ok(json!({
        "entries": entries, "totals": null, "targets": targets, "calorieFit": null,
        "truncated": truncated, "totalCount": total,
    })))
}

pub fn summarize<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = no_unknown_keys(input, &["fromLocalDate", "toLocalDate"])
        .and_then(|()| date_range(input, SUMMARIZE_MAX_DAYS));
    let (from, to) = match checked {
        Ok(range) => range,
        Err(error) => return Ok(Err(error)),
    };
    let all = diary::list_range(host, &from, &to)?;
    let totals = diary::totals(&from, &all);
    let days: std::collections::BTreeSet<&str> = all.iter().map(|e| e.local_date.as_str()).collect();
    Ok(Ok(json!({
        "fromLocalDate": from, "toLocalDate": to,
        "nutrients": totals["nutrients"], "incomplete": totals["incomplete"],
        "entriesWithoutEstimate": totals["entriesWithoutEstimate"],
        "daysWithEntries": days.len(),
    })))
}

const MEAL_TIMES: [(&str, &str); 4] = [
    ("breakfast", "08:00:00"),
    ("lunch", "12:30:00"),
    ("dinner", "18:30:00"),
    ("snack", "15:00:00"),
];

fn now_ms<H: Host + ?Sized>(host: &H) -> Result<i64> {
    epoch_ms(&context(host)?.1).ok_or_else(|| Error::new("Host clock unavailable"))
}

/// Queues the estimate for an entry. A queue that is busy or down marks the entry failed, so
/// Retry picks it up instead of leaving it waiting with no job behind it.
fn queue_estimate<H: Host + ?Sized>(host: &H, entry: Entry) -> Result<Entry> {
    // The stamp changes when a failed entry goes back to waiting, so a retry never reuses the
    // key of the attempt before it.
    let key = md5::uuid_of(&format!(
        "meals.log-estimate:{}:r{}:{}",
        entry.entry_id, entry.revision, entry.stamp
    ));
    let queued = host.call(
        "jobs",
        "enqueue-options",
        LOG_ESTIMATE_QUEUE,
        json!({
            "params": {"entry-id": entry.entry_id, "revision": entry.revision},
            "idempotencyKey": key,
            "availableAt": context(host)?.1,
        }),
    );
    if queued.is_ok() {
        return Ok(entry);
    }
    Ok(diary::record(host, &entry.entry_id, entry.revision, &diary::failed())?.unwrap_or(entry))
}

pub fn add<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = (|| {
        no_unknown_keys(
            input,
            &["description", "consumedAt", "timeZone", "captureKind", "servingNote", "mealType", "idempotencyKey"],
        )?;
        let description = not_blank("description", bytes(input, "description", true, 2000)?)?;
        let key = bytes(input, "idempotencyKey", true, usize::MAX)?;
        let at = bytes(input, "consumedAt", false, usize::MAX)?;
        // The person's own zone comes from the host, so a zone in the input is checked and ignored.
        bytes(input, "timeZone", false, usize::MAX)?;
        let kind = input::choice(input, "captureKind", &["text", "photo", "voice"])?;
        let note = not_blank("servingNote", bytes(input, "servingNote", false, 500)?)?;
        let meal = input::choice(input, "mealType", &["breakfast", "lunch", "dinner", "snack"])?;
        Ok((description.unwrap_or_default(), key.unwrap_or_default(), at, kind, note, meal))
    })();
    let (description, key, at, kind, note, meal) = match checked {
        Ok(parts) => parts,
        Err(error) => return Ok(Err(error)),
    };
    let now = now_ms(host)?;
    let consumed = match (at, meal) {
        (Some(raw), _) => parse_consumed_at(host, &raw)?,
        (None, Some(meal)) => {
            let today = day_at(host, now)?.date;
            let time = MEAL_TIMES.iter().find(|m| m.0 == meal).map_or("12:00:00", |m| m.1);
            parse_consumed_at(host, &format!("{today}T{time}"))?
        }
        (None, None) => Ok(now),
    };
    let Ok(consumed) = consumed else {
        return Ok(invalid(UNREADABLE_TIME));
    };
    let day = day_at(host, consumed)?;
    let (entry, created) = diary::create(
        host,
        &NewEntry {
            entry_id: new_id(host)?,
            consumed_at: iso_from_ms(consumed),
            local_date: day.date,
            offset_minutes: day.offset_minutes,
            description,
            serving_note: note,
            capture_kind: kind.unwrap_or_else(|| "text".into()),
            idempotency_key: key,
        },
    )?;
    // A retry returns the existing entry and queues nothing, so one entry never gets two
    // estimates. The entry is already saved, so a queue failure must not fail the call, or the
    // caller would log the same meal twice.
    let entry = if created { queue_estimate(host, entry)? } else { entry };
    Ok(Ok(json!({"entry": entry.view()})))
}

fn find<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Entry>> {
    if input::is_uuid(id) { diary::get(host, id) } else { Ok(None) }
}

pub fn reestimate<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = no_unknown_keys(input, &["entryId"]).and_then(|()| entry_id(input));
    let id = match checked {
        Ok(id) => id,
        Err(error) => return Ok(Err(error)),
    };
    let Some(entry) = find(host, &id)? else {
        return Ok(invalid(NO_ENTRY));
    };
    // An estimated entry is the person's to correct. A silent re-roll would discard a number they accepted.
    if entry.state != "pending" && entry.state != "failed" {
        return Ok(Ok(json!({"entry": entry.view()})));
    }
    let ready = if entry.state == "failed" {
        diary::mark_pending(host, &id, entry.revision)?
    } else {
        Some(entry)
    };
    let Some(ready) = ready else {
        return Ok(invalid(STALE));
    };
    Ok(Ok(json!({"entry": queue_estimate(host, ready)?.view()})))
}

fn nutrient_patch(raw: &Value, path: &str) -> Checked<Figures> {
    let Some(map) = raw.as_object() else {
        return invalid(format!("{path} must be an object"));
    };
    if let Some(key) = map.keys().find(|k| !nutrients::KEYS.contains(&k.as_str())) {
        return invalid(format!("unknown key: {path}.{key}"));
    }
    let mut out = nutrients::UNKNOWN;
    for (slot, key) in out.iter_mut().zip(nutrients::KEYS) {
        match map.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.is_finite() && f >= 0.0) => {
                *slot = n.as_f64();
            }
            Some(_) => return invalid(format!("{key} must be a non-negative finite number or null")),
        }
    }
    Ok(out)
}

/// Item i of the list corrects item i of the entry. A null leaves that item alone.
fn item_patches(raw: &Value) -> Checked<Vec<ItemPatch>> {
    let Some(list) = raw.as_array() else {
        return invalid("items must be an array");
    };
    let mut out = vec![];
    for (index, entry) in list.iter().enumerate() {
        let none = ItemPatch { label: None, portion_note: None, figures: nutrients::UNKNOWN };
        if entry.is_null() {
            out.push(none);
            continue;
        }
        let Some(map) = entry.as_object() else {
            return invalid(format!("items[{index}] must be an object or null"));
        };
        if let Some(key) = map.keys().find(|k| !["label", "portionNote", "nutrients"].contains(&k.as_str())) {
            return invalid(format!("unknown key: items[{index}].{key}"));
        }
        let label = bytes(map, "label", false, 200)?;
        if label.as_deref().is_some_and(|l| trim(l).is_empty()) {
            return invalid(format!("items[{index}].label must not be blank"));
        }
        let portion_note = match map.get("portionNote") {
            Some(Value::Null) => Some(None),
            _ => not_blank("portionNote", bytes(map, "portionNote", false, 100)?)?.map(Some),
        };
        let figures = match map.get("nutrients") {
            None => nutrients::UNKNOWN,
            Some(raw) => nutrient_patch(raw, &format!("items[{index}].nutrients"))?,
        };
        out.push(ItemPatch { label, portion_note, figures });
    }
    Ok(out)
}

pub fn correct<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = (|| {
        no_unknown_keys(
            input,
            &["entryId", "expectedRevision", "description", "servingNote", "consumedAt", "timeZone", "items"],
        )?;
        let id = entry_id(input)?;
        let revision = whole(input, "expectedRevision", true, 1, i64::MAX)?.unwrap_or(1);
        let description = not_blank("description", bytes(input, "description", false, 2000)?)?;
        let note = match input.get("servingNote") {
            Some(Value::Null) => Some(None),
            _ => not_blank("servingNote", bytes(input, "servingNote", false, 500)?)?.map(Some),
        };
        let at = bytes(input, "consumedAt", false, usize::MAX)?;
        let items = input.get("items").map(item_patches).transpose()?;
        Ok((id, revision, description, note, at, items))
    })();
    let (id, revision, description, serving_note, at, items) = match checked {
        Ok(parts) => parts,
        Err(error) => return Ok(Err(error)),
    };
    let when = match at {
        None => None,
        Some(raw) => {
            let Ok(ms) = parse_consumed_at(host, &raw)? else {
                return Ok(invalid(UNREADABLE_TIME));
            };
            let day = day_at(host, ms)?;
            Some(When { consumed_at: iso_from_ms(ms), local_date: day.date, offset_minutes: day.offset_minutes })
        }
    };
    if !input::is_uuid(&id) {
        return Ok(invalid(STALE));
    }
    let patch = Patch { description, serving_note, when, items };
    let entry = match diary::correct(host, &id, revision, &patch)? {
        Ok(Some(entry)) => entry,
        Ok(None) => return Ok(invalid(STALE)),
        Err(error) => return Ok(Err(error)),
    };
    // A correction moves the revision, which makes the queued estimate stale. An entry still
    // waiting for its estimate needs a new job at the new revision or it would wait forever.
    let entry = if entry.state == "pending" { queue_estimate(host, entry)? } else { entry };
    Ok(Ok(json!({"entry": entry.view()})))
}

pub fn delete<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let checked = no_unknown_keys(input, &["entryId"]).and_then(|()| entry_id(input));
    let id = match checked {
        Ok(id) => id,
        Err(error) => return Ok(Err(error)),
    };
    if !input::is_uuid(&id) || !diary::delete(host, &id)? {
        return Ok(invalid(NO_ENTRY));
    }
    Ok(Ok(json!({"entryId": id, "deleted": true})))
}

#[derive(Debug, PartialEq)]
pub enum EstimateJob {
    Missing,
    Stale,
    NotWaiting,
    Recorded,
}

/// Runs one estimate job. Every ordinary non-event (entry gone, revision moved on) is an
/// outcome and not an error, because the entry is saved before the job is queued.
pub fn run_estimate<H: Host + ?Sized>(host: &H, params: &Value) -> Result<EstimateJob> {
    let (Some(id), Some(revision)) = (
        params["entry-id"].as_str().filter(|s| !s.is_empty()),
        params["revision"].as_i64().filter(|r| *r >= 1),
    ) else {
        return Err(Error::new("Invalid log-estimate job"));
    };
    let Some(entry) = find(host, id)? else {
        return Ok(EstimateJob::Missing);
    };
    // A correction landed after this job was queued. Estimating the old text would overwrite it.
    if entry.revision != revision {
        return Ok(EstimateJob::Stale);
    }
    if entry.state != "pending" {
        return Ok(EstimateJob::NotWaiting);
    }
    let recorded = match estimate::estimate(&mut AiModel(host), &entry.description, entry.serving_note.as_deref()) {
        Outcome::Estimated { items, totals } => Recorded {
            state: "estimated", items, figures: Some(totals), missing: None, question: None,
        },
        Outcome::NeedsDetails { missing, question } => Recorded {
            state: "needs_details", items: vec![], figures: None, missing: Some(missing), question: Some(question),
        },
        Outcome::Failed => diary::failed(),
    };
    Ok(match diary::record(host, id, revision, &recorded)? {
        Some(_) => EstimateJob::Recorded,
        None => EstimateJob::Stale,
    })
}
