//! Reserved-batch execution, porting the TypeScript `ApplyExecutionService` and
//! the move/removal change execution. Every provider effect goes through the
//! public Connectors interface: one whole-batch facts read (and a fresh recheck
//! before each create), a deterministic provider identity per reserved addition
//! so a retried insert collides instead of duplicating, a readback that proves
//! the exact operation before anything is recorded, and one typed result per
//! item with an expected-outcome guard so a concurrent resume never resets an
//! applied item. The host commits each database call alone, so a crash between
//! the provider write and the record is recovered by the next pass: the item
//! reads unknown with the event id and a later recover adopts the observed
//! provider state.
use crate::{change_approval, context, operations, plans, query, Error, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{query::Filter, query::Query, Client, Host};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const FACTS_LIMIT: u64 = 200;

/// The account state one entry observed through the public calendar surface.
/// The availability probe and the access gate share it: a failed call means the
/// Connectors package is absent or incompatible, and the route fails closed
/// before any write.
pub struct Accounts {
    pub accounts: Vec<Value>,
    pub gaps: Vec<Value>,
}

/// Asks the installed Connectors package for a zero-width calendar read. The
/// answer is local whenever no calendar-capable account exists, and only a
/// missing or incompatible package makes the call itself fail.
pub fn availability(host: &impl Host) -> Result<Accounts> {
    let now = context(host, "read", "call")?["now"]
        .as_str()
        .ok_or_else(|| Error::new(503, "day plan apply is unavailable"))?
        .to_owned();
    let probe = Client(host).api(
        "connectors",
        "listCalendarContext",
        json!({"windowStart": now, "windowEnd": now, "limit": 1}),
    )?;
    Ok(Accounts {
        accounts: probe["accounts"].as_array().cloned().unwrap_or_default(),
        gaps: probe["gaps"].as_array().cloned().unwrap_or_default(),
    })
}

/// One execution entry. Resume by operation id when present; otherwise the
/// batch is loaded by idempotency key. `item_ids` selects a retry's working
/// set; `change_auth` carries the tier and the confirmed binding the gate
/// re-checks against the frozen batch.
pub struct Input<'a> {
    pub plan_id: &'a str,
    pub idempotency_key: Option<&'a str>,
    pub operation_id: Option<&'a str>,
    pub item_ids: Option<Vec<String>>,
    pub change_auth: Option<(String, Option<change_approval::Binding>)>,
    pub accounts: &'a Accounts,
}

/// A prepared pending addition.
struct Prepared {
    item_id: String,
    block_id: Value,
    starts_at: String,
    duration_minutes: i64,
    title: String,
    /// The frozen pending change as the batch stored it.
    frozen: Value,
}

/// A prepared move or removal. `stored_event_ref` is the block's recorded
/// placement reference; a block that was never applied fails there.
struct Change {
    item_id: String,
    block_id: Value,
    kind: &'static str,
    starts_at: Option<String>,
    duration_minutes: Option<i64>,
    stored_event_ref: Option<String>,
    frozen: Value,
    resume_unknown: bool,
}

/// The classified batch: settled items are reported unchanged and never
/// revalidated; pending additions and changes are the working set.
struct Snapshot {
    batch: Value,
    settled: Vec<Value>,
    pending: Vec<Prepared>,
    changes: Vec<Change>,
}

fn report_item(item: &Value) -> Value {
    json!({"itemId": item["id"], "blockId": item["blockId"], "outcome": item["outcome"], "result": item["result"]})
}

fn denied_report(batch: &Value, reason: &str) -> Value {
    json!({
        "operationId": batch["id"], "planId": batch["planId"],
        "status": "denied", "denialReason": reason,
        "items": batch["items"].as_array().into_iter().flatten().map(report_item).collect::<Vec<_>>(),
    })
}

fn completed_report(batch: &Value, items: Vec<Value>) -> Value {
    json!({
        "operationId": batch["id"], "planId": batch["planId"],
        "status": "completed", "items": items,
    })
}

fn ends_at(starts_at: &str, minutes: i64) -> Result<String> {
    let start = DateTime::parse_from_rfc3339(starts_at)
        .map_err(|_| Error::new(500, "reserved change lost its timing"))?
        .with_timezone(&Utc);
    Ok((start + chrono::Duration::minutes(minutes)).to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// The task fact the host holds for one id: `None` when the task is missing or
/// another account's, exactly as the saved read reports both.
fn task_fact(host: &impl Host, actor: &Value, task_id: &str) -> Option<Value> {
    let task = host
        .call("kv", "get", "calendar.task-reference", json!({"id": task_id}))
        .ok()?;
    let task = &task["task"];
    if task["id"] != task_id || task["ownerUserId"] != *actor {
        return None;
    }
    Some(json!({
        "status": match task["status"].as_str() {
            Some("done") => "done",
            Some("archived") => "archived",
            _ => "other",
        },
        "dueAt": task["dueAt"],
    }))
}

/// One reserved addition's provider identity. The same operation always makes
/// the same id, so a retried insert collides instead of duplicating. The
/// canonical string matches the TypeScript apply and the Connectors writer.
pub fn apply_addition_event_id(
    actor: &str,
    plan_id: &str,
    block_id: &str,
    plan_revision: i64,
    operation_id: &str,
) -> String {
    let canonical = format!("{actor}|{plan_id}|{block_id}|{plan_revision}|{operation_id}");
    let alphabet = b"0123456789abcdefghijklmnopqrstuv";
    let tail: String = Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|b| alphabet[(b & 0x1f) as usize] as char)
        .collect();
    format!("jap{tail}")
}

/// True when the provider-read metadata is exactly the identity this operation
/// wrote, for a fresh addition: all six fields.
fn provenance_matches(actual: &Value, expected: [&str; 5]) -> bool {
    actual["jarvisTool"] == "applyAddition"
        && actual["jarvisActorUserId"] == expected[0]
        && actual["jarvisPlanId"] == expected[1]
        && actual["jarvisBlockId"] == expected[2]
        && actual["jarvisPlanRevision"] == expected[3]
        && actual["jarvisOperationId"] == expected[4]
}

/// Provenance for a block this plan applied earlier: the creating revision and
/// operation may differ, so only actor, plan and block must match. Titles are
/// never used to match.
fn block_provenance_matches(actual: &Value, actor: &str, plan_id: &str, block_id: &str) -> bool {
    actual["jarvisTool"] == "applyAddition"
        && actual["jarvisActorUserId"] == actor
        && actual["jarvisPlanId"] == plan_id
        && actual["jarvisBlockId"] == block_id
}

/// Whole-batch facts for a window through the public calendar surface: the
/// timed busy intervals and whether the read certifies absence (every capable
/// account answered live, with no gaps and nothing truncated).
fn read_facts(host: &impl Host, start: &str, end: &str) -> Result<(bool, Vec<Value>)> {
    let context = Client(host).api(
        "connectors",
        "listCalendarContext",
        json!({"windowStart": start, "windowEnd": end, "limit": FACTS_LIMIT}),
    )?;
    let accounts = context["accounts"].as_array().cloned().unwrap_or_default();
    let gaps = context["gaps"].as_array().cloned().unwrap_or_default();
    let complete = !accounts.is_empty()
        && accounts.iter().all(|a| a["source"] == "live")
        && gaps.is_empty()
        && context["truncated"] != true;
    let intervals = context["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["allDay"] != true)
        .cloned()
        .collect();
    Ok((complete, intervals))
}

fn overlaps(a_start: &str, a_end: &str, b_start: &str, b_end: &str) -> bool {
    a_start < b_end && b_start < a_end
}

/// One stored item result, validated so a stored row can always be read back.
fn stored_result(result: Value) -> Result<Value> {
    operations::item_result(&result).map_err(|_| Error::new(500, "stored apply batch is unreadable"))
}

/// Records one item outcome with the applied-never-reset guard: only an item
/// still holding an expected outcome may change. A lost write answers whatever
/// a concurrent resume recorded instead.
fn record_item_result(
    host: &impl Host,
    operation_id: &str,
    item_id: &str,
    outcome: &str,
    result: Value,
    expected: &[&str],
) -> Result<(String, Value)> {
    let result = stored_result(result)?;
    let now = context(host, "read", "call")?["now"].clone();
    let updated = query(
        host,
        crate::apply::ITEMS,
        &Query::update(
            Filter::And {
                filters: vec![
                    Filter::eq("id", item_id),
                    Filter::eq("operation_id", operation_id),
                    Filter::In {
                        column: "outcome".into(),
                        values: expected.iter().map(|o| json!(o)).collect(),
                    },
                ],
            },
            crate::apply::row_values(json!({"outcome": outcome, "result": result.clone(), "updated_at": now})),
        ),
    )?;
    if updated.is_empty() {
        let rows = query(
            host,
            crate::apply::ITEMS,
            &Query::select(Filter::And {
                filters: vec![Filter::eq("id", item_id), Filter::eq("operation_id", operation_id)],
            }),
        )?;
        if let Some(row) = rows.iter().find(|r| !r["result"].is_null()) {
            let stored = stored_result(row["result"].clone())?;
            return Ok((row["outcome"].as_str().unwrap_or(outcome).to_owned(), stored));
        }
    }
    Ok((outcome.to_owned(), result))
}

/// Finalizes one item in its own committed call, with the settled-outcome
/// guard the TypeScript keeps.
fn finalize(
    host: &impl Host,
    operation_id: &str,
    item_row: &Value,
    outcome: &str,
    result: Value,
) -> Result<(String, Value)> {
    record_item_result(
        host,
        operation_id,
        item_row["id"].as_str().unwrap_or_default(),
        outcome,
        result,
        &["pending", "failed", "unknown"],
    )
}

fn report_of(item_row: &Value, outcome: &str, result: &Value) -> Value {
    json!({"itemId": item_row["id"], "blockId": item_row["blockId"], "outcome": outcome, "result": result})
}

/// Mirrors a provider placement into the block and advances the plan revision,
/// as a draft save would, so a stale draft can never re-propose a change that
/// is already on the calendar. A pending-change mismatch preserves both the
/// newer draft and its revision. `Err` means the storage write failed; the
/// caller records an unknown outcome and the next recover adopts the observed
/// provider state.
fn mirror_applied_block(
    host: &impl Host,
    plan_id: &str,
    block_id: &Value,
    expected_pending: &Value,
    placement: Value,
) -> Result<bool> {
    let rows = query(
        host,
        plans::BLOCKS,
        &Query::select(Filter::And {
            filters: vec![Filter::eq("id", block_id.clone()), Filter::eq("plan_id", plan_id)],
        }),
    )?;
    let block = rows
        .first()
        .ok_or_else(|| Error::new(404, "day plan block is not available"))?;
    if !change_approval::pending_changes_equal(&block["pending_change"], expected_pending) {
        return Ok(false);
    }
    let now = context(host, "read", "call")?["now"].clone();
    query(
        host,
        plans::BLOCKS,
        &Query::update(
            Filter::eq("id", block_id.clone()),
            crate::apply::row_values(json!({"actual_placement": placement, "pending_change": Value::Null, "updated_at": now})),
        ),
    )?;
    // The revision advances after the mirror, in its own committed call. A
    // crash between the two is recovered by the next mirror: the placement is
    // written again, and the revision then advances from its stored value.
    let plan = query(host, plans::PLANS, &Query::select(Filter::eq("id", plan_id)))?;
    let revision = plan
        .first()
        .and_then(|p| p["revision"].as_i64())
        .ok_or_else(|| Error::new(404, "day plan is not available"))?;
    let moved = query(
        host,
        plans::PLANS,
        &Query::update(
            Filter::And {
                filters: vec![Filter::eq("id", plan_id), Filter::eq("revision", revision)],
            },
            crate::apply::row_values(json!({"revision": revision + 1, "updated_at": now})),
        ),
    )?;
    if moved.is_empty() {
        return Err(Error::new(409, "day plan changed since it was read"));
    }
    Ok(true)
}

/// The snapshot classification: reload the batch and revalidate every item
/// that is about to execute. Settled outcomes are facts and never revalidated.
/// A stale retry selection is a 409, never a denied report. A block or task
/// problem denies the whole batch with zero writes.
enum Classified {
    Working(Snapshot),
    Denied(Value, &'static str),
}

fn snapshot(host: &impl Host, input: &Input) -> Result<Classified> {
    let batch = match (input.operation_id, input.idempotency_key) {
        (Some(operation), _) => change_approval::batch_by_id(host, input.plan_id, operation)?,
        (None, Some(key)) => {
            let header = crate::apply::header_by_key(host, input.plan_id, key)?
                .ok_or_else(|| Error::new(404, "day plan apply batch is not available"))?;
            crate::apply::settle_batch(host, &header)?
        }
        (None, None) => return Err(Error::new(500, "day plan apply batch is not available")),
    };
    let blocks = plans::blocks(host, input.plan_id)?;
    let selected: Option<std::collections::BTreeSet<String>> = input
        .item_ids
        .as_ref()
        .map(|ids| ids.iter().cloned().collect());
    let mut settled = Vec::new();
    let mut pending = Vec::new();
    let mut changes = Vec::new();
    let actor = context(host, "read", "call")?["actorUserId"].clone();
    let denied = |batch: Value, reason: &'static str| Ok(Classified::Denied(batch, reason));
    for item in batch["items"].as_array().ok_or_else(|| Error::new(500, "stored apply batch is unreadable"))? {
        let id = item["id"].as_str().unwrap_or_default().to_owned();
        if let Some(selected) = &selected {
            if !selected.contains(&id) {
                settled.push(item.clone());
                continue;
            }
            // The route already validated the selection atomically; the
            // snapshot rechecks it so a changed item can never execute on a
            // stale retry.
            if !matches!(item["outcome"].as_str(), Some("failed" | "unknown")) {
                return Err(Error::new(409, "day plan apply retry selection is not eligible"));
            }
        } else if matches!(item["outcome"].as_str(), Some("applied" | "failed")) {
            // Applied and failed items are settled facts: only pending and
            // unknown items enter reconciliation and execution, so an ordinary
            // replay makes no facts or provider call for them.
            settled.push(item.clone());
            continue;
        }
        let block_id = item["blockId"].clone();
        let block = block_id
            .as_str()
            .and_then(|id| blocks.iter().find(|b| b["id"] == id));
        let Some(block) = block else {
            return denied(batch, "block-changed: reserved block is gone");
        };
        if !change_approval::pending_changes_equal(&block["pending_change"], &item["pendingChange"]) {
            return denied(batch, "block-changed: reserved block no longer matches its frozen change");
        }
        let change = &item["pendingChange"];
        let kind = change["kind"].as_str().unwrap_or_default();
        if kind == "add" && (change["startsAt"].as_str().is_none() || change["durationMinutes"].as_i64().is_none()) {
            return denied(batch, "block-changed: reserved addition lost its timing");
        }
        if let Some(task_id) = block["task_id"].as_str() {
            match task_fact(host, &actor, task_id) {
                None => return denied(batch, "task-unavailable: reserved task is not available"),
                Some(fact) if fact["status"] == "done" || fact["status"] == "archived" => {
                    return denied(batch, "task-ineligible: reserved task is done or archived");
                }
                Some(_) => {}
            }
        }
        let frozen = item["pendingChange"].clone();
        if kind == "add" {
            pending.push(Prepared {
                item_id: id,
                block_id: block_id.clone(),
                starts_at: change["startsAt"].as_str().unwrap_or_default().to_owned(),
                duration_minutes: change["durationMinutes"].as_i64().unwrap_or_default(),
                title: block["title"].as_str().unwrap_or("Planned block").to_owned(),
                frozen,
            });
            continue;
        }
        if kind == "move" && (change["startsAt"].as_str().is_none() || change["durationMinutes"].as_i64().is_none()) {
            return denied(batch, "block-changed: reserved move lost its timing");
        }
        changes.push(Change {
            item_id: id,
            block_id: block_id.clone(),
            kind: if kind == "move" { "move" } else { "remove" },
            starts_at: (kind == "move").then(|| change["startsAt"].as_str().unwrap_or_default().to_owned()),
            duration_minutes: (kind == "move").then(|| change["durationMinutes"].as_i64().unwrap_or_default()),
            stored_event_ref: block["actual_placement"]["calendarEventRef"].as_str().map(str::to_owned),
            frozen,
            resume_unknown: item["outcome"] == "unknown",
        });
    }
    Ok(Classified::Working(Snapshot { batch, settled, pending, changes }))
}

/// The access gate, ported from the TypeScript adapter: an active writable
/// account, the time-block mode, the writeback behavior switch, and a stored
/// writeback tier. Denials here settle the working set durably as access
/// denied, so the status route never reads a denied batch as pending forever.
fn access_denial(host: &impl Host, accounts: &Accounts) -> Result<Option<String>> {
    let gaps = accounts
        .gaps
        .iter()
        .filter_map(|g| g["reason"].as_str())
        .collect::<Vec<_>>();
    if accounts.accounts.is_empty() {
        if gaps.is_empty() {
            return Ok(Some("access-denied: calendar write scope is not granted".into()));
        }
        if gaps.iter().all(|r| *r == "auth_error") {
            // A signed-out account is not an access denial: the facts read
            // answers incomplete and the batch stays retryable.
            return Ok(None);
        }
        if gaps.contains(&"feature_grant_disabled") {
            return Ok(Some("access-denied: calendar automation is disabled for this account".into()));
        }
        return Ok(Some("access-denied: calendar write scope is not granted".into()));
    }
    // The time-block mode is Calendar's own setting: off denies the whole batch.
    let settings = host.call("kv", "get", "calendar.briefing-settings", json!({}))?;
    if crate::settings::derive(&settings)["timeBlockMode"] == "off" {
        return Ok(Some("access-denied: time blocking is off".into()));
    }
    // The writeback behavior switch, default on when nothing is stored.
    let behaviors = host.call("kv", "get", "calendar.source-behaviors", json!({}))?;
    if behaviors["planning"] == false {
        return Ok(Some("access-denied: calendar writeback behavior is off".into()));
    }
    // The stored writeback tier: a settings promotion to auto answers
    // trusted_auto, anything the person chose instead denies here.
    let tier = change_approval::tier(host, change_approval::WRITEBACK_FAMILY)?;
    if tier != "ask_each_time" && tier != "trusted_auto" {
        return Ok(Some(format!(
            "access-denied: calendar writeback policy forbids automatic writes (tier: {tier})"
        )));
    }
    Ok(None)
}

/// Records an access denial on the working set: pending items become failed
/// with the access-denied reason and zero provider calls. Unknown items may
/// have executed and stay stored and unchanged. The reloaded batch answers the
/// report so the settled outcomes show.
fn record_access_denial(host: &impl Host, snapshot: &Snapshot) -> Result<Value> {
    let operation_id = snapshot.batch["id"].as_str().unwrap_or_default().to_owned();
    for working in snapshot
        .pending
        .iter()
        .map(|p| &p.item_id)
        .chain(snapshot.changes.iter().map(|c| &c.item_id))
    {
        let _ = record_item_result(
            host,
            &operation_id,
            working,
            "failed",
            json!({"status": "failed", "reason": "access-denied"}),
            &["pending"],
        );
    }
    change_approval::batch_by_id(
        host,
        snapshot.batch["planId"].as_str().unwrap_or_default(),
        &operation_id,
    )
}

fn execute_item_addition(
    host: &impl Host,
    batch: &Value,
    item: &Prepared,
    reports: &mut Vec<Value>,
) -> Result<()> {
    let actor = context(host, "read", "call")?["actorUserId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let plan_id = batch["planId"].as_str().unwrap_or_default();
    let operation_id = batch["id"].as_str().unwrap_or_default();
    let revision = batch["expectedRevision"].as_i64().unwrap_or_default();
    let block_id = item.block_id.as_str().unwrap_or_default();
    let expected = [
        actor.as_str(),
        plan_id,
        block_id,
        &revision.to_string(),
        operation_id,
    ];
    let event_id = apply_addition_event_id(&actor, plan_id, block_id, revision, operation_id);
    let item_row = json!({"id": item.item_id, "blockId": item.block_id});
    let unknown = |provider_event_id: &str, reports: &mut Vec<Value>| -> Result<()> {
        let settled = finalize(
            host,
            operation_id,
            &item_row,
            "unknown",
            json!({"status": "unknown", "reason": "unknown", "providerEventId": provider_event_id}),
        )?;
        reports.push(report_of(&item_row, &settled.0, &settled.1));
        Ok(())
    };
    // Reconcile first: an earlier attempt may already own this identity.
    let reconciled = match Client(host).api("connectors", "lookupCalendarEvent", json!({"eventId": event_id})) {
        Err(_) => return unknown(&event_id, reports),
        Ok(reply) => reply,
    };
    if reconciled["found"] == true {
        if !provenance_matches(&reconciled["provenance"], expected) {
            let settled = finalize(
                host,
                operation_id,
                &item_row,
                "failed",
                json!({"status": "failed", "reason": "provenance-mismatch", "providerEventId": event_id}),
            )?;
            reports.push(report_of(&item_row, &settled.0, &settled.1));
            return Ok(());
        }
        // The local cache was not verified on this path, so its mirror state
        // stays honestly unchecked rather than borrowing a write outcome.
        return apply_verified(
            host,
            batch,
            item,
            &event_id,
            reconciled["start"].clone(),
            reconciled["end"].clone(),
            json!("not-checked"),
            reports,
        );
    }
    // Fresh live recheck immediately before creation.
    let end = ends_at(&item.starts_at, item.duration_minutes)?;
    let (complete, intervals) = match read_facts(host, &item.starts_at, &end) {
        Err(_) => {
            let settled = finalize(
                host,
                operation_id,
                &item_row,
                "failed",
                json!({"status": "failed", "reason": "facts-unavailable", "providerEventId": event_id}),
            )?;
            reports.push(report_of(&item_row, &settled.0, &settled.1));
            return Ok(());
        }
        Ok(facts) => facts,
    };
    let fail_item = |reason: &str, reports: &mut Vec<Value>| -> Result<()> {
        let settled = finalize(
            host,
            operation_id,
            &item_row,
            "failed",
            json!({"status": "failed", "reason": reason, "providerEventId": event_id}),
        )?;
        reports.push(report_of(&item_row, &settled.0, &settled.1));
        Ok(())
    };
    if !complete {
        return fail_item("facts-unavailable", reports);
    }
    if intervals.iter().any(|busy| {
        overlaps(
            &item.starts_at,
            &end,
            busy["startsAt"].as_str().unwrap_or_default(),
            busy["endsAt"].as_str().unwrap_or_default(),
        )
    }) {
        return fail_item("conflict", reports);
    }
    let created = match Client(host).api(
        "connectors",
        "createCalendarEvent",
        json!({
            "windowStart": item.starts_at, "windowEnd": end,
            "durationMinutes": item.duration_minutes, "title": item.title,
            "provenance": {"jarvisPlanId": plan_id, "jarvisBlockId": block_id,
                "jarvisPlanRevision": revision, "jarvisOperationId": operation_id},
        }),
    ) {
        Err(_) => return unknown(&event_id, reports),
        Ok(reply) => reply,
    };
    if created["created"] != true {
        let id = created["googleEventId"].as_str().unwrap_or(&event_id).to_owned();
        if created["conflict"] == "no-clear-slot" {
            return fail_item_at(host, operation_id, &item_row, &id, "conflict", reports);
        }
        return fail_item_at(host, operation_id, &item_row, &id, "provider-rejected", reports);
    }
    let created_id = created["googleEventId"].as_str().unwrap_or(&event_id).to_owned();
    // A duplicate id or ambiguous response only counts after lookup confirms
    // the exact operation metadata; anything else stays unresolved.
    let verified = match Client(host).api("connectors", "lookupCalendarEvent", json!({"eventId": created_id})) {
        Err(_) => return unknown(&created_id, reports),
        Ok(reply) => reply,
    };
    if verified["found"] != true {
        return unknown(&created_id, reports);
    }
    if !provenance_matches(&verified["provenance"], expected) {
        return fail_item_at(host, operation_id, &item_row, &created_id, "provenance-mismatch", reports);
    }
    apply_verified(
        host,
        batch,
        item,
        &created_id,
        verified["start"].clone(),
        verified["end"].clone(),
        created["calendarMirror"].clone(),
        reports,
    )
}

/// A failed item whose provider id differs from the deterministic one.
fn fail_item_at(
    host: &impl Host,
    operation_id: &str,
    item_row: &Value,
    provider_event_id: &str,
    reason: &str,
    reports: &mut Vec<Value>,
) -> Result<()> {
    let settled = finalize(
        host,
        operation_id,
        item_row,
        "failed",
        json!({"status": "failed", "reason": reason, "providerEventId": provider_event_id}),
    )?;
    reports.push(report_of(item_row, &settled.0, &settled.1));
    Ok(())
}

/// Mirror and outcome record commit one after the other. When the record fails
/// after the provider create succeeded, the item is recorded unknown with the
/// event id so the next recover adopts it; the response is unknown, never
/// applied.
#[allow(clippy::too_many_arguments)]
fn apply_verified(
    host: &impl Host,
    batch: &Value,
    item: &Prepared,
    provider_event_id: &str,
    provider_start: Value,
    provider_end: Value,
    calendar_mirror: Value,
    reports: &mut Vec<Value>,
) -> Result<()> {
    let item_row = json!({"id": item.item_id, "blockId": item.block_id});
    let operation_id = batch["id"].as_str().unwrap_or_default();
    let starts_at = provider_start
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| item.starts_at.clone());
    let duration = match (provider_start.as_str(), provider_end.as_str()) {
        (Some(start), Some(end)) => DateTime::parse_from_rfc3339(start)
            .ok()
            .zip(DateTime::parse_from_rfc3339(end).ok())
            .map(|(s, e)| (e.with_timezone(&Utc) - s.with_timezone(&Utc)).num_minutes())
            .filter(|minutes| *minutes >= 0)
            .unwrap_or(item.duration_minutes),
        _ => item.duration_minutes,
    };
    let placement = json!({"startsAt": starts_at, "durationMinutes": duration, "calendarEventRef": provider_event_id});
    let mirror = match mirror_applied_block(
        host,
        batch["planId"].as_str().unwrap_or_default(),
        &item.block_id,
        &item.frozen,
        placement,
    ) {
        Ok(mirrored) => mirrored,
        Err(_) => {
            let settled = finalize(
                host,
                operation_id,
                &item_row,
                "unknown",
                json!({"status": "unknown", "reason": "unknown", "providerEventId": provider_event_id}),
            )?;
            reports.push(report_of(&item_row, &settled.0, &settled.1));
            return Ok(());
        }
    };
    let result = json!({
        "status": "applied", "providerEventId": provider_event_id,
        "startsAt": starts_at, "durationMinutes": duration,
        "calendarMirror": calendar_mirror,
        "blockMirror": if mirror { "mirrored" } else { "mismatch-preserved" },
    });
    let settled = finalize(host, operation_id, &item_row, "applied", result)?;
    reports.push(report_of(&item_row, &settled.0, &settled.1));
    Ok(())
}

enum Readback {
    Failed,
    Unknown,
    NotFound,
    Ready(Value),
}

/// Provider readback by the block's stored reference. No stored reference
/// fails before any provider call; a failed readback stays unknown, never
/// absence. Titles are never used to match.
fn check_change_provenance(host: &impl Host, change: &Change) -> Readback {
    let Some(reference) = change.stored_event_ref.as_deref() else {
        return Readback::Failed;
    };
    let lookup = match Client(host).api("connectors", "lookupCalendarEvent", json!({"eventId": reference})) {
        Err(_) => return Readback::Unknown,
        Ok(reply) => reply,
    };
    if lookup["found"] != true {
        return Readback::NotFound;
    }
    Readback::Ready(lookup)
}

/// The observed window of a provider event, or two nulls when it cannot be
/// read as timing.
fn observed_window(start: &Value, end: &Value) -> (Value, Value) {
    let Some((s, e)) = (start.as_str()).zip(end.as_str()) else {
        return (Value::Null, Value::Null);
    };
    let minutes = DateTime::parse_from_rfc3339(s)
        .ok()
        .zip(DateTime::parse_from_rfc3339(e).ok())
        .map(|(s, e)| json!((e.with_timezone(&Utc) - s.with_timezone(&Utc)).num_minutes()))
        .unwrap_or(Value::Null);
    if minutes.is_null() {
        return (Value::Null, Value::Null);
    }
    (json!(s), minutes)
}

fn same_instant(value: &Value, target: &str) -> bool {
    let Some(at) = value.as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()) else {
        return false;
    };
    target
        .parse::<DateTime<Utc>>()
        .is_ok_and(|other| at.with_timezone(&Utc) == other)
}

fn execute_change(
    host: &impl Host,
    batch: &Value,
    change: &Change,
    reports: &mut Vec<Value>,
) -> Result<()> {
    let actor = context(host, "read", "call")?["actorUserId"].as_str().unwrap_or_default().to_owned();
    let plan_id = batch["planId"].as_str().unwrap_or_default();
    let block_id = change.block_id.as_str().unwrap_or_default();
    let operation_id = batch["id"].as_str().unwrap_or_default();
    let item_row = json!({"id": change.item_id, "blockId": change.block_id});
    let reference = change.stored_event_ref.clone().unwrap_or_default();
    let fail = |reason: &str, reports: &mut Vec<Value>| -> Result<()> {
        let settled = finalize(
            host,
            operation_id,
            &item_row,
            "failed",
            json!({"status": "failed", "reason": reason, "providerEventId": reference}),
        )?;
        reports.push(report_of(&item_row, &settled.0, &settled.1));
        Ok(())
    };
    let unknown = |reports: &mut Vec<Value>| -> Result<()> {
        let settled = finalize(
            host,
            operation_id,
            &item_row,
            "unknown",
            json!({"status": "unknown", "reason": "unknown", "providerEventId": reference}),
        )?;
        reports.push(report_of(&item_row, &settled.0, &settled.1));
        Ok(())
    };
    match change.kind {
        "move" => {
            let (Some(target_start), Some(target_minutes)) =
                (change.starts_at.as_deref(), change.duration_minutes)
            else {
                return fail("block-changed", reports);
            };
            let target_end = ends_at(target_start, target_minutes)?;
            match check_change_provenance(host, change) {
                Readback::Failed => fail("provenance-mismatch", reports),
                Readback::Unknown => unknown(reports),
                Readback::NotFound => {
                    // A resumed unknown may have patched and lost the event
                    // since; without provenance that stays ambiguous. A first
                    // attempt without an event to verify can never prove
                    // ownership.
                    if change.resume_unknown {
                        unknown(reports)
                    } else {
                        fail("provenance-mismatch", reports)
                    }
                }
                Readback::Ready(lookup) => {
                    if !block_provenance_matches(&lookup["provenance"], &actor, plan_id, block_id) {
                        return fail("provenance-mismatch", reports);
                    }
                    // The writer's attendee refusal applies regardless of tier
                    // or approval.
                    if lookup["attendeeCount"].as_i64().unwrap_or(0) > 0 {
                        return fail("has-attendees", reports);
                    }
                    // Already at the target window: adopt with no patch, still
                    // mirrored.
                    if same_instant(&lookup["start"], target_start)
                        && same_instant(&lookup["end"], &target_end)
                    {
                        return mirror_change_applied(
                            host,
                            batch,
                            change,
                            target_start.to_owned(),
                            target_minutes,
                            json!("not-checked"),
                            reports,
                        );
                    }
                    // Fresh live recheck over the target window, excluding the
                    // block's own event so the move never conflicts with
                    // itself.
                    let (complete, intervals) = match read_facts(host, target_start, &target_end) {
                        Err(_) => return fail("facts-unavailable", reports),
                        Ok(facts) => facts,
                    };
                    if !complete {
                        return fail("facts-unavailable", reports);
                    }
                    if intervals.iter().any(|busy| {
                        busy["eventKey"].as_str() != Some(reference.as_str())
                            && overlaps(
                                target_start,
                                &target_end,
                                busy["startsAt"].as_str().unwrap_or_default(),
                                busy["endsAt"].as_str().unwrap_or_default(),
                            )
                    }) {
                        return fail("conflict", reports);
                    }
                    let moved = match Client(host).api(
                        "connectors",
                        "rescheduleCalendarEvent",
                        json!({"eventRef": reference, "newStart": target_start, "newEnd": target_end}),
                    ) {
                        Err(_) => return unknown(reports),
                        Ok(reply) => reply,
                    };
                    if moved["ok"] != true {
                        if moved["reason"] == "has_attendees" {
                            return fail("has-attendees", reports);
                        }
                        return fail("provider-rejected", reports);
                    }
                    mirror_change_applied(
                        host,
                        batch,
                        change,
                        target_start.to_owned(),
                        target_minutes,
                        json!("written"),
                        reports,
                    )
                }
            }
        }
        _ => match check_change_provenance(host, change) {
            Readback::Failed => fail("provenance-mismatch", reports),
            Readback::Unknown => unknown(reports),
            Readback::NotFound => {
                // Deletion is idempotent: a resumed unknown whose event is now
                // gone has reached the desired end state, so adopt it without a
                // second mutation. A first attempt without an event to verify
                // can never prove ownership.
                if change.resume_unknown {
                    mirror_removal_applied(host, batch, change, Value::Null, Value::Null, json!("not-cached"), reports)
                } else {
                    fail("provenance-mismatch", reports)
                }
            }
            Readback::Ready(lookup) => {
                if !block_provenance_matches(&lookup["provenance"], &actor, plan_id, block_id) {
                    return fail("provenance-mismatch", reports);
                }
                if lookup["attendeeCount"].as_i64().unwrap_or(0) > 0 {
                    return fail("has-attendees", reports);
                }
                let (observed_start, observed_minutes) =
                    observed_window(&lookup["start"], &lookup["end"]);
                let removed = match Client(host).api(
                    "connectors",
                    "deleteCalendarEvent",
                    json!({"eventId": reference}),
                ) {
                    Err(_) => return unknown(reports),
                    Ok(reply) => reply,
                };
                // Deleted and already-gone are both applied; anything else
                // definitively failed with no mutation.
                if removed["deleted"] != true {
                    return fail("provider-rejected", reports);
                }
                let mirror = match removed["cacheMirror"].as_str() {
                    Some("evicted") => "evicted",
                    Some("not-cached") => "not-cached",
                    _ => "skipped-error",
                };
                mirror_removal_applied(
                    host,
                    batch,
                    change,
                    observed_start,
                    observed_minutes,
                    json!(mirror),
                    reports,
                )
            }
        },
    }
}

/// Mirror and record a moved block: the placement keeps the event reference.
#[allow(clippy::too_many_arguments)]
fn mirror_change_applied(
    host: &impl Host,
    batch: &Value,
    change: &Change,
    starts_at: String,
    duration_minutes: i64,
    calendar_mirror: Value,
    reports: &mut Vec<Value>,
) -> Result<()> {
    let item_row = json!({"id": change.item_id, "blockId": change.block_id});
    let operation_id = batch["id"].as_str().unwrap_or_default();
    let reference = change.stored_event_ref.clone().unwrap_or_default();
    let placement =
        json!({"startsAt": starts_at, "durationMinutes": duration_minutes, "calendarEventRef": reference});
    let mirror = match mirror_applied_block(
        host,
        batch["planId"].as_str().unwrap_or_default(),
        &change.block_id,
        &change.frozen,
        placement,
    ) {
        Ok(mirrored) => mirrored,
        Err(_) => return unknown_change(host, operation_id, &item_row, &reference, reports),
    };
    let result = json!({
        "status": "applied", "providerEventId": reference,
        "startsAt": starts_at, "durationMinutes": duration_minutes,
        "calendarMirror": calendar_mirror,
        "blockMirror": if mirror { "mirrored" } else { "mismatch-preserved" },
    });
    let settled = finalize(host, operation_id, &item_row, "applied", result)?;
    reports.push(report_of(&item_row, &settled.0, &settled.1));
    Ok(())
}

/// Mirror and record a removed block: the placement is cleared and the result
/// carries the deleted event's last observed window.
fn mirror_removal_applied(
    host: &impl Host,
    batch: &Value,
    change: &Change,
    observed_start: Value,
    observed_minutes: Value,
    calendar_mirror: Value,
    reports: &mut Vec<Value>,
) -> Result<()> {
    let item_row = json!({"id": change.item_id, "blockId": change.block_id});
    let operation_id = batch["id"].as_str().unwrap_or_default();
    let reference = change.stored_event_ref.clone().unwrap_or_default();
    let placement = json!({"startsAt": Value::Null, "durationMinutes": Value::Null, "calendarEventRef": Value::Null});
    let mirror = match mirror_applied_block(
        host,
        batch["planId"].as_str().unwrap_or_default(),
        &change.block_id,
        &change.frozen,
        placement,
    ) {
        Ok(mirrored) => mirrored,
        Err(_) => return unknown_change(host, operation_id, &item_row, &reference, reports),
    };
    let result = json!({
        "status": "applied", "removed": true, "providerEventId": reference,
        "startsAt": observed_start, "durationMinutes": observed_minutes,
        "calendarMirror": calendar_mirror,
        "blockMirror": if mirror { "mirrored" } else { "mismatch-preserved" },
    });
    let settled = finalize(host, operation_id, &item_row, "applied", result)?;
    reports.push(report_of(&item_row, &settled.0, &settled.1));
    Ok(())
}

fn unknown_change(
    host: &impl Host,
    operation_id: &str,
    item_row: &Value,
    reference: &str,
    reports: &mut Vec<Value>,
) -> Result<()> {
    let settled = finalize(
        host,
        operation_id,
        item_row,
        "unknown",
        json!({"status": "unknown", "reason": "unknown", "providerEventId": reference}),
    )?;
    reports.push(report_of(item_row, &settled.0, &settled.1));
    Ok(())
}

/// Runs one execution entry and answers the report.
pub fn execute(host: &impl Host, input: &Input) -> Result<Value> {
    let snapshot = match snapshot(host, input)? {
        Classified::Denied(batch, reason) => return Ok(denied_report(&batch, reason)),
        Classified::Working(snapshot) => snapshot,
    };
    let batch = snapshot.batch.clone();
    if snapshot.pending.is_empty() && snapshot.changes.is_empty() {
        // Nothing left to do: settled outcomes are already recorded, so report
        // them unchanged without consulting task state, the access gate, facts,
        // or the provider. Current policy can never revoke a recorded outcome.
        let items = snapshot.settled.iter().map(report_item).collect::<Vec<_>>();
        return Ok(completed_report(&batch, items));
    }
    // The access gate settles the working set durably when it denies.
    if let Some(reason) = access_denial(host, input.accounts)? {
        let reloaded = record_access_denial(host, &snapshot)?;
        return Ok(denied_report(&reloaded, &reason));
    }
    // The change gate re-checks on every entry: reserved moves and removals run
    // only with trusted_auto or the exact confirmed binding of this batch. A
    // denial writes nothing and makes zero provider calls.
    let executing: Vec<String> = snapshot
        .pending
        .iter()
        .map(|p| p.item_id.clone())
        .chain(snapshot.changes.iter().map(|c| c.item_id.clone()))
        .collect();
    let actor = context(host, "read", "call")?["actorUserId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let live_blocks = plans::blocks(host, batch["planId"].as_str().unwrap_or_default())?;
    let binding = change_approval::build_binding(&actor, &batch, &live_blocks);
    if let Err(reason) =
        change_approval::check_change_gate(&batch, &executing, &binding, input.change_auth.as_ref())
    {
        return Ok(denied_report(&batch, reason));
    }
    let mut reports: Vec<Value> = snapshot.settled.iter().map(report_item).collect();
    // Whole-batch facts cover pending additions only and run before any
    // provider work. Moves recheck their own target window per item; removals
    // need no recheck.
    if !snapshot.pending.is_empty() {
        let window_start = snapshot
            .pending
            .iter()
            .map(|p| p.starts_at.clone())
            .min()
            .unwrap_or_default();
        let window_end = snapshot
            .pending
            .iter()
            .map(|p| ends_at(&p.starts_at, p.duration_minutes))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .max()
            .unwrap_or_default();
        let (complete, intervals) = read_facts(host, &window_start, &window_end)?;
        if !complete {
            return Ok(denied_report(
                &batch,
                "facts-unavailable: current calendar facts are incomplete",
            ));
        }
        // A pure conflict check over the snapshot plus the whole-batch facts:
        // any failure denies the whole batch with zero writes.
        let mut conflict_detail = Vec::new();
        for (index, mine) in snapshot.pending.iter().enumerate() {
            let mine_end = ends_at(&mine.starts_at, mine.duration_minutes)?;
            for other in snapshot.pending.iter().skip(index + 1) {
                let other_end = ends_at(&other.starts_at, other.duration_minutes)?;
                if overlaps(&mine.starts_at, &mine_end, &other.starts_at, &other_end) {
                    conflict_detail.push(format!(
                        "{}:selected_overlap",
                        mine.block_id.as_str().unwrap_or_default()
                    ));
                    conflict_detail.push(format!(
                        "{}:selected_overlap",
                        other.block_id.as_str().unwrap_or_default()
                    ));
                }
            }
            if intervals.iter().any(|busy| {
                overlaps(
                    &mine.starts_at,
                    &mine_end,
                    busy["startsAt"].as_str().unwrap_or_default(),
                    busy["endsAt"].as_str().unwrap_or_default(),
                )
            }) {
                conflict_detail.push(format!(
                    "{}:calendar_busy",
                    mine.block_id.as_str().unwrap_or_default()
                ));
            }
        }
        if !conflict_detail.is_empty() {
            conflict_detail.sort();
            conflict_detail.dedup();
            return Ok(denied_report(
                &batch,
                &format!(
                    "conflict: reserved additions overlap protected time ({})",
                    conflict_detail.join(",")
                ),
            ));
        }
    }
    let pending = &snapshot.pending;
    for item in pending {
        execute_item_addition(host, &batch, item, &mut reports)?;
    }
    for change in &snapshot.changes {
        execute_change(host, &batch, change, &mut reports)?;
    }
    Ok(completed_report(&batch, reports))
}
