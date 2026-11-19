//! Chat review tools and the approval card for them. Reads return trimmed shapes. A change needs
//! the host's stored approval, and its version must still match the candidate's current row.
use crate::candidates::{CANDIDATES, SOURCES, candidate_dto, compare, find, now};
use crate::util::{is_uuid, iso, iso_or_null, values};
use moss_module_sdk::{
    Client, Error, Host, Result,
    query::{Compare, Filter, Order, Query},
};
use serde_json::{Value, json};

pub const LIST_STATUSES: [&str; 6] = [
    "pending_review",
    "accepted",
    "rejected",
    "snoozed",
    "expired",
    "explicit_non_action",
];
pub const THREAD_LOOKUP_CAP: usize = 50;

fn bad() -> Error {
    Error::new("Invalid Commitments tool input")
}

fn candidate_id(input: &Value) -> Result<&str> {
    input["candidateId"]
        .as_str()
        .filter(|id| is_uuid(id))
        .ok_or_else(bad)
}

/// The version an approval card names. A later change to the row makes the old approval stale.
fn version_of(row: &Value) -> Result<String> {
    Ok(format!(
        "[[\"{}\",\"{}\"]]",
        row["id"].as_str().ok_or_else(bad)?,
        iso(&row["updated_at"])?
    ))
}

fn list<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let status = match input.get("status") {
        None | Some(Value::Null) => "pending_review",
        Some(v) => v
            .as_str()
            .filter(|s| LIST_STATUSES.contains(s))
            .ok_or_else(bad)?,
    };
    let clock = now(host)?;
    let mut query = Query::select(crate::candidates::status_filter(Some(status), &clock));
    query.order = vec![Order {
        column: "last_seen_at".into(),
        descending: true,
    }];
    let items = Client(host)
        .query(CANDIDATES, &query)?
        .iter()
        .map(|c| {
            Ok(json!({
                "id": c["id"], "kind": c["kind"], "title": c["title"], "status": c["status"],
                "confidence": c["confidence"], "dueLocalDate": c["due_local_date"],
                "counterpartyLabel": c["counterparty_label"], "sourceCount": c["source_count"],
                "lastSeenAt": iso(&c["last_seen_at"])?,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"data":{"items":items}}))
}

fn thread_judgements<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let refs: Vec<String> = input["threadRefs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str().map(str::to_owned))
        .take(THREAD_LOOKUP_CAP)
        .collect();
    let threads = crate::store::judgements_for(host, &refs)?
        .iter()
        .map(|j| Ok(json!({"threadRef": j["thread_ref"], "judgedAt": iso(&j["judged_at"])?, "outcome": j["outcome"]})))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"data":{"threads":threads}}))
}

fn get<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let id = candidate_id(input)?;
    let Some(c) = find(host, id)? else {
        return Ok(json!({"data":{"error":"Not found"}}));
    };
    let mut query = Query::select(Filter::eq("candidate_id", id));
    query.order = vec![Order {
        column: "created_at".into(),
        descending: false,
    }];
    let evidence = Client(host)
        .query(SOURCES, &query)?
        .iter()
        .map(|e| {
            Ok(
                json!({"sourceKind": e["source_kind"], "evidenceExcerpt": e["evidence_excerpt"],
                      "occurredAt": iso_or_null(&e["occurred_at"])?}),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let dto = candidate_dto(&c)?;
    Ok(json!({"data":{
        "id": dto["id"], "kind": dto["kind"], "title": dto["title"], "status": dto["status"],
        "confidence": dto["confidence"], "dueLocalDate": dto["dueLocalDate"],
        "counterpartyLabel": dto["counterpartyLabel"], "sourceCount": dto["sourceCount"],
        "hasResolutionRef": dto["hasResolutionRef"], "evidence": evidence,
    }}))
}

/// Moves one candidate to a new status once the approval version still matches the row.
fn change<H: Host + ?Sized>(
    host: &H,
    input: &Value,
    status: &str,
    approval: Option<&str>,
) -> Result<Value> {
    let id = candidate_id(input)?;
    let until = if status == "snoozed" {
        let text = input["snoozedUntil"].as_str().ok_or_else(bad)?;
        chrono::DateTime::parse_from_rfc3339(text).map_err(|_| bad())?;
        Some(text.to_owned())
    } else {
        None
    };
    let current = find(host, id)?.ok_or_else(|| Error::new("Candidate not found"))?;
    if approval != Some(version_of(&current)?.as_str()) {
        return Err(Error::new("The candidate changed since approval"));
    }
    let updated = Client(host).query(
        CANDIDATES,
        &Query::update(
            Filter::And {
                filters: vec![
                    Filter::eq("id", id),
                    compare("updated_at", Compare::Eq, current["updated_at"].clone()),
                ],
            },
            values(vec![
                ("status", json!(status)),
                (
                    "snoozed_until",
                    until.clone().map_or(Value::Null, Value::String),
                ),
                ("updated_at", json!(now(host)?)),
            ]),
        ),
    )?;
    let row = updated
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("The candidate changed since approval"))?;
    let mut data = json!({"id": row["id"], "status": row["status"]});
    if let Some(until) = until {
        data["snoozedUntil"] = json!(until);
    }
    Ok(json!({"data": data}))
}

pub fn handle<H: Host + ?Sized>(host: &H, payload: &str) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Tool {
        tool: String,
        parameters: Value,
        #[serde(default, rename = "approvalVersion")]
        approval_version: Option<String>,
    }
    let tool: Tool = serde_json::from_str(payload)?;
    let (p, approval) = (&tool.parameters, tool.approval_version.as_deref());
    match tool.tool.as_str() {
        "commitments.heartbeatOpen" => crate::heartbeat::open(host, p),
        "commitments.list" => list(host, p),
        "commitments.threadJudgements" => thread_judgements(host, p),
        "commitments.get" => get(host, p),
        "commitments.accept" => change(host, p, "accepted", approval),
        "commitments.reject" => change(host, p, "rejected", approval),
        "commitments.snooze" => change(host, p, "snoozed", approval),
        _ => Err(Error::new("Unknown Commitments tool")),
    }
}

/// `prepareCommitmentAction`: the approval card for one change, built from the stored row. It
/// never changes data.
pub fn prepare<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let id = candidate_id(input)?;
    let action = input["action"].as_str().ok_or_else(bad)?;
    let current = find(host, id)?.ok_or_else(|| Error::new("Candidate not found"))?;
    let mut fields = Vec::new();
    match action {
        "accept" | "reject" => {}
        "snooze" => {
            let until = input["snoozedUntil"].as_str().ok_or_else(bad)?;
            fields.push(json!({"label":"Snooze until","value":until}));
        }
        _ => return Err(bad()),
    }
    Ok(json!({"target": current["title"], "fields": fields, "version": version_of(&current)?}))
}

/// Adapt the chat host's common envelope to the saved-record card builder.
pub fn prepare_chat<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    let action = match input["tool"].as_str() {
        Some("commitments.accept") => "accept",
        Some("commitments.reject") => "reject",
        Some("commitments.snooze") => "snooze",
        _ => return Err(bad()),
    };
    let mut parameters = input["parameters"].as_object().ok_or_else(bad)?.clone();
    parameters.insert("action".into(), json!(action));
    if action == "snooze" {
        chrono::DateTime::parse_from_rfc3339(parameters["snoozedUntil"].as_str().ok_or_else(bad)?)
            .map_err(|_| bad())?;
    }
    let mut card = prepare(host, &Value::Object(parameters))?;
    let label = match action {
        "accept" => "Accept suggestion",
        "reject" => "Reject suggestion",
        _ => "Snooze suggestion",
    };
    card["fields"]
        .as_array_mut()
        .ok_or_else(bad)?
        .insert(0, json!({"label":"Action","value":label}));
    Ok(card)
}
