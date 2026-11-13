//! The automatic day plan step and the person's calendar choices. Everything goes through
//! Calendar's public API. Calendar owns the plan tables, the block rules and the revision check.
//! This step only hands over ids, a day and the composed signals, and keeps a record of ids.
use crate::gather::api;
use crate::runs;
use crate::util::owner_zone;
use moss_module_sdk::{query::{Filter, Query}, Client, Host, Result};
use serde_json::{json, Value};

/// The two calendar switches. Both are on unless the person turned them off, and a calendar
/// that cannot be asked leaves them on, because the person has made no choice we can see.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Switches {
    /// Include the calendar in briefings.
    pub briefings: bool,
    /// Let a briefing place blocks on the day plan.
    pub planning: bool,
}

pub fn switches<H: Host + ?Sized>(host: &H) -> Switches {
    let reply = api(host, "calendar", "getSourceSwitches", json!({})).unwrap_or(Value::Null);
    let on = |key: &str| reply[key].as_bool().unwrap_or(true);
    Switches { briefings: on("briefings"), planning: on("planning") }
}

/// Signals that carry plan effects. A signal needs a text summary and a list of suggested actions.
fn signals(metadata: &Value) -> Vec<Value> {
    metadata["calendarSignals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["summary"].is_string() && s["suggestedActions"].is_array())
        .cloned()
        .collect()
}

/// The record kept with the run, or `None` when nothing was planned. It holds ids and a key only.
fn record(result: &Value) -> Option<Value> {
    let plan_id = result["planId"].as_str()?;
    Some(json!({"planId": plan_id, "operationId": result["operationId"], "batchKey": result["batchKey"]}))
}

/// Asks Calendar to reserve this run's blocks. It runs only for a succeeded run, and not when the
/// person turned planning off. A failed Calendar call never loses the briefing.
pub fn plan<H: Host + ?Sized>(host: &H, run_id: &str, definition_id: &str, metadata: &Value, now: &str) -> Result<Option<Value>> {
    let signals = signals(metadata);
    if signals.is_empty() || !switches(host).planning {
        return Ok(None);
    }
    let zone = owner_zone(host, now).unwrap_or_else(|| "UTC".to_owned());
    let day = host.call("context", "local-date", "account", json!({"instant": now, "offsetDays": 0}))?;
    let Some(day) = day["date"].as_str() else { return Ok(None) };
    let reserved = api(
        host,
        "calendar",
        "reserveAutoPlan",
        json!({"runId": run_id, "definitionId": definition_id, "localDay": day, "timeZone": zone, "signals": signals}),
    );
    Ok(reserved.ok().and_then(|r| record(&r["reservation"])))
}

/// A repeated scheduled fire finds the batch the first fire left unfinished. It appends no block
/// and composes nothing.
pub fn resume<H: Host + ?Sized>(host: &H, run_id: &str) -> Option<Value> {
    let mut query = Query::select(Filter::eq("id", run_id));
    query.limit = Some(1);
    let rows = Client(host).query(runs::TABLE, &query).ok()?;
    let saved = &rows.first()?["source_metadata"]["dayPlanAuto"];
    let (plan_id, key) = (saved["planId"].as_str()?, saved["batchKey"].as_str()?);
    let found = api(host, "calendar", "findUnfinishedBatch", json!({"planId": plan_id, "batchKey": key})).ok()?;
    found["operationId"].as_str()?;
    Some(json!({"planId": plan_id, "operationId": found["operationId"], "batchKey": key}))
}
