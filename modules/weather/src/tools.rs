//! Chat tools. The host picks the person, so no tool takes a person from the request.
use crate::places::{self, Place};
use crate::{hourly, SEARCH_DOWN};
use moss_module_sdk::{Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub tool: String,
    pub parameters: Value,
}

fn refusal(message: &str) -> Value {
    json!({"data": {"error": message}})
}

fn candidates(found: &[Place]) -> Value {
    json!(found.iter().map(Place::json).collect::<Vec<_>>())
}

/// Finds one place for a typed name and saves it. Several matches are returned for the person to pick.
fn set_location<H: Host + ?Sized>(host: &H, query: &str) -> Result<Value> {
    let Ok(found) = places::search(host, query.trim(), 5) else { return Ok(refusal(SEARCH_DOWN)) };
    match found.as_slice() {
        [] => Ok(refusal("No weather location matched that place")),
        [only] => {
            if places::saved_place(host)?.as_ref() != Some(only) {
                places::save_place(host, Some(only))?;
            }
            Ok(json!({"data": {"status": "saved", "lat": only.lat, "lon": only.lon, "label": only.label}}))
        }
        many => Ok(json!({"data": {"status": "ambiguous", "candidates": candidates(many)}})),
    }
}

pub fn handle<H: Host + ?Sized>(host: &H, request: ToolRequest) -> Result<Value> {
    let text = |key: &str| request.parameters[key].as_str().map(str::trim).filter(|t| !t.is_empty());
    match request.tool.as_str() {
        "weather.forecast" => match hourly::parse_query(&request.parameters) {
            Some(query) => Ok(json!({"data": hourly::read(host, &query, None)?})),
            None => Ok(refusal("The forecast request is not valid")),
        },
        "weather.setLocation" => match text("query") {
            Some(query) => set_location(host, query),
            None => Ok(refusal("A place name is required")),
        },
        "weather.searchLocations" => match text("query") {
            Some(query) => Ok(match places::search(host, query, 5) {
                Ok(found) => json!({"data": {"candidates": candidates(&found)}}),
                Err(_) => refusal(SEARCH_DOWN),
            }),
            None => Ok(refusal("A place name is required")),
        },
        "weather.getLocation" => Ok(json!({"data": {"location": places::saved_place(host)?.as_ref().map(Place::json)}})),
        "weather.getUnit" => Ok(json!({"data": {"unit": places::unit(host)?}})),
        "weather.setUnit" => match request.parameters["unit"].as_str() {
            Some(unit @ ("metric" | "imperial")) => {
                places::save_unit(host, unit)?;
                Ok(json!({"data": {"unit": unit}}))
            }
            _ => Ok(refusal("unit must be metric or imperial")),
        },
        _ => Err(moss_module_sdk::Error::new("Unknown Weather tool")),
    }
}
