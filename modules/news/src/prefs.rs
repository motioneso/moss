//! Saved source and topic choices (`news_prefs`).
use crate::util::{bad_request, id_param, iso, values};
use crate::{catalog, domain, input, personalization};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const TABLE: &str = "app.news_prefs";

fn dto(row: &Value) -> Result<Value> {
    let bad = || Error::new("Invalid news row");
    let text = |key: &str| row[key].as_str().ok_or_else(bad);
    Ok(json!({
        "id": text("id")?,
        "kind": text("kind")?,
        "key": text("key")?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

/// `GET /prefs`.
pub fn list<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    let rows = Client(host).query(TABLE, &query)?;
    let prefs = rows.iter().map(dto).collect::<Result<Vec<_>>>()?;
    Ok(Response::new(200, json!({"prefs":prefs})))
}

fn find<H: Host + ?Sized>(host: &H, kind: &str, key: &str) -> Result<Option<Value>> {
    let mut query =
        Query::select(Filter::And { filters: vec![Filter::eq("kind", kind), Filter::eq("key", key)] });
    query.limit = Some(1);
    Ok(Client(host).query(TABLE, &query)?.into_iter().next())
}

/// `POST /prefs`. A repeat returns the row already there.
pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let (kind, key) = match input::new_pref(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    if kind == "topic" {
        if !catalog::is_topic(&key) {
            return Ok(bad_request(format!("Unknown topic: {key}")));
        }
    } else if catalog::source(&key).is_none() {
        return Ok(bad_request(format!("Unknown source: {key}")));
    }
    let row = match find(host, &kind, &key)? {
        Some(row) => row,
        None => {
            let mut insert =
                Query::insert(values(vec![("kind", json!(kind)), ("key", json!(key))]));
            insert.conflict = Conflict::Ignore;
            Client(host).query(TABLE, &insert)?;
            find(host, &kind, &key)?.ok_or_else(|| Error::new("Pref could not be saved"))?
        }
    };
    if kind == "source_exclude" {
        let homepage = catalog::source(&key).map(|s| s.homepage_url).unwrap_or_default();
        if let Some(host_name) = domain::host_of(homepage) {
            personalization::prune_snapshot(host, &host_name)?;
        }
    }
    Ok(Response::new(200, json!({"pref":dto(&row)?})))
}

/// `DELETE /prefs/:id`.
pub fn remove<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let removed = Client(host).query(TABLE, &Query::delete(Filter::eq("id", id)))?;
    Ok(Response::new(200, json!({"ok":!removed.is_empty()})))
}
