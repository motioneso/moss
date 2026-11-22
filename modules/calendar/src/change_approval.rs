//! Change confirmation for reserved calendar moves and removals, porting the
//! TypeScript day-plan change approval (`day-plan-change-approval.ts`). The
//! binding ties one approval to one exact operation: actor, plan, operation,
//! expected revision and the ordered change set. The record itself lives in
//! the host's owner-scoped approvals store, reached only through the public
//! `approvals` port; this module never reads another module's tables.
use crate::{Error, Result};
use moss_module_sdk::{query::Filter, query::Query, Host};
use serde_json::{json, Value};

/// The approval family this module declares for the `approvals` port, and the
/// action-policy families that gate moves and removals. `calendar_management`
/// mirrors the TypeScript family (default always_confirm, only an explicit
/// trusted_auto promotion skips confirmation); `calendar_writeback` carries the
/// write tier the settings screen promotes through `timeBlockMode`.
pub const APPROVAL_FAMILY: &str = "calendar.day-plan-changes";
pub const MANAGEMENT_FAMILY: &str = "calendar_management";
pub const WRITEBACK_FAMILY: &str = "calendar_writeback";
pub const TOOL_NAME: &str = "calendar.applyDayPlanChanges";

/// The audited binding stored as the approval's input summary.
#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub actor_user_id: String,
    pub plan_id: String,
    pub operation_id: String,
    pub plan_revision: i64,
    pub changes: Vec<Value>,
}

fn change_entry(block: &Value, item: &Value) -> Value {
    let kind = item["kind"].as_str().unwrap_or("");
    let reference = block["actual_placement"]["calendarEventRef"].as_str();
    json!({
        "blockId": if item["blockId"].is_null() { item["pendingChange"]["blockId"].clone() } else { item["blockId"].clone() },
        "kind": kind,
        "calendarEventRef": if kind == "add" { Value::Null } else { reference.map(Value::from).unwrap_or(Value::Null) },
        "startsAt": if kind == "remove" { Value::Null } else { item["pendingChange"]["startsAt"].clone() },
        "durationMinutes": if kind == "remove" { Value::Null } else { item["pendingChange"]["durationMinutes"].clone() },
    })
}

fn block_by_id<'a>(blocks: &'a [Value], id: &Value) -> Option<&'a Value> {
    blocks.iter().find(|b| b["id"] == *id)
}

/// True when two frozen pending changes agree, exactly as the TypeScript
/// `pendingChangesEqual`: nulls must both be null, a removal ignores timing,
/// and any other kind compares start and duration.
pub fn pending_changes_equal(a: &Value, b: &Value) -> bool {
    if a.is_null() || b.is_null() {
        return a.is_null() && b.is_null();
    }
    if a["kind"] != b["kind"] {
        return false;
    }
    if a["kind"] == "remove" {
        return true;
    }
    a["startsAt"] == b["startsAt"] && a["durationMinutes"] == b["durationMinutes"]
}

/// One entry per frozen batch item, in batch order, from the blocks as stored.
pub fn build_binding(actor: &str, batch: &Value, blocks: &[Value]) -> Binding {
    let changes = batch["items"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let block = item["blockId"]
                .as_str()
                .and_then(|id| block_by_id(blocks, &json!(id)));
            match block {
                Some(block) => change_entry(block, item),
                None => change_entry(&Value::Null, item),
            }
        })
        .collect();
    Binding {
        actor_user_id: actor.to_owned(),
        plan_id: batch["planId"].as_str().unwrap_or_default().to_owned(),
        operation_id: batch["id"].as_str().unwrap_or_default().to_owned(),
        plan_revision: batch["expectedRevision"].as_i64().unwrap_or_default(),
        changes,
    }
}

/// The live binding for the confirm entry: same shape, but the frozen pending
/// change of every item must still match the live draft. `None` when the draft
/// drifted under the reservation: changed contents require renewed approval.
pub fn build_live_binding(actor: &str, batch: &Value, blocks: &[Value]) -> Option<Binding> {
    let mut changes = Vec::new();
    for item in batch["items"].as_array()? {
        let block = item["blockId"]
            .as_str()
            .and_then(|id| block_by_id(blocks, &json!(id)))?;
        if !pending_changes_equal(&block["pending_change"], &item["pendingChange"]) {
            return None;
        }
        changes.push(change_entry(block, item));
    }
    Some(Binding {
        actor_user_id: actor.to_owned(),
        plan_id: batch["planId"].as_str().unwrap_or_default().to_owned(),
        operation_id: batch["id"].as_str().unwrap_or_default().to_owned(),
        plan_revision: batch["expectedRevision"].as_i64().unwrap_or_default(),
        changes,
    })
}

impl Binding {
    /// The exact stored summary shape. The host pins the owner; the actor field
    /// restates the pinned actor the host itself names on the call.
    pub fn summary(&self) -> Value {
        json!({
            "tool": TOOL_NAME,
            "actorUserId": self.actor_user_id,
            "planId": self.plan_id,
            "operationId": self.operation_id,
            "planRevision": self.plan_revision,
            "changes": self.changes,
        })
    }
    pub fn equal_to(&self, other: &Binding, executing: Option<&std::collections::BTreeSet<usize>>) -> bool {
        if self.actor_user_id != other.actor_user_id
            || self.plan_id != other.plan_id
            || self.operation_id != other.operation_id
            || self.plan_revision != other.plan_revision
            || self.changes.len() != other.changes.len()
        {
            return false;
        }
        self.changes.iter().zip(&other.changes).enumerate().all(|(index, (mine, theirs))| {
            // With an executing set, settled entries are skipped, never trusted
            // to still match; without one, every entry is compared.
            let skip = executing.is_some_and(|set| !set.contains(&index));
            skip || mine == theirs
        })
    }
}

/// Reads our binding back from a stored input summary. `None` for anything this
/// module did not write, including another tool's approvals in the same store.
pub fn read_binding(summary: &Value) -> Option<Binding> {
    if summary["tool"] != TOOL_NAME {
        return None;
    }
    let read_text = |value: &Value| value.as_str().map(str::to_owned);
    let changes = summary["changes"].as_array()?;
    let mut out = Vec::new();
    for entry in changes {
        let kind = entry["kind"].as_str()?;
        if !matches!(kind, "add" | "move" | "remove") {
            return None;
        }
        for key in ["blockId"] {
            if entry[key].as_str().is_none() {
                return None;
            }
        }
        for key in ["calendarEventRef", "startsAt"] {
            if !entry[key].is_null() && entry[key].as_str().is_none() {
                return None;
            }
        }
        if !entry["durationMinutes"].is_null() && entry["durationMinutes"].as_i64().is_none() {
            return None;
        }
        out.push(json!({
            "blockId": read_text(&entry["blockId"])?,
            "kind": kind,
            "calendarEventRef": if entry["calendarEventRef"].is_null() { Value::Null } else { json!(read_text(&entry["calendarEventRef"])?) },
            "startsAt": if entry["startsAt"].is_null() { Value::Null } else { json!(read_text(&entry["startsAt"])?) },
            "durationMinutes": entry["durationMinutes"].clone(),
        }));
    }
    Some(Binding {
        actor_user_id: read_text(&summary["actorUserId"])?,
        plan_id: read_text(&summary["planId"])?,
        operation_id: read_text(&summary["operationId"])?,
        plan_revision: summary["planRevision"].as_i64()?,
        changes: out,
    })
}

/// The person's stored tier for one declared action-policy family. The host
/// materializes the install tier on first read, so a missing choice answers the
/// family default rather than an error.
pub fn tier(host: &impl Host, family: &str) -> Result<String> {
    let reply = host.call("action-policy", "route-read", family, json!({}))?;
    Ok(reply["tier"].as_str().unwrap_or_default().to_owned())
}

/// Only an explicit trusted_auto promotion executes without confirmation; every
/// other tier, including ask_each_time, confirms.
pub fn requires_confirmation(tier: &str) -> bool {
    tier != "trusted_auto"
}

/// Authorization for one execution entry. Only the items about to execute are
/// compared: settled items keep their stored outcomes and never re-execute,
/// while their live blocks legitimately changed through mirroring. Anything
/// else denies with no writes.
pub fn check_change_gate(
    batch: &Value,
    executing: &[String],
    binding: &Binding,
    auth: Option<&(String, Option<Binding>)>,
) -> std::result::Result<(), &'static str> {
    let items = batch["items"].as_array().into_iter().flatten().collect::<Vec<_>>();
    let executing_kinds: Vec<&str> = items
        .iter()
        .filter(|item| item["id"].as_str().is_some_and(|id| executing.contains(&id.to_owned())))
        .filter_map(|item| item["kind"].as_str())
        .collect();
    if !executing_kinds.iter().any(|kind| *kind != "add") {
        return Ok(());
    }
    let Some((stored_tier, approval)) = auth else {
        return Err("confirmation-required: reserved moves or removals need a confirmed approval");
    };
    if !requires_confirmation(stored_tier) {
        return Ok(());
    }
    if let Some(approval) = approval {
        let indexes: std::collections::BTreeSet<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| item["id"].as_str().is_some_and(|id| executing.contains(&id.to_owned())))
            .map(|(index, _)| index)
            .collect();
        if approval.equal_to(binding, Some(&indexes)) {
            return Ok(());
        }
    }
    Err("confirmation-required: reserved moves or removals need a confirmed approval")
}

/// Creates one pending approval bound to the exact operation. The host stores it
/// owner-scoped under this module and the declared family.
pub fn create_pending(host: &impl Host, binding: &Binding) -> Result<Value> {
    let reply = host.call(
        "approvals",
        "create",
        APPROVAL_FAMILY,
        json!({"inputSummary": binding.summary()}),
    )?;
    Ok(reply["id"].clone())
}

/// One stored approval by id. The host answers not-found for anyone else's
/// record, which the routes read as an unavailable approval.
pub fn get(host: &impl Host, approval_id: &str) -> Result<Value> {
    Ok(host.call("approvals", "get", APPROVAL_FAMILY, json!({"id": approval_id}))?)
}

/// Resolves pending to confirmed exactly once; the host refuses anything that
/// is not this owner's pending record.
pub fn confirm(host: &impl Host, approval_id: &str) -> Result<Value> {
    Ok(host.call("approvals", "confirm", APPROVAL_FAMILY, json!({"id": approval_id}))?)
}

/// The newest pending record bound to one operation, or null.
pub fn find_pending(host: &impl Host, operation_id: &str) -> Result<Value> {
    let reply = host.call(
        "approvals",
        "find-pending",
        APPROVAL_FAMILY,
        json!({"operationId": operation_id}),
    )?;
    Ok(reply["approval"].clone())
}

/// The newest confirmed record bound to one operation, or null.
pub fn find_confirmed(host: &impl Host, operation_id: &str) -> Result<Value> {
    let reply = host.call(
        "approvals",
        "find-confirmed",
        APPROVAL_FAMILY,
        json!({"operationId": operation_id}),
    )?;
    Ok(reply["approval"].clone())
}

/// The batch this route operates on, loaded by operation id. The header must
/// belong to the named plan and be an apply batch; the item order follows the
/// frozen selection exactly as the reservation wrote it.
pub fn batch_by_id(host: &impl Host, plan_id: &str, operation_id: &str) -> Result<Value> {
    let headers = crate::query(
        host,
        crate::apply::OPERATIONS,
        &Query::select(Filter::And {
            filters: vec![
                Filter::eq("id", operation_id),
                Filter::eq("plan_id", plan_id),
            ],
        }),
    )?;
    let header = headers
        .into_iter()
        .find(|row| row["kind"] == "apply")
        .ok_or_else(|| Error::new(404, "day plan apply operation is not available"))?;
    crate::apply::settle_batch(host, &header)
}
