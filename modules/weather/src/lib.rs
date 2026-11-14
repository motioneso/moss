//! Weather package: today's weather and the hourly forecast for each person's place, the saved
//! place and unit, place search, and the weather chat tools. All effects cross the guest-safe
//! SDK Host interface.
pub mod cache;
pub mod guess;
pub mod hourly;
pub mod places;
pub mod resolve;
pub mod tools;
pub mod today;
pub mod tzcity;
pub mod util;
pub mod wmo;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use places::Place;
use serde_json::{json, Value};

pub const SEARCH_DOWN: &str = "Weather location search is temporarily unavailable";
pub const REVERSE_DOWN: &str = "Looking up your location is temporarily unavailable";

fn refuse(status: u16, message: &str) -> Response {
    Response::new(status, json!({"message": message}))
}

/// A place from a request body, trimmed and cut to 200 UTF-16 units like the old Settings route.
fn body_place(body: &Value) -> Option<Place> {
    let place = Place::from_json(&json!({"lat": body["lat"], "lon": body["lon"], "label": "x"}))?;
    let mut label = String::new();
    for c in body["label"].as_str()?.trim().chars() {
        if label.encode_utf16().count() + c.len_utf16() > 200 {
            break;
        }
        label.push(c);
    }
    (!label.is_empty()).then_some(Place { label, ..place })
}

fn put_location<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> moss_module_sdk::Result<Response> {
    if request.body.is_null() {
        places::save_place(host, None)?;
        return Ok(Response::new(200, json!({"location": null})));
    }
    let Some(place) = body_place(&request.body) else {
        return Ok(refuse(400, "A place needs lat, lon and a name"));
    };
    places::save_place(host, Some(&place))?;
    Ok(Response::new(200, json!({"location": place.json()})))
}

fn search_route<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Response {
    let query = request.query.get("query").and_then(Value::as_str).unwrap_or("").trim();
    if query.is_empty() {
        return Response::new(200, json!({"candidates": []}));
    }
    match places::search(host, query, 5) {
        Ok(found) => Response::new(200, json!({"candidates": found.iter().map(Place::json).collect::<Vec<_>>()})),
        Err(_) => Response::new(502, json!({"error": SEARCH_DOWN})),
    }
}

fn reverse_route<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Response {
    let number = |k: &str| request.query.get(k).and_then(Value::as_str).and_then(|t| t.parse::<f64>().ok());
    let (Some(lat), Some(lon)) = (number("lat"), number("lon")) else {
        return refuse(400, "lat and lon are required");
    };
    if !(lat.abs() <= 90.0 && lon.abs() <= 180.0) {
        return refuse(400, "lat and lon are out of range");
    }
    match places::reverse(host, lat, lon) {
        Ok(place) => Response::new(200, json!({"location": place.json()})),
        Err(_) => Response::new(502, json!({"error": REVERSE_DOWN})),
    }
}

fn put_unit<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> moss_module_sdk::Result<Response> {
    match request.body["unit"].as_str() {
        Some(unit @ ("metric" | "imperial")) => {
            places::save_unit(host, unit)?;
            Ok(Response::new(200, json!({"unit": unit})))
        }
        _ => Ok(refuse(400, "unit must be metric or imperial")),
    }
}

/// Routes use the module-relative path template. `client` is the caller's address when the
/// host passed one. A host failure leaves as a fixed message, because host errors can carry
/// request text.
pub fn route_from<H: Host + ?Sized>(host: &H, request: RouteRequest, client: Option<&str>) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/today") => today::today(host, client).map(|body| Response::new(200, body)),
        ("GET", "/forecast") => match hourly::parse_query(&json!(request.query)) {
            Some(query) => hourly::read(host, &query, client).map(|body| Response::new(200, body)),
            None => Ok(refuse(400, "The forecast request is not valid")),
        },
        ("GET", "/location") => places::saved_place(host).map(|p| Response::new(200, json!({"location": p.as_ref().map(Place::json)}))),
        ("PUT", "/location") => put_location(host, &request),
        ("GET", "/location/search") => Ok(search_route(host, &request)),
        ("GET", "/location/reverse") => Ok(reverse_route(host, &request)),
        ("GET", "/unit") => places::unit(host).map(|u| Response::new(200, json!({"unit": u}))),
        ("PUT", "/unit") => put_unit(host, &request),
        _ => return refuse(404, "Route not found"),
    };
    result.unwrap_or_else(|_| refuse(500, "Internal server error"))
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(host: &H, kind: &str, payload: &str) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            // The host adds `client` only because this package asked for it.
            let mut envelope: Value = serde_json::from_str(payload)?;
            let client = envelope.as_object_mut().and_then(|o| o.remove("client"));
            let request: RouteRequest = serde_json::from_value(envelope)?;
            Ok(serde_json::to_string(&route_from(host, request, client.as_ref().and_then(Value::as_str)))?)
        }
        "tool" => {
            let request = serde_json::from_str(payload)?;
            let result = tools::handle(host, request).map_err(|_| moss_module_sdk::Error::new("Weather tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        "api" => api(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Weather invocation")),
    }
}

fn api<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    #[serde(tag = "name", content = "parameters")]
    enum Api {
        #[serde(rename = "weatherToday")]
        Today(#[allow(dead_code)] Value),
    }
    Ok(match serde_json::from_str(payload)? {
        Api::Today(_) => today::today(host, None)?,
    }
    .to_string())
}
