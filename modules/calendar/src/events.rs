use crate::{query, Result};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Host,
};
use serde_json::{json, Value};

pub const TABLE: &str = "app.calendar_events";

/// Match serializeCalendarEvent without forwarding private provider metadata.
pub fn serialize(row: &Value) -> Value {
    let md = &row["external_metadata"];
    let legacy = row["external_id"].as_str().is_some_and(|id| {
        id.len() == 35
            && id.starts_with("jfb")
            && id[3..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'v').contains(&b))
    });
    let mirror = md["source"] == "outlook-browser-calendar";
    let created = md["jarvisCreated"] == true || (md.get("jarvisCreated").is_none() && legacy);
    let mut out = json!({
        "isMossBlock":!mirror && created,"readOnly":mirror,"unconfirmed":md["mirrorUnconfirmed"]==true,
        "allDay":md["allDay"]==true,"attendeeCount":md["attendeeCount"].as_f64().unwrap_or(0.0),
        "status":md["status"].as_str(),
    });
    for (source, target) in [
        ("id", "id"),
        ("connector_account_id", "connectorAccountId"),
        ("owner_user_id", "ownerUserId"),
        ("title", "title"),
        ("starts_at", "startsAt"),
        ("ends_at", "endsAt"),
        ("location", "location"),
        ("summary", "summary"),
        ("body_excerpt", "bodyExcerpt"),
        ("external_id", "externalId"),
        ("created_at", "createdAt"),
        ("updated_at", "updatedAt"),
    ] {
        out[target] = row[source].clone();
    }
    // PostgreSQL JSON timestamps are strings; the old driver returned Date objects.
    for field in ["startsAt", "endsAt", "createdAt", "updatedAt"] {
        if let Some(value) = out[field].as_str() {
            if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
                out[field] = json!(date
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
        }
    }
    out
}
pub fn list(host: &impl Host) -> Result<Vec<Value>> {
    let mut rows = vec![];
    loop {
        let q = Query {
            order: vec![
                Order {
                    column: "starts_at".into(),
                    descending: false,
                },
                Order {
                    column: "id".into(),
                    descending: false,
                },
            ],
            limit: Some(1000),
            offset: rows.len() as u32,
            ..Query::default()
        };
        let page = query(host, TABLE, &q)?;
        let done = page.len() < 1000;
        rows.extend(page.iter().map(serialize));
        if done {
            return Ok(rows);
        }
    }
}
pub fn get(host: &impl Host, id: &str) -> Result<Option<Value>> {
    let mut q = Query::select(Filter::eq("id", id));
    q.limit = Some(1);
    Ok(query(host, TABLE, &q)?.first().map(serialize))
}

/// Cached rows Moss created for one follow-through reference, ordered by id. A row counts
/// only when `jarvisCreated` is true and the stored reference matches exactly.
pub fn follow_through(host: &impl Host, target_ref: &str) -> Result<Vec<Value>> {
    let mut found = vec![];
    let mut offset = 0;
    loop {
        let q = Query {
            order: vec![Order {
                column: "id".into(),
                descending: false,
            }],
            limit: Some(1000),
            offset,
            ..Query::default()
        };
        let page = query(host, TABLE, &q)?;
        offset += page.len() as u32;
        let done = page.len() < 1000;
        found.extend(page.into_iter().filter(|row| {
            let md = &row["external_metadata"];
            md["jarvisCreated"] == true && md["followThroughTargetRef"] == target_ref
        }));
        if done {
            return Ok(found);
        }
    }
}
