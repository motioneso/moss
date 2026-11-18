//! Briefing definitions. Reads and edits run as the signed-in person under row level security,
//! so a share viewer sees a definition and only a manager can change it.
use crate::body::{self, Definition};
use crate::schedule::{self, Metadata, Scheduled};
use crate::util::{bad_request, call, iso, iso_or_null, new_id, owner_zone, values};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const TABLE: &str = "app.briefing_definitions";

/// One definition row as the public shape.
pub fn dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid briefing definition row");
    let text = |key: &str| row[key].as_str().map(str::to_owned).ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "ownerUserId": text("owner_user_id")?,
        "title": text("title")?,
        "briefingType": text("briefing_type")?,
        "cadence": text("cadence")?,
        "scheduleMetadata": row["schedule_metadata"],
        "enabled": row["enabled"].as_bool().ok_or_else(bad)?,
        "selectedToolNames": row["selected_tool_names"],
        "lastRunAt": iso_or_null(&row["last_run_at"])?,
        "createdAt": iso(&row["created_at"])?,
        "updatedAt": iso(&row["updated_at"])?,
    }))
}

fn metadata_of(row: &Value) -> Metadata {
    row["schedule_metadata"].as_object().cloned().unwrap_or_default()
}

fn reconcile_row<H: Host + ?Sized>(host: &H, row: &Value, zone: Option<&str>, keep: bool) {
    let metadata = metadata_of(row);
    let definition = Scheduled {
        id: row["id"].as_str().unwrap_or_default(),
        briefing_type: row["briefing_type"].as_str().unwrap_or("morning"),
        cadence: row["cadence"].as_str().unwrap_or("manual"),
        enabled: row["enabled"].as_bool().unwrap_or(false),
        metadata: &metadata,
    };
    schedule::reconcile_quietly(host, &definition, zone, keep);
}

pub fn find<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq("id", id));
    query.limit = Some(1);
    Ok(Client(host).query(TABLE, &query)?.into_iter().next())
}

/// The caller's own newest-updated definition of one type. A definition shared with them never
/// counts, because the list also holds those.
pub fn owned_of_type<H: Host + ?Sized>(host: &H, actor: &str, kind: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::And {
        filters: vec![Filter::eq("owner_user_id", actor), Filter::eq("briefing_type", kind)],
    });
    query.order = vec![
        Order { column: "updated_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    query.limit = Some(1);
    Ok(Client(host).query(TABLE, &query)?.into_iter().next())
}

pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "updated_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    let rows = Client(host).query(TABLE, &query)?;
    // Self-heal. Only the caller's own definitions are scheduled, because the list also
    // holds definitions shared with them.
    let context = call(host)?;
    let zone = owner_zone(host, &context.now);
    for row in rows.iter().filter(|r| r["owner_user_id"].as_str() == Some(context.actor.as_str())) {
        reconcile_row(host, row, zone.as_deref(), true);
    }
    let definitions = rows.iter().map(dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"definitions":definitions,"externalSources":[]})))
}

pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let input = match body::parse(&request.body, true) {
        Ok(input) => input,
        Err(failure) => return Ok(bad_request(failure)),
    };
    let context = call(host)?;
    let zone = owner_zone(host, &context.now);
    let kind = input.briefing_type.clone().unwrap_or_else(|| "morning".into());
    let metadata = match (input.schedule_metadata.clone(), zone.as_deref()) {
        (None, Some(zone)) => schedule::default_metadata_for(&kind, zone),
        (None, None) => schedule::default_metadata_for(&kind, "UTC"),
        (Some(mut metadata), Some(zone)) => {
            metadata.entry("timezone").or_insert(Value::String(zone.to_owned()));
            metadata
        }
        (Some(metadata), None) => metadata,
    };
    let insert = Query::insert(values(vec![
        ("id", json!(new_id(host)?)),
        ("title", json!(input.title)),
        ("briefing_type", json!(kind)),
        ("cadence", json!(input.cadence.clone().unwrap_or_else(|| "manual".into()))),
        ("schedule_metadata", Value::Object(metadata)),
        ("enabled", json!(input.enabled.unwrap_or(true))),
        ("selected_tool_names", json!(input.selected_tool_names)),
        ("last_run_at", Value::Null),
        ("created_at", json!(context.now)),
        ("updated_at", json!(context.now)),
    ]));
    let row = Client(host)
        .query(TABLE, &insert)?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("Briefing definition was not saved"))?;
    reconcile_row(host, &row, zone.as_deref(), false);
    Ok(Response::new(201, json!({"definition":dto(&row)?})))
}

pub fn update<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let input = match body::parse(&request.body, false) {
        Ok(input) => input,
        Err(failure) => return Ok(bad_request(failure)),
    };
    let id = request.params.get("id").cloned().unwrap_or_default();
    let context = call(host)?;
    let Definition {
        title,
        briefing_type,
        cadence,
        schedule_metadata,
        enabled,
        selected_tool_names,
    } = input;
    let mut set = vec![("updated_at", json!(context.now))];
    if let Some(v) = title {
        set.push(("title", json!(v)));
    }
    if let Some(v) = briefing_type {
        set.push(("briefing_type", json!(v)));
    }
    if let Some(v) = cadence {
        set.push(("cadence", json!(v)));
    }
    if let Some(v) = schedule_metadata {
        set.push(("schedule_metadata", Value::Object(v)));
    }
    if let Some(v) = enabled {
        set.push(("enabled", json!(v)));
    }
    if let Some(v) = selected_tool_names {
        set.push(("selected_tool_names", json!(v)));
    }
    let changed = Client(host).query(TABLE, &Query::update(Filter::eq("id", id.as_str()), values(set)))?;
    let Some(row) = changed.into_iter().next() else {
        return Ok(Response::new(404, json!({"error":"Briefing definition not found"})));
    };
    // A manager through a share edits the definition but never moves the owner's schedule.
    if row["owner_user_id"].as_str() == Some(context.actor.as_str()) {
        let zone = owner_zone(host, &context.now);
        reconcile_row(host, &row, zone.as_deref(), false);
    }
    Ok(Response::new(200, json!({"definition":dto(&row)?})))
}
