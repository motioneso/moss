//! Therapy notes (`app.wellness_therapy_notes`). Note text stays in the owner's rows. It is never
//! written to logs, job parameters or activity, and no model port is used.
use crate::{
    taxonomy::CORES,
    util::{bad_request, error, is_uuid, iso},
};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const NOTES: &str = "app.wellness_therapy_notes";

/// One note in the shape the old routes returned.
pub fn dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid therapy note row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "ownerUserId": text("owner_user_id")?,
        "body": text("body")?,
        "linkedCheckinId": row["linked_checkin_id"],
        "linkedEmotion": row["linked_emotion"],
        "createdAt": iso(&row["created_at"])?,
        "updatedAt": iso(&row["updated_at"])?,
    }))
}

/// `GET /wellness/therapy-notes`. Newest first.
pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    let rows = Client(host).query(NOTES, &query)?;
    let notes = rows.iter().map(dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"notes": notes})))
}

struct Draft {
    body: String,
    linked_checkin_id: Option<String>,
    linked_emotion: Option<String>,
}

fn parse(body: &Value) -> std::result::Result<Draft, String> {
    let map = body.as_object().ok_or("Expected JSON object body")?;
    if !map.contains_key("body") {
        return Err("body must have required property 'body'".into());
    }
    let text = match map.get("body") {
        Some(Value::String(t)) if !t.trim().is_empty() => t.trim().to_owned(),
        _ => return Err("body is required".into()),
    };
    let linked_checkin_id = match map.get("linkedCheckinId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.clone()),
        Some(_) => return Err("linkedCheckinId must be a UUID string or null".into()),
    };
    let linked_emotion = match map.get("linkedEmotion") {
        None | Some(Value::Null) => None,
        Some(Value::String(core)) if CORES.contains(&core.as_str()) => Some(core.clone()),
        Some(_) => return Err(format!("linkedEmotion must be one of {}", CORES.join(", "))),
    };
    Ok(Draft { body: text, linked_checkin_id, linked_emotion })
}

/// Whether the caller owns the named check-in. Another person's row is invisible, so a missing
/// row and a foreign row give the same answer.
fn owns_checkin<H: Host + ?Sized>(host: &H, id: &str) -> Result<bool> {
    if !is_uuid(id) {
        return Ok(false);
    }
    let mut query = Query::select(Filter::eq("id", id));
    query.limit = Some(1);
    Ok(!Client(host).query(crate::checkins::CHECKINS, &query)?.is_empty())
}

/// `POST /wellness/therapy-notes`.
pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let draft = match parse(&request.body) {
        Ok(draft) => draft,
        Err(message) => return Ok(bad_request(message)),
    };
    if let Some(id) = &draft.linked_checkin_id {
        if !owns_checkin(host, id)? {
            return Ok(error(404, "linked check-in not found"));
        }
    }
    let values = crate::util::values(vec![
        ("body", json!(draft.body)),
        ("linked_checkin_id", json!(draft.linked_checkin_id)),
        ("linked_emotion", json!(draft.linked_emotion)),
    ]);
    let row = Client(host)
        .query(NOTES, &Query::insert(values))?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("Therapy note could not be saved"))?;
    Ok(Response::new(201, json!({"note": dto(&row)?})))
}

/// `DELETE /wellness/therapy-notes/:id`.
pub fn remove<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default();
    if !is_uuid(id) {
        return Ok(error(404, "Therapy note not found"));
    }
    let gone = Client(host).query(NOTES, &Query::delete(Filter::eq("id", id)))?;
    if gone.is_empty() {
        return Ok(error(404, "Therapy note not found"));
    }
    Ok(Response::new(200, json!({"deleted": true})))
}
