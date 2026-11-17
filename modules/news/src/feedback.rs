//! Story feedback (`news_story_feedback`): "more" or "less like this" for a story on the
//! person's own page. A story marked "less" is left out of every read of the page.
use crate::compile::stored_page;
use crate::util::{bad_request, error, id_param, iso, js_trim, values};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Map, Value};

pub const TABLE: &str = "app.news_story_feedback";
const LESS: &str = "less_like_this";
const REASON_MAX: usize = 500;
/// The host returns at most this many rows. The newest marks win past it.
const HIDDEN_MAX: u32 = 1000;

fn dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid news row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "storyRef": text("story_ref")?,
        "kind": text("kind")?,
        "reason": row["reason"].as_str(),
        "createdAt": iso(&row["created_at"])?,
        "updatedAt": iso(&row["updated_at"])?,
    }))
}

/// Story references the person marked "less like this". Read on every page read, so a page
/// stored before the mark still hides the story.
pub fn dismissed<H: Host + ?Sized>(host: &H) -> Result<Vec<String>> {
    let mut query = Query::select(Filter::eq("kind", LESS));
    query.order = vec![Order { column: "updated_at".into(), descending: true }];
    query.limit = Some(HIDDEN_MAX);
    let rows = Client(host).query(TABLE, &query)?;
    Ok(rows.iter().filter_map(|row| row["story_ref"].as_str().map(str::to_owned)).collect())
}

fn object(body: &Value) -> std::result::Result<&Map<String, Value>, String> {
    body.as_object().ok_or_else(|| "body must be object".to_owned())
}

/// An optional reason of at most 500 characters. Empty text clears it.
fn reason(map: &Map<String, Value>) -> std::result::Result<Option<String>, String> {
    match map.get("reason") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let text = js_trim(text);
            if text.chars().count() > REASON_MAX {
                return Err(format!("body/reason must NOT have more than {REASON_MAX} characters"));
            }
            Ok((!text.is_empty()).then(|| text.to_owned()))
        }
        Some(_) => Err("body/reason must be string".into()),
    }
}

fn find<H: Host + ?Sized>(host: &H, filter: Filter) -> Result<Option<Value>> {
    let mut query = Query::select(filter);
    query.limit = Some(1);
    Ok(Client(host).query(TABLE, &query)?.into_iter().next())
}

/// `GET /story-feedback`.
pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "updated_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    let rows = Client(host).query(TABLE, &query)?;
    let feedback = rows.iter().map(dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"feedback":feedback})))
}

/// `POST /story-feedback`. One row per story, so a repeat replaces the earlier choice. A story
/// the person's page does not hold, and has no earlier choice on, is refused.
pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let map = match object(&request.body) {
        Ok(map) => map,
        Err(message) => return Ok(bad_request(message)),
    };
    let story = map.get("storyRef").and_then(Value::as_str).unwrap_or_default();
    if story.is_empty() || story.chars().count() > 128 {
        return Ok(bad_request("body/storyRef must be a story reference"));
    }
    let kind = match map.get("kind").and_then(Value::as_str) {
        Some(kind @ ("more_like_this" | LESS)) => kind,
        _ => return Ok(bad_request("body/kind must be equal to one of the allowed values")),
    };
    let reason = match reason(map) {
        Ok(reason) => reason,
        Err(message) => return Ok(bad_request(message)),
    };
    let known = find(host, Filter::eq("story_ref", story))?.is_some() || {
        let (page, _) = stored_page(host)?;
        page["rankedStories"].as_array().is_some_and(|rows| rows.iter().any(|row| row["id"] == story))
    };
    if !known {
        return Ok(error(404, "Story was not found"));
    }
    let now = crate::util::now(host)?.to_rfc3339();
    let set = || {
        values(vec![
            ("story_ref", json!(story)),
            ("kind", json!(kind)),
            ("reason", json!(reason)),
            ("updated_at", json!(now)),
        ])
    };
    let mut insert = Query::insert(set());
    insert.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "story_ref".into()],
        values: set(),
    };
    Client(host).query(TABLE, &insert)?;
    let row = find(host, Filter::eq("story_ref", story))?.ok_or_else(|| Error::new("Feedback could not be saved"))?;
    Ok(Response::new(200, json!({"feedback":dto(&row)?})))
}

/// `PATCH /story-feedback/:id`. Changes only the reason.
pub fn change_reason<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let map = match object(&request.body) {
        Ok(map) => map,
        Err(message) => return Ok(bad_request(message)),
    };
    let reason = match reason(map) {
        Ok(reason) => reason,
        Err(message) => return Ok(bad_request(message)),
    };
    let now = crate::util::now(host)?.to_rfc3339();
    let changed = Client(host).query(
        TABLE,
        &Query::update(Filter::eq("id", id), values(vec![("reason", json!(reason)), ("updated_at", json!(now))])),
    )?;
    match changed.first() {
        Some(row) => Ok(Response::new(200, json!({"feedback":dto(row)?}))),
        None => Ok(error(404, "Feedback was not found")),
    }
}

/// `POST /story-feedback/:id/undo`. Removes the choice, so a hidden story returns.
pub fn undo<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let removed = Client(host).query(TABLE, &Query::delete(Filter::eq("id", id)))?;
    if removed.is_empty() {
        return Ok(error(404, "Feedback was not found"));
    }
    Ok(Response::new(200, json!({"ok":true})))
}
