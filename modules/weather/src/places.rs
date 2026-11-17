//! Saved place and unit, place search and the browser-position lookup.
use crate::util::{encode, finite, get_json, Down, GEOCODING, NOMINATIM};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct Place {
    pub lat: f64,
    pub lon: f64,
    pub label: String,
}
impl Place {
    pub fn json(&self) -> Value {
        json!({"lat": self.lat, "lon": self.lon, "label": self.label})
    }
    /// A place only when its coordinates are in range and its name is 1..=200 characters.
    pub fn from_json(value: &Value) -> Option<Place> {
        let label = value["label"].as_str()?;
        Some(Place {
            lat: finite(&value["lat"], -90.0, 90.0)?,
            lon: finite(&value["lon"], -180.0, 180.0)?,
            label: label.to_owned(),
        })
        .filter(|p| !p.label.is_empty() && p.label.chars().count() <= 200)
    }
}

pub fn saved_place<H: Host + ?Sized>(host: &H) -> Result<Option<Place>> {
    let read = host.call("kv", "preference.read", "location", json!({}))?;
    Ok(Place::from_json(&read["value"]))
}

pub fn save_place<H: Host + ?Sized>(host: &H, place: Option<&Place>) -> Result<()> {
    let value = place.map(Place::json).unwrap_or(Value::Null);
    host.call("kv", "preference.write", "location", json!({"value": value}))?;
    Ok(())
}

/// The unit is imperial until the person picks metric.
pub fn unit<H: Host + ?Sized>(host: &H) -> Result<&'static str> {
    let read = host.call("kv", "preference.read", "unit", json!({}))?;
    Ok(if read["value"] == "metric" { "metric" } else { "imperial" })
}

pub fn save_unit<H: Host + ?Sized>(host: &H, unit: &str) -> Result<()> {
    host.call("kv", "preference.write", "unit", json!({"value": unit}))?;
    Ok(())
}

/// Open-Meteo place search, up to `limit` matches named "town, region, country".
pub fn search<H: Host + ?Sized>(host: &H, query: &str, limit: usize) -> std::result::Result<Vec<Place>, Down> {
    let url = format!(
        "https://{GEOCODING}/v1/search?name={}&count=10&language=en&format=json",
        encode(query)
    );
    let data = get_json(host, GEOCODING, &url)?;
    let results = data["results"].as_array().cloned().unwrap_or_default();
    Ok(results
        .iter()
        .take(limit)
        .filter_map(|r| {
            let admin = r["admin1"].as_str().filter(|a| !a.is_empty());
            let label = match admin {
                Some(admin) => format!("{}, {admin}, {}", r["name"].as_str()?, r["country"].as_str()?),
                None => format!("{}, {}", r["name"].as_str()?, r["country"].as_str()?),
            };
            Some(Place { lat: r["latitude"].as_f64()?, lon: r["longitude"].as_f64()?, label })
        })
        .collect())
}

/// A name for browser coordinates. The coordinates stay the browser's own.
pub fn reverse<H: Host + ?Sized>(host: &H, lat: f64, lon: f64) -> std::result::Result<Place, Down> {
    let url = format!(
        "https://{NOMINATIM}/reverse?format=jsonv2&lat={}&lon={}&zoom=10&accept-language=en",
        encode(&lat.to_string()),
        encode(&lon.to_string())
    );
    let data = get_json(host, NOMINATIM, &url)?;
    let address = &data["address"];
    let town = ["city", "town", "village", "municipality", "county"]
        .iter()
        .find_map(|k| address[*k].as_str());
    let parts: Vec<&str> = [town, address["state"].as_str(), address["country"].as_str()]
        .into_iter()
        .flatten()
        .filter(|p| !p.trim().is_empty())
        .collect();
    let label = if parts.is_empty() { format!("{lat:.3}, {lon:.3}") } else { parts.join(", ") };
    Ok(Place { lat, lon, label })
}
