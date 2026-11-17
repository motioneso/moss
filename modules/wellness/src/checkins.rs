//! Check-in create, list and change (`app.wellness_checkins`).
use crate::{
    cursor, input,
    util::{bad_request, error, iso, iso_micros, values},
};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const CHECKINS: &str = "app.wellness_checkins";

fn dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid check-in row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "ownerUserId": text("owner_user_id")?,
        "checkedInAt": iso(&row["checked_in_at"])?,
        "feelingCore": text("feeling_core")?,
        "feelingSecondary": row["feeling_secondary"],
        "feelingTertiary": row["feeling_tertiary"],
        "wheelVersion": text("wheel_version")?,
        "sensations": row["sensations"],
        "intensity": row["intensity"],
        "energy": row["energy"],
        "note": row["note"],
        "identifiedVia": text("identified_via")?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

fn find<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq("id", id));
    query.limit = Some(1);
    Ok(Client(host).query(CHECKINS, &query)?.into_iter().next())
}

fn or_null<T: Into<Value>>(value: Option<T>) -> Value {
    value.map_or(Value::Null, Into::into)
}

/// `POST /wellness/checkins`. The calendar day and zone offset are the person's own at this moment.
pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let data = match input::checkin(&request.body, true) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let day = host.call("context", "local-date", "account", json!({}))?;
    let pairs = vec![
        ("feeling_core", json!(data.feeling_core)),
        ("feeling_secondary", or_null(data.feeling_secondary.flatten())),
        ("feeling_tertiary", Value::Null),
        ("sensations", json!(data.sensations.unwrap_or_default())),
        ("intensity", or_null(data.intensity.flatten())),
        ("energy", or_null(data.energy.flatten())),
        ("note", or_null(data.note.flatten())),
        ("identified_via", json!(data.identified_via.as_deref().unwrap_or("wheel"))),
        ("local_date", day["date"].clone()),
        ("timezone_offset", day["offsetMinutes"].clone()),
    ];
    let row = Client(host)
        .query(CHECKINS, &Query::insert(values(pairs)))?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("Check-in could not be saved"))?;
    Ok(Response::new(201, json!({"checkin": dto(&row)?})))
}

/// Anything the old server's date parser read as a moment is a moment here.
fn parse_since(text: &str) -> Option<DateTime<Utc>> {
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Some(at.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc())
}

fn query_text(request: &RouteRequest, name: &str) -> Option<String> {
    match request.query.get(name)? {
        Value::String(t) => Some(t.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

/// `GET /wellness/checkins`. Newest first, one page at a time.
pub fn list<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let since = match query_text(request, "since").filter(|t| !t.is_empty()) {
        None => None,
        Some(text) => match parse_since(&text) {
            Some(at) => Some(at.to_rfc3339_opts(SecondsFormat::Millis, true)),
            None => return Ok(bad_request("since must be an ISO timestamp")),
        },
    };
    let limit = match query_text(request, "limit").filter(|t| !t.is_empty()) {
        None => 50,
        Some(text) => match text.trim().parse::<f64>() {
            Ok(n) if n.fract() == 0.0 && (1.0..=500.0).contains(&n) => n as u32,
            _ => return Ok(bad_request("limit must be 1\u{2013}500")),
        },
    };
    if let Some(Value::Array(_) | Value::Object(_) | Value::Number(_) | Value::Bool(_)) = request.query.get("cursor") {
        return Ok(bad_request("cursor must be a string"));
    }
    let page_start = match query_text(request, "cursor") {
        None => None,
        Some(token) => match cursor::parse(&token, since.as_deref()) {
            Ok(parsed) => Some(parsed),
            Err(message) => return Ok(bad_request(message)),
        },
    };
    let mut filters = Vec::new();
    if let Some(at) = &since {
        filters.push(Filter::Compare { column: "checked_in_at".into(), op: Compare::Ge, value: json!(at) });
    }
    if let Some(start) = &page_start {
        let earlier = Filter::Compare { column: "checked_in_at".into(), op: Compare::Lt, value: json!(start.checked_in_at) };
        let same_moment = Filter::And {
            filters: vec![
                Filter::eq("checked_in_at", start.checked_in_at.as_str()),
                Filter::Compare { column: "id".into(), op: Compare::Lt, value: json!(start.id) },
            ],
        };
        filters.push(Filter::Or { filters: vec![earlier, same_moment] });
    }
    let mut query = Query::select(if filters.is_empty() { Filter::All } else { Filter::And { filters } });
    query.order = vec![
        Order { column: "checked_in_at".into(), descending: true },
        Order { column: "id".into(), descending: true },
    ];
    query.limit = Some(limit + 1);
    let rows = Client(host).query(CHECKINS, &query)?;
    let page = &rows[..rows.len().min(limit as usize)];
    let next = match (rows.len() > limit as usize, page.last()) {
        (true, Some(last)) => {
            let id = last["id"].as_str().ok_or_else(|| Error::new("Invalid check-in row"))?;
            Value::String(cursor::token(&iso_micros(&last["checked_in_at"])?, id, since.as_deref()))
        }
        _ => Value::Null,
    };
    let checkins = page.iter().map(dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"checkins": checkins, "nextCursor": next})))
}

/// `PATCH /wellness/checkins/:id`. The third level of the wheel is always cleared.
pub fn change<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = request.params.get("id").map(String::as_str).unwrap_or_default().to_owned();
    let data = match input::checkin(&request.body, false) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let Some(existing) = find(host, &id)? else {
        return Ok(error(404, "Check-in not found"));
    };
    let secondary = match &data.feeling_secondary {
        Some(chosen) => chosen.clone(),
        None => existing["feeling_secondary"].as_str().map(str::to_owned),
    };
    if !crate::taxonomy::valid_path(&data.feeling_core, secondary.as_deref(), None) {
        return Ok(bad_request(format!(
            "feelingSecondary '{}' is not valid under feelingCore '{}'",
            secondary.as_deref().unwrap_or("null"),
            data.feeling_core
        )));
    }
    let mut pairs = vec![("feeling_core", json!(data.feeling_core)), ("feeling_tertiary", Value::Null)];
    if let Some(v) = data.feeling_secondary { pairs.push(("feeling_secondary", or_null(v))); }
    if let Some(v) = data.sensations { pairs.push(("sensations", json!(v))); }
    if let Some(v) = data.intensity { pairs.push(("intensity", or_null(v))); }
    if let Some(v) = data.energy { pairs.push(("energy", or_null(v))); }
    if let Some(v) = data.note { pairs.push(("note", or_null(v))); }
    let row = Client(host)
        .query(CHECKINS, &Query::update(Filter::eq("id", id.as_str()), values(pairs)))?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("Check-in could not be changed"))?;
    Ok(Response::new(200, json!({"checkin": dto(&row)?})))
}
