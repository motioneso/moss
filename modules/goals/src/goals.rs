//! Goal list, create, change, close and evidence (`app.moss_goals`, `app.moss_goal_evidence`).
use crate::input;
use crate::util::{bad_request, error, id_param, iso, iso_or_null, values};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const GOALS: &str = "app.moss_goals";
pub const EVIDENCE: &str = "app.moss_goal_evidence";

fn goal_dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid goal row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "ownerUserId": text("owner_user_id")?,
        "title": text("title")?,
        "desiredOutcome": text("desired_outcome")?,
        "status": text("status")?,
        "priority": row["priority"],
        "reviewCadence": text("review_cadence")?,
        "nextReviewAt": iso_or_null(&row["next_review_at"])?,
        "targetAt": iso_or_null(&row["target_at"])?,
        "lastProgressSummary": row["last_progress_summary"],
        "lastProgressAt": iso_or_null(&row["last_progress_at"])?,
        "blockerSummary": row["blocker_summary"],
        "nextSuggestedAction": row["next_suggested_action"],
        "createdAt": iso(&row["created_at"])?,
        "updatedAt": iso(&row["updated_at"])?,
        "completedAt": iso_or_null(&row["completed_at"])?,
        "archivedAt": iso_or_null(&row["archived_at"])?,
    }))
}

fn evidence_dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid goal row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "ownerUserId": text("owner_user_id")?,
        "goalId": text("goal_id")?,
        "evidenceKind": text("evidence_kind")?,
        "sourceKind": text("source_kind")?,
        "sourceRef": row["source_ref"],
        "sourceLabel": text("source_label")?,
        "summary": text("summary")?,
        "occurredAt": iso_or_null(&row["occurred_at"])?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

fn find<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq("id", id));
    query.limit = Some(1);
    Ok(Client(host).query(GOALS, &query)?.into_iter().next())
}

fn now<H: Host + ?Sized>(host: &H) -> Result<String> {
    let context = host.call("context", "read", "call", json!({}))?;
    context["now"].as_str().map(str::to_owned).ok_or_else(|| Error::new("Host clock unavailable"))
}

/// `GET /goals`. The old handler returned the array itself.
pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "priority".into(), descending: true },
        Order { column: "created_at".into(), descending: true },
    ];
    let rows = Client(host).query(GOALS, &query)?;
    let goals = rows.iter().map(goal_dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, Value::Array(goals)))
}

/// `GET /goals/:id`.
pub fn get<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    match find(host, id)? {
        Some(row) => Ok(Response::new(200, goal_dto(&row)?)),
        None => Ok(error(404, "Goal not found")),
    }
}

/// `POST /goals`.
pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let data = match input::new_goal(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let row = Client(host).query(
        GOALS,
        &Query::insert(values(vec![
            ("title", json!(data.title)),
            ("desired_outcome", json!(data.desired_outcome)),
            ("priority", json!(data.priority.unwrap_or(3))),
            ("review_cadence", json!(data.review_cadence.as_deref().unwrap_or("weekly"))),
            ("target_at", data.target_at.map(Value::String).unwrap_or(Value::Null)),
        ])),
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::new("Goal could not be saved"))?;
    Ok(Response::new(201, goal_dto(&row)?))
}

/// `PATCH /goals/:id`. Sending a status of completed or archived closes the goal. Clearing a
/// text field stores an empty string, as the old server did.
pub fn change<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id.to_owned(),
        Err(refusal) => return Ok(refusal),
    };
    let data = match input::goal_change(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let mut pairs: Vec<(&str, Value)> = vec![("updated_at", json!(now(host)?))];
    if let Some(v) = data.title { pairs.push(("title", json!(v))); }
    if let Some(v) = data.desired_outcome { pairs.push(("desired_outcome", json!(v))); }
    if let Some(v) = data.status { pairs.push(("status", json!(v))); }
    if let Some(v) = data.priority { pairs.push(("priority", json!(v))); }
    if let Some(v) = data.review_cadence { pairs.push(("review_cadence", json!(v))); }
    if let Some(v) = data.target_at { pairs.push(("target_at", v.map(Value::String).unwrap_or(Value::Null))); }
    if let Some(v) = data.last_progress_summary { pairs.push(("last_progress_summary", v.map(Value::String).unwrap_or_else(|| json!("")))); }
    if let Some(v) = data.blocker_summary { pairs.push(("blocker_summary", v.map(Value::String).unwrap_or_else(|| json!("")))); }
    if let Some(v) = data.next_suggested_action { pairs.push(("next_suggested_action", v.map(Value::String).unwrap_or_else(|| json!("")))); }
    let updated = Client(host).query(GOALS, &Query::update(Filter::eq("id", id.as_str()), values(pairs)))?;
    let row = updated.into_iter().next().ok_or_else(|| Error::new("Failed to update goal"))?;
    Ok(Response::new(200, goal_dto(&row)?))
}

/// `POST /goals/:id/evidence`. A closed goal (completed or archived) refuses new evidence.
pub fn add_evidence<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id.to_owned(),
        Err(refusal) => return Ok(refusal),
    };
    let data = match input::new_evidence(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let goal = find(host, &id)?.ok_or_else(|| Error::new("Failed to add evidence"))?;
    if matches!(goal["status"].as_str(), Some("completed") | Some("archived")) {
        return Ok(error(409, "Goal is closed"));
    }
    let row = Client(host).query(
        EVIDENCE,
        &Query::insert(values(vec![
            ("goal_id", json!(id)),
            ("evidence_kind", json!(data.evidence_kind)),
            ("source_kind", json!(data.source_kind)),
            ("source_ref", data.source_ref.map(Value::String).unwrap_or(Value::Null)),
            ("source_label", json!(data.source_label)),
            ("summary", json!(data.summary)),
            ("occurred_at", data.occurred_at.map(Value::String).unwrap_or(Value::Null)),
        ])),
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::new("Evidence could not be saved"))?;
    // The old handler bumped the goal's updated time after adding evidence.
    Client(host).query(GOALS, &Query::update(Filter::eq("id", id.as_str()), values(vec![("updated_at", json!(now(host)?))])))?;
    Ok(Response::new(201, evidence_dto(&row)?))
}
