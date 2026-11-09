//! Read an existing apply batch. This path never contacts a provider or changes a plan.
use crate::{query, Error, Result};
use moss_module_sdk::{
    query::{Filter, Query},
    Host,
};
use serde_json::{json, Value};

fn unreadable() -> Error {
    Error::new(500, "stored apply batch is unreadable")
}
fn uuid(value: &str) -> bool {
    value.split('-').map(str::len).eq([8, 4, 4, 4, 12])
        && value.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}
fn selection(value: &Value) -> Result<&str> {
    if !matches!(value["kind"].as_str(), Some("add" | "move" | "remove")) {
        return Err(unreadable());
    }
    value["blockId"].as_str().ok_or_else(unreadable)
}
fn item_result(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let valid = match value["status"].as_str() {
        Some("failed" | "unknown") => value["reason"].is_string(),
        Some("applied") => {
            let removed = value["removed"] == true;
            value["providerEventId"].is_string()
                && matches!(
                    value["calendarMirror"].as_str(),
                    Some(
                        "written"
                            | "skipped-rls"
                            | "skipped-error"
                            | "not-checked"
                            | "not-cached"
                            | "evicted"
                    )
                )
                && matches!(
                    value["blockMirror"].as_str(),
                    Some("mirrored" | "mismatch-preserved")
                )
                && (value["startsAt"].is_string()
                    || (removed && value.get("startsAt") == Some(&Value::Null)))
                && (value["durationMinutes"].is_number()
                    || (removed && value.get("durationMinutes") == Some(&Value::Null)))
        }
        _ => false,
    };
    if valid {
        // Match the original HTTP response schema; stored extension fields are
        // not part of the status contract.
        let mut output = serde_json::Map::new();
        for key in [
            "status",
            "reason",
            "providerEventId",
            "startsAt",
            "durationMinutes",
            "calendarMirror",
            "blockMirror",
            "removed",
        ] {
            if let Some(field) = value.get(key) {
                output.insert(key.into(), field.clone());
            }
        }
        Ok(Value::Object(output))
    } else {
        Err(unreadable())
    }
}

pub fn read(host: &impl Host, plan_id: &str, operation_id: &str) -> Result<Value> {
    if !uuid(plan_id) || !uuid(operation_id) {
        return Err(Error::new(400, "id and operationId must be uuids"));
    }
    // All reads go through the host's actor-scoped transaction and the retained
    // owner-only policies. Both URL ids must match the same header.
    let headers = query(
        host,
        "app.day_plan_operations",
        &Query::select(Filter::And {
            filters: vec![
                Filter::eq("id", operation_id),
                Filter::eq("plan_id", plan_id),
            ],
        }),
    )?;
    let header = headers
        .first()
        .filter(|row| row["kind"] == "apply")
        .ok_or_else(|| Error::new(404, "day plan apply operation is not available"))?;
    let snapshot = &header["selection_snapshot"];
    let entries = if let Some(entries) = snapshot.as_array() {
        entries
    } else {
        if !snapshot["intent"]
            .as_array()
            .is_some_and(|ids| ids.iter().all(Value::is_string))
        {
            return Err(unreadable());
        }
        snapshot["selection"].as_array().ok_or_else(unreadable)?
    };
    let order: Vec<&str> = entries.iter().map(selection).collect::<Result<_>>()?;
    let mut rows = vec![];
    loop {
        let page = query(
            host,
            "app.day_plan_operation_items",
            &Query {
                offset: rows.len() as u32,
                limit: Some(1000),
                order: vec![moss_module_sdk::query::Order {
                    column: "id".into(),
                    descending: false,
                }],
                ..Query::select(Filter::eq("operation_id", operation_id))
            },
        )?;
        let done = page.len() < 1000;
        rows.extend(page);
        if done {
            break;
        }
    }
    let fallback = rows.len();
    rows.sort_by_key(|row| {
        order
            .iter()
            .rposition(|id| Some(*id) == row["block_id"].as_str())
            .unwrap_or(fallback)
    });
    let mut items = vec![];
    let mut pending = false;
    let mut denied = false;
    for row in rows {
        if !matches!(row["kind"].as_str(), Some("add" | "move" | "remove")) {
            return Err(unreadable());
        }
        selection(&row["pending_change"])?;
        let result = item_result(&row["result"])?;
        pending |= matches!(row["outcome"].as_str(), Some("pending" | "unknown"));
        denied |= row["outcome"] == "failed" && result["reason"] == "access-denied";
        items.push(json!({"itemId":row["id"], "blockId":row["block_id"], "outcome":row["outcome"], "result":result}));
    }
    let mut response = json!({"operationId":header["id"], "planId":header["plan_id"], "status":if pending {"pending"} else {"completed"}, "items":items});
    if denied {
        response["denial"] = json!({"code":"day_plan_denied", "remediationRef":"calendar.automatic_planning_policy"});
    }
    Ok(response)
}
