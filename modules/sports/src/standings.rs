//! The standings picker's saved choices. They live in the person's saved settings under the
//! keys the old app used, so choices made before the move carry over.
use crate::catalog;
use crate::util::bad_request;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Map, Value};

const KEYS: &str = "standings-competitions";
const LAST: &str = "standings-last-viewed";

fn read<H: Host + ?Sized>(host: &H, resource: &str) -> Result<Value> {
    Ok(host.call("kv", "preference.read", resource, json!({}))?["value"].clone())
}

fn write<H: Host + ?Sized>(host: &H, resource: &str, value: Value) -> Result<()> {
    host.call("kv", "preference.write", resource, json!({"value":value}))?;
    Ok(())
}

/// A saved list is shown in catalog order. Anything that is not a list means no choice was made.
fn ordered(stored: &Value) -> Value {
    match stored.as_array() {
        Some(items) => json!(catalog::in_catalog_order(items.iter().filter_map(Value::as_str))),
        None => Value::Null,
    }
}

/// A saved view is read back only when it still names a known competition.
fn last_viewed(stored: &Value) -> Value {
    let Some(map) = stored.as_object() else { return Value::Null };
    let Some(key) = map.get("competitionKey").and_then(Value::as_str).filter(|k| catalog::is_known(k)) else {
        return Value::Null;
    };
    let text = |name: &str| map.get(name).and_then(Value::as_str).map(Value::from).unwrap_or(Value::Null);
    json!({"competitionKey":key,"viewKey":text("viewKey"),"viewLabel":text("viewLabel")})
}

fn current<H: Host + ?Sized>(host: &H) -> Result<Value> {
    Ok(json!({
        "selectedCompetitionKeys": ordered(&read(host, KEYS)?),
        "lastViewed": last_viewed(&read(host, LAST)?),
    }))
}

pub fn get<H: Host + ?Sized>(host: &H) -> Result<Response> {
    Ok(Response::new(200, current(host)?))
}

/// What a request asks to change. `None` leaves the saved value alone.
struct Change {
    keys: Option<Vec<String>>,
    last: Option<Option<Map<String, Value>>>,
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn parse_last(value: &Value) -> std::result::Result<Option<Map<String, Value>>, &'static str> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(map) = value.as_object() else { return Err("Invalid last-viewed standings") };
    if map.keys().any(|k| !["competitionKey", "viewKey", "viewLabel"].contains(&k.as_str())) {
        return Err("Invalid last-viewed standings");
    }
    let Some(key) = map.get("competitionKey").and_then(Value::as_str).filter(|k| !k.is_empty()) else {
        return Err("Invalid last-viewed standings competition");
    };
    let view = |name: &str, max: usize| match map.get(name) {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(t)) if units(t) <= max => Ok(Value::String(t.clone())),
        _ => Err("Invalid last-viewed standings view"),
    };
    let mut saved = Map::new();
    saved.insert("competitionKey".into(), json!(key));
    saved.insert("viewKey".into(), view("viewKey", 100)?);
    saved.insert("viewLabel".into(), view("viewLabel", 200)?);
    Ok(Some(saved))
}

fn parse(body: &Value) -> std::result::Result<Change, &'static str> {
    let Some(map) = body.as_object().filter(|m| !m.is_empty()) else {
        return Err("Invalid standings preferences");
    };
    if map.keys().any(|k| k != "selectedCompetitionKeys" && k != "lastViewed") {
        return Err("Invalid standings preferences");
    }
    let mut change = Change { keys: None, last: None };
    if let Some(keys) = map.get("selectedCompetitionKeys") {
        const BAD: &str = "Invalid standings competition keys";
        let items = keys.as_array().filter(|a| a.len() <= 64).ok_or(BAD)?;
        let texts: Vec<&str> = items.iter().map(|i| i.as_str().ok_or(BAD)).collect::<std::result::Result<_, _>>()?;
        let unique: std::collections::BTreeSet<&str> = texts.iter().copied().collect();
        if unique.len() != texts.len() {
            return Err(BAD);
        }
        change.keys = Some(texts.into_iter().map(str::to_owned).collect());
    }
    if let Some(last) = map.get("lastViewed") {
        change.last = Some(parse_last(last)?);
    }
    Ok(change)
}

pub fn put<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let change = match parse(&request.body) {
        Ok(change) => change,
        Err(message) => return Ok(bad_request(message)),
    };
    if change.keys.as_ref().is_some_and(|keys| keys.iter().any(|k| !catalog::is_known(k))) {
        return Ok(bad_request("Standings preferences contain an unknown competition"));
    }
    if let Some(Some(last)) = &change.last {
        if !last.get("competitionKey").and_then(Value::as_str).is_some_and(catalog::is_known) {
            return Ok(bad_request("Last-viewed standings contain an unknown competition"));
        }
    }
    if let Some(keys) = &change.keys {
        write(host, KEYS, json!(catalog::in_catalog_order(keys.iter().map(String::as_str))))?;
    }
    // A cleared view is saved as null rather than removed.
    if let Some(last) = change.last {
        write(host, LAST, last.map(Value::Object).unwrap_or(Value::Null))?;
    }
    Ok(Response::new(200, current(host)?))
}
