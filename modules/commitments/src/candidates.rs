//! Candidate list, read, status, resolve and suppress (`app.commitment_candidates`, with
//! evidence read from `app.commitment_candidate_sources`).
use crate::input;
use crate::util::{error, id_param, iso, iso_or_null, values};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const CANDIDATES: &str = "app.commitment_candidates";
pub const SOURCES: &str = "app.commitment_candidate_sources";

/// The candidate as the old routes returned it. The resolution reference itself stays in the
/// database. Only whether one exists leaves.
pub(crate) fn candidate_dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid candidate row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    let list = |key: &str| if row[key].is_array() { row[key].clone() } else { json!([]) };
    Ok(json!({
        "id": text("id")?,
        "ownerUserId": text("owner_user_id")?,
        "candidateSignature": text("candidate_signature")?,
        "kind": text("kind")?,
        "title": text("title")?,
        "dueLocalDate": row["due_local_date"],
        "counterpartyLabel": row["counterparty_label"],
        "status": text("status")?,
        "confidence": text("confidence")?,
        "suggestedHandling": row["suggested_handling"],
        "suppressedBy": row["suppressed_by"],
        "sourceCount": row["source_count"],
        "firstSeenAt": iso(&row["first_seen_at"])?,
        "lastSeenAt": iso(&row["last_seen_at"])?,
        "snoozedUntil": iso_or_null(&row["snoozed_until"])?,
        "expiresAt": iso_or_null(&row["expires_at"])?,
        "createdAt": iso(&row["created_at"])?,
        "updatedAt": iso(&row["updated_at"])?,
        "counterpartyPersonId": row["counterparty_person_id"],
        "counterpartyAddress": row["counterparty_address"],
        "proposedActions": list("proposed_actions"),
        "whyLines": list("why_lines"),
        "threadRef": row["thread_ref"],
        "lastJudgedExternalId": row["last_judged_external_id"],
        "stale": row["stale"] == json!(true),
        "hasResolutionRef": !row["resolution_ref"].is_null(),
    }))
}

fn evidence_dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid candidate row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "candidateId": text("candidate_id")?,
        "ownerUserId": text("owner_user_id")?,
        "sourceKind": text("source_kind")?,
        "sourceRef": text("source_ref")?,
        "sourceVersion": row["source_version"],
        "evidenceExcerpt": text("evidence_excerpt")?,
        "occurredAt": iso_or_null(&row["occurred_at"])?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

pub(crate) fn find<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq("id", id));
    query.limit = Some(1);
    Ok(Client(host).query(CANDIDATES, &query)?.into_iter().next())
}

pub(crate) fn now<H: Host + ?Sized>(host: &H) -> Result<String> {
    let context = host.call("context", "read", "call", json!({}))?;
    context["now"].as_str().map(str::to_owned).ok_or_else(|| Error::new("Host clock unavailable"))
}

pub(crate) fn compare(column: &str, op: Compare, value: impl Into<Value>) -> Filter {
    Filter::Compare { column: column.into(), op, value: value.into() }
}

fn not_found() -> Response {
    error(404, "Candidate not found")
}

/// `GET /candidates`. A snooze past its end date counts as pending review again, as before.
pub fn list<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let status = match input::list_filter(request.query.get("status")) {
        Ok(status) => status,
        Err(message) => return Ok(error(400, message)),
    };
    let clock = now(host)?;
    let filter = match status.as_deref() {
        None => Filter::All,
        Some("pending_review") => Filter::Or {
            filters: vec![
                compare("status", Compare::Eq, "pending_review"),
                Filter::And {
                    filters: vec![
                        compare("status", Compare::Eq, "snoozed"),
                        compare("snoozed_until", Compare::Le, clock.as_str()),
                    ],
                },
            ],
        },
        Some("snoozed") => Filter::And {
            filters: vec![
                compare("status", Compare::Eq, "snoozed"),
                Filter::Or {
                    filters: vec![
                        Filter::Null { column: "snoozed_until".into(), not: false },
                        compare("snoozed_until", Compare::Gt, clock.as_str()),
                    ],
                },
            ],
        },
        Some(other) => compare("status", Compare::Eq, other),
    };
    let mut query = Query::select(filter);
    query.order = vec![Order { column: "last_seen_at".into(), descending: true }];
    let rows = Client(host).query(CANDIDATES, &query)?;
    let mut candidates = rows.iter().map(candidate_dto).collect::<Result<Vec<_>>>()?;
    if status.as_deref() == Some("pending_review") {
        for candidate in &mut candidates {
            if candidate["status"] == "snoozed" {
                candidate["status"] = json!("pending_review");
                candidate["snoozedUntil"] = Value::Null;
            }
        }
    }
    Ok(Response::new(200, Value::Array(candidates)))
}

/// `GET /candidates/:id`, with the saved evidence, oldest first.
pub fn get<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let Some(row) = find(host, id)? else { return Ok(error(404, "Not found")) };
    let mut query = Query::select(Filter::eq("candidate_id", id));
    query.order = vec![Order { column: "created_at".into(), descending: false }];
    let evidence = Client(host)
        .query(SOURCES, &query)?
        .iter()
        .map(evidence_dto)
        .collect::<Result<Vec<_>>>()?;
    let mut body = candidate_dto(&row)?;
    body["evidence"] = Value::Array(evidence);
    Ok(Response::new(200, body))
}

/// Sets the status. A snooze date that is not sent clears the old one. The resolution
/// reference is never touched, so a resolved candidate stays resolved.
fn set_status<H: Host + ?Sized>(host: &H, id: &str, status: &str, snoozed_until: Option<String>) -> Result<Response> {
    let updated = Client(host).query(
        CANDIDATES,
        &Query::update(
            Filter::eq("id", id),
            values(vec![
                ("status", json!(status)),
                ("snoozed_until", snoozed_until.map(Value::String).unwrap_or(Value::Null)),
                ("updated_at", json!(now(host)?)),
            ]),
        ),
    )?;
    match updated.into_iter().next() {
        Some(row) => Ok(Response::new(200, candidate_dto(&row)?)),
        None => Ok(not_found()),
    }
}

/// `PATCH /candidates/:id/status`.
pub fn change_status<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id.to_owned(),
        Err(refusal) => return Ok(refusal),
    };
    let data = match input::status_change(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(error(400, message)),
    };
    set_status(host, &id, &data.status, data.snoozed_until)
}

/// `POST /candidates/:id/resolve`. The old server never had a way to check a resolution
/// reference, so it answered 503 for every valid request and saved nothing. This does the same.
pub fn resolve<H: Host + ?Sized>(_host: &H, request: &RouteRequest) -> Result<Response> {
    if let Err(refusal) = id_param(request) {
        return Ok(refusal);
    }
    if let Err(message) = input::resolution_ref(&request.body) {
        return Ok(error(400, message));
    }
    Ok(error(503, "Resolution verifier unavailable"))
}

/// `POST /candidates/:id/suppress`. The driving candidate must be marked explicit non-action.
pub fn suppress<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id.to_owned(),
        Err(refusal) => return Ok(refusal),
    };
    let driver = match input::suppressed_by(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(error(400, message)),
    };
    let found = if crate::util::is_uuid(&driver) { find(host, &driver)? } else { None };
    let Some(driving) = found else { return Ok(error(404, "Suppressor not found")) };
    if driving["status"] != "explicit_non_action" {
        return Ok(error(422, "Suppressor must be explicit_non_action"));
    }
    set_status(host, &id, "explicit_non_action", None)
}
