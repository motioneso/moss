//! Unattended day-plan step for a scheduled briefing run. Plans the run's follow-through
//! blocks, links ones a legacy event already covers, and freezes only the new automatic
//! additions as one batch. Execution is the apply job and is not here.
use crate::{apply, events, plans, Error, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::Host;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub run_id: String,
    pub definition_id: String,
    pub local_day: String,
    pub time_zone: String,
    #[serde(default)]
    pub signals: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Unfinished {
    pub plan_id: String,
    pub batch_key: String,
}

/// One scheduled run owns one batch. A duplicate fire resumes it instead of making another.
pub fn batch_key(run_id: &str) -> String {
    format!("day-plan-auto:{run_id}")
}

/// Stable block id for one automatic effect, so a duplicate fire converges on the same row.
pub fn block_id(definition_id: &str, local_day: &str, target_ref: &str) -> String {
    let hex: String = Sha256::digest(format!("{definition_id}|{local_day}|{target_ref}"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!(
        "{}-{}-4{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

struct Planned {
    id: String,
    title: Value,
    task_id: Value,
    starts_at: String,
    minutes: i64,
    target_ref: Option<String>,
}

fn instant(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
fn iso(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Window for a suggestion. Prep takes the hour before the meeting; other signals take the
/// meeting window, capped to 15..120 minutes.
fn suggest_window(signal: &Value) -> Option<(String, i64)> {
    let start = instant(&signal["startsAt"])?;
    if signal["type"] == "prep_needed" {
        return Some((iso(start - chrono::Duration::minutes(60)), 60));
    }
    let end = instant(&signal["endsAt"]).filter(|e| *e > start)?;
    let minutes = ((end - start).num_milliseconds() / 60_000).clamp(15, 120);
    Some((iso(start), minutes))
}

fn plan_signals(input: &Input) -> (Vec<Planned>, Vec<Planned>) {
    let (mut auto, mut suggest) = (vec![], vec![]);
    for signal in &input.signals {
        let through = &signal["followThrough"];
        let intents: Vec<&Value> = through["intents"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["kind"] == "block_time" && i["window"].is_object())
            .collect();
        let task_id = through["taskId"].clone();
        for intent in &intents {
            let target = intent["targetRef"].as_str().unwrap_or("");
            auto.push(Planned {
                id: block_id(&input.definition_id, &input.local_day, target),
                title: signal["summary"].clone(),
                task_id: task_id.clone(),
                starts_at: intent["window"]["start"].as_str().unwrap_or("").to_owned(),
                minutes: intent["window"]["durationMinutes"].as_i64().unwrap_or(0),
                target_ref: Some(target.to_owned()),
            });
        }
        let wants_time_block = signal["suggestedActions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "suggest_time_block"));
        if intents.is_empty() && wants_time_block {
            let Some((starts_at, minutes)) = suggest_window(signal) else {
                continue;
            };
            let target = through["targetRef"].as_str().map(str::to_owned);
            let seed = target.clone().unwrap_or_else(|| {
                format!(
                    "suggest:{}:{}",
                    signal["type"].as_str().unwrap_or("undefined"),
                    signal["summary"].as_str().unwrap_or("")
                )
            });
            suggest.push(Planned {
                id: block_id(&input.definition_id, &input.local_day, &seed),
                title: signal["summary"].clone(),
                task_id: task_id.clone(),
                starts_at,
                minutes,
                target_ref: target,
            });
        }
    }
    (auto, suggest)
}

/// Placement for a block a legacy event already covers.
fn placement(event: &Value) -> Result<Value> {
    let bad = || Error::new(500, "stored calendar event is unreadable");
    let start = instant(&event["starts_at"]).ok_or_else(bad)?;
    let end = instant(&event["ends_at"]).ok_or_else(bad)?;
    let minutes = (((end - start).num_milliseconds() as f64) / 60_000.0).round().max(1.0);
    Ok(json!({
        "startsAt": iso(start), "durationMinutes": minutes, "calendarEventRef": event["external_id"],
    }))
}

fn pending(block: &Planned) -> Value {
    json!({
        "id": block.id, "kind": "focus", "taskId": block.task_id, "title": block.title,
        "pendingChange": {"kind": "add", "startsAt": block.starts_at, "durationMinutes": block.minutes},
    })
}
fn placed(block: &Planned, at: &Value) -> Value {
    json!({
        "id": block.id, "kind": "focus", "taskId": block.task_id, "title": block.title,
        "actualPlacement": at,
    })
}
fn ids(blocks: &[&Planned]) -> Vec<String> {
    blocks.iter().map(|b| b.id.clone()).collect()
}

fn outcome(plan: &str, auto: Vec<String>, suggest: Vec<String>, op: Option<(String, String)>, race: bool) -> Value {
    json!({
        "planId": plan, "autoBlockIds": auto, "suggestBlockIds": suggest,
        "operationId": op.as_ref().map(|o| &o.0), "batchKey": op.as_ref().map(|o| &o.1),
        "revisionRace": race,
    })
}

/// Returns null when the run planned nothing. A lost revision race still returns a result
/// with `revisionRace` set and nothing reserved, so the run commits with its facts.
pub fn reserve(host: &impl Host, input: Input) -> Result<Value> {
    let (auto, suggest) = plan_signals(&input);
    if auto.is_empty() && suggest.is_empty() {
        return Ok(Value::Null);
    }
    let day = || plans::Day {
        local_day: input.local_day.clone(),
        time_zone: input.time_zone.clone(),
    };
    let found = plans::get_for_day(host, day())?;
    let plan = if found["plan"].is_null() {
        plans::create(
            host,
            plans::Create {
                local_day: input.local_day.clone(),
                time_zone: input.time_zone.clone(),
                source_run_id: Some(input.run_id.clone()),
                evening_intent: Value::Null,
            },
        )?
    } else {
        found
    };
    let plan = &plan["plan"];
    let plan_id = plan["id"].as_str().ok_or_else(|| Error::new(503, "Invalid stored plan"))?;
    let revision = plan["revision"].as_u64().unwrap_or(0) as u32;
    let present: BTreeSet<&str> = plan["blocks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["id"].as_str())
        .collect();
    let fresh_auto: Vec<&Planned> = auto.iter().filter(|b| !present.contains(b.id.as_str())).collect();
    let fresh_suggest: Vec<&Planned> = suggest.iter().filter(|b| !present.contains(b.id.as_str())).collect();

    // A cached event carrying a block's reference links it as already placed. Two or more
    // leave that target alone. Title, time and duration never match.
    let mut linked: BTreeMap<&str, Value> = BTreeMap::new();
    let mut ambiguous: BTreeSet<&str> = BTreeSet::new();
    let targets: BTreeSet<&str> = fresh_auto
        .iter()
        .chain(&fresh_suggest)
        .filter_map(|b| b.target_ref.as_deref())
        .collect();
    for target in targets {
        let matches = events::follow_through(host, target)?;
        match matches.len() {
            0 => {}
            1 => {
                linked.insert(target, placement(&matches[0])?);
            }
            _ => {
                ambiguous.insert(target);
            }
        }
    }
    let is_linked = |b: &Planned| b.target_ref.as_deref().is_some_and(|t| linked.contains_key(t));
    let dropped = |b: &Planned| b.target_ref.as_deref().is_some_and(|t| ambiguous.contains(t));
    fn split<'p>(
        blocks: &[&'p Planned],
        is_linked: &dyn Fn(&Planned) -> bool,
        dropped: &dyn Fn(&Planned) -> bool,
    ) -> (Vec<&'p Planned>, Vec<&'p Planned>) {
        let new = blocks.iter().copied().filter(|b| !is_linked(b) && !dropped(b)).collect();
        let done = blocks.iter().copied().filter(|b| is_linked(b)).collect();
        (new, done)
    }
    let (pending_auto, linked_auto) = split(&fresh_auto, &is_linked, &dropped);
    let (pending_suggest, linked_suggest) = split(&fresh_suggest, &is_linked, &dropped);
    if pending_auto.is_empty() && pending_suggest.is_empty() && linked_auto.is_empty() && linked_suggest.is_empty() {
        return Ok(outcome(plan_id, vec![], vec![], None, false));
    }

    let additions: Vec<Value> = pending_auto
        .iter()
        .chain(&pending_suggest)
        .map(|b| pending(b))
        .chain(
            linked_auto
                .iter()
                .chain(&linked_suggest)
                .map(|b| placed(b, &linked[b.target_ref.as_deref().unwrap()])),
        )
        .collect();
    // A draft save can land between the read above and this append. Its 409 is the real
    // revision race: the run still commits and nothing is dispatched.
    let drafted = match plans::append_blocks(host, plan_id, day(), revision, &additions) {
        Ok(drafted) => drafted,
        Err(e) if e.status == 409 => return Ok(outcome(plan_id, vec![], vec![], None, true)),
        Err(e) => return Err(e),
    };
    let suggest_ids = ids(&pending_suggest);
    if pending_auto.is_empty() {
        return Ok(outcome(plan_id, vec![], suggest_ids, None, false));
    }
    let key = batch_key(&input.run_id);
    let auto_ids = ids(&pending_auto);
    let request = apply::Request {
        expected_revision: drafted["plan"]["revision"].as_i64().unwrap_or(0),
        idempotency_key: key.clone(),
        operation_key: None,
        selected_block_ids: Some(auto_ids.clone()),
        // Unapproved manual drafts never ride along in an unattended batch.
        include_pending_additions: false,
    };
    match apply::reserve(host, plan_id, request) {
        Ok(batch) => {
            let op = batch["id"].as_str().unwrap_or("").to_owned();
            Ok(outcome(plan_id, auto_ids, suggest_ids, Some((op, key)), false))
        }
        // An interactive save that advanced the plan first wins. No provider event is
        // ever created twice for one block.
        Err(e) if e.status == 409 => Ok(outcome(plan_id, auto_ids, suggest_ids, None, true)),
        Err(e) => Err(e),
    }
}

/// The operation still owed to the apply job for one run's batch, or null once settled.
pub fn find_unfinished(host: &impl Host, input: Unfinished) -> Result<Value> {
    let id = apply::find_unfinished(host, &input.plan_id, &input.batch_key)?;
    Ok(json!({"operationId": id}))
}
