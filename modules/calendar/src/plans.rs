//! Draft persistence only. Provider execution and operation state machines are slice two.
use crate::{context, model, query, Error, Result};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Host,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub const PLANS: &str = "app.day_plans";
pub const BLOCKS: &str = "app.day_plan_blocks";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Day {
    pub local_day: String,
    pub time_zone: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub local_day: String,
    pub time_zone: String,
    #[serde(default)]
    pub source_run_id: Option<String>,
    #[serde(default)]
    pub evening_intent: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    #[serde(default)]
    pub plan_id: String,
    pub local_day: String,
    pub time_zone: String,
    pub expected_revision: u32,
    #[serde(flatten)]
    pub patch: std::collections::BTreeMap<String, Value>,
}
fn both(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}
fn values(value: Value) -> std::collections::BTreeMap<String, Value> {
    value.as_object().unwrap().clone().into_iter().collect()
}
fn blocks(host: &impl Host, id: &str) -> Result<Vec<Value>> {
    let mut out = vec![];
    loop {
        let q = Query {
            order: vec![
                Order {
                    column: "position".into(),
                    descending: false,
                },
                Order {
                    column: "id".into(),
                    descending: false,
                },
            ],
            offset: out.len() as u32,
            limit: Some(1000),
            ..Query::select(Filter::eq("plan_id", id))
        };
        let page = query(host, BLOCKS, &q)?;
        let done = page.len() < 1000;
        out.extend(page);
        if done {
            return Ok(out);
        }
    }
}
fn block_dto(b: &Value) -> Value {
    let actual = &b["actual_placement"];
    let actual = actual.as_object().map(|_| {
        json!({
            "startsAt":actual["startsAt"].as_str(),
            "durationMinutes":actual["durationMinutes"],
            "calendarEventRef":actual["calendarEventRef"].as_str(),
        })
    });
    let pending = &b["pending_change"];
    let pending = match pending["kind"].as_str() {
        Some("remove") => json!({"kind":"remove"}),
        Some(kind @ ("add" | "move"))
            if pending["startsAt"].is_string() && pending["durationMinutes"].is_number() =>
        {
            json!({"kind":kind,"startsAt":pending["startsAt"],"durationMinutes":pending["durationMinutes"]})
        }
        _ => Value::Null,
    };
    json!({"id":b["id"],"kind":b["kind"],"taskId":b["task_id"],"title":b["title"],"position":b["position"],"actualPlacement":actual,"pendingChange":pending})
}
fn dto(host: &impl Host, row: &Value) -> Result<Value> {
    let id = row["id"]
        .as_str()
        .ok_or_else(|| Error::new(503, "Invalid stored plan"))?;
    let blocks = blocks(host, id)?.iter().map(block_dto).collect::<Vec<_>>();
    let intent = model::merge_intent(&model::empty_intent(), Some(&row["evening_intent"]))?;
    Ok(
        json!({"id":id,"localDay":row["local_day"],"timeZone":row["time_zone"],"revision":row["revision"],"sourceRunId":row["source_run_id"],"blocks":blocks,"eveningIntent":intent}),
    )
}
pub(crate) fn get_by_id(host: &impl Host, id: &str) -> Result<Value> {
    let row = query(host, PLANS, &Query::select(Filter::eq("id", id)))?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new(404, "day plan is not available"))?;
    dto(host, &row)
}
pub fn get_for_day(host: &impl Host, input: Day) -> Result<Value> {
    let (day, zone) = model::day_zone(&input.local_day, &input.time_zone)?;
    let rows = query(
        host,
        PLANS,
        &Query::select(both(vec![
            Filter::eq("local_day", day),
            Filter::eq("time_zone", zone),
        ])),
    )?;
    Ok(json!({"plan":rows.first().map(|r|dto(host,r)).transpose()?}))
}
fn require_tasks(host: &impl Host, intent: &Value, blocks: &[Value]) -> Result<()> {
    let actor = context(host, "read", "call")?["actorUserId"].clone();
    let mut ids = vec![];
    if let Some(priorities) = intent["priorityTaskIds"].as_array() {
        ids.extend(priorities.iter().cloned().map(|id| (id, "priority")));
    }
    for field in ["corrections", "commitments"] {
        if let Some(items) = intent[field].as_array() {
            ids.extend(
                items
                    .iter()
                    .map(|v| v["taskId"].clone())
                    .filter(|v| !v.is_null())
                    .map(|id| {
                        (
                            id,
                            if field == "corrections" {
                                "correction"
                            } else {
                                "commitment"
                            },
                        )
                    }),
            );
        }
    }
    ids.extend(
        blocks
            .iter()
            .map(|b| b["task_id"].clone())
            .filter(|v| !v.is_null())
            .map(|id| (id, "block")),
    );
    for (id, field) in ids {
        let task = host.call("kv", "get", "calendar.task-reference", json!({"id":id}))?;
        if task["task"]["id"] != id || task["task"]["ownerUserId"] != actor {
            return Err(Error::new(
                404,
                format!("day plan {field} task is not available"),
            ));
        }
    }
    Ok(())
}
pub fn create(host: &impl Host, input: Create) -> Result<Value> {
    let (day, zone) = model::day_zone(&input.local_day, &input.time_zone)?;
    let intent = model::merge_intent(&model::empty_intent(), Some(&input.evening_intent))?;
    let existing = get_for_day(
        host,
        Day {
            local_day: day.clone(),
            time_zone: zone.clone(),
        },
    )?;
    if !existing["plan"].is_null() {
        return Ok(existing);
    }
    require_tasks(host, &intent, &[])?;
    let source = input.source_run_id.map(|s| s.trim().to_owned());
    if let Some(id) = &source {
        if id.is_empty() {
            return Err(model::invalid("sourceRunId must be an id or null"));
        }
        let run = host.call("kv", "get", "calendar.briefing-reference", json!({"id":id}))?;
        if run["run"]["id"] != *id
            || run["run"]["ownerUserId"] != context(host, "read", "call")?["actorUserId"]
        {
            return Err(Error::new(404, "briefing run is not available"));
        }
    }
    let mut q = Query::insert(values(
        json!({"local_day":day,"time_zone":zone,"revision":1,"evening_intent":intent,"source_run_id":source}),
    ));
    q.conflict = Conflict::Ignore;
    query(host, PLANS, &q)?;
    get_for_day(
        host,
        Day {
            local_day: day,
            time_zone: zone,
        },
    )
}
pub fn save(host: &impl Host, input: Save) -> Result<Value> {
    if input.expected_revision == 0 || input.expected_revision >= i32::MAX as u32 {
        return Err(model::invalid(
            "expectedRevision must be a positive integer",
        ));
    }
    if input
        .patch
        .keys()
        .any(|k| !matches!(k.as_str(), "blocks" | "eveningIntent"))
    {
        return Err(model::invalid("Invalid draft field"));
    }
    let (day, zone) = model::day_zone(&input.local_day, &input.time_zone)?;
    let current = query(
        host,
        PLANS,
        &Query::select(Filter::eq("id", input.plan_id.clone())),
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::new(404, "day plan is not available"))?;
    if current["local_day"] != day || current["time_zone"] != zone {
        return Err(Error::new(404, "day plan is not available"));
    }
    if current["revision"] != input.expected_revision {
        return Err(Error::new(409, "day plan changed since it was read"));
    }
    let current_intent =
        model::merge_intent(&model::empty_intent(), Some(&current["evening_intent"]))?;
    let intent = model::merge_intent(&current_intent, input.patch.get("eveningIntent"))?;
    let replacement = input
        .patch
        .get("blocks")
        .map(|v| {
            v.as_array()
                .ok_or_else(|| model::invalid("blocks must be a list"))?
                .iter()
                .enumerate()
                .map(|(i, b)| model::block(b, i))
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?;
    require_tasks(host, &intent, replacement.as_deref().unwrap_or(&[]))?;
    let now = context(host, "read", "call")?["now"].clone();
    let updated = query(
        host,
        PLANS,
        &Query::update(
            both(vec![
                Filter::eq("id", input.plan_id.clone()),
                Filter::eq("revision", input.expected_revision),
            ]),
            values(
                json!({"revision":input.expected_revision+1,"evening_intent":intent,"updated_at":now}),
            ),
        ),
    )?;
    if updated.is_empty() {
        return Err(Error::new(409, "day plan changed since it was read"));
    }
    if let Some(replacement) = replacement {
        let stored = blocks(host, &input.plan_id)?;
        let mut seen = std::collections::BTreeSet::new();
        for mut block in replacement {
            let id = block.as_object_mut().unwrap().remove("id").unwrap();
            if let Some(id) = id.as_str() {
                if !seen.insert(id.to_owned()) {
                    return Err(model::invalid("Duplicate block id"));
                }
                if !stored.iter().any(|b| b["id"] == id) {
                    return Err(Error::new(404, "day plan block is not available"));
                }
                block["updated_at"] = now.clone();
                query(
                    host,
                    BLOCKS,
                    &Query::update(
                        both(vec![
                            Filter::eq("id", id),
                            Filter::eq("plan_id", input.plan_id.clone()),
                        ]),
                        values(block),
                    ),
                )?;
            } else {
                block["plan_id"] = json!(input.plan_id);
                block["actual_placement"] = Value::Null;
                query(host, BLOCKS, &Query::insert(values(block)))?;
            }
        }
        for row in stored {
            if !seen.contains(row["id"].as_str().unwrap_or("")) {
                if !row["actual_placement"].is_null() {
                    return Err(model::invalid(
                        "recorded placement requires a pending removal",
                    ));
                }
                query(
                    host,
                    BLOCKS,
                    &Query::delete(Filter::eq("id", row["id"].clone())),
                )?;
            }
        }
    }
    Ok(json!({"plan":dto(host,&updated[0])?}))
}
