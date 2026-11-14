//! Today's weather and the next days, for the person's place.
use crate::util::{get_json, now, round, Down, OPEN_METEO};
use crate::wmo;
use crate::{cache, places::Place, places::unit, resolve::resolve};
use chrono::{DateTime, Utc};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

/// The reading without the person's place. This is what the shared cache keeps.
fn fetch<H: Host + ?Sized>(host: &H, place: &Place, unit: &str) -> std::result::Result<Value, Down> {
    let temperature = if unit == "imperial" { "fahrenheit" } else { "celsius" };
    let url = format!(
        "https://{OPEN_METEO}/v1/forecast?latitude={}&longitude={}\
         &current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,dew_point_2m,wind_speed_10m\
         &daily=weather_code,temperature_2m_max,temperature_2m_min\
         &forecast_days=5&timezone=auto&temperature_unit={temperature}",
        place.lat, place.lon
    );
    let data = get_json(host, OPEN_METEO, &url)?;
    let (current, daily) = (&data["current"], &data["daily"]);
    let number = |v: &Value| v.as_f64().ok_or(Down);
    let code = current["weather_code"].as_f64().ok_or(Down)? as i64;
    let (condition, icon) = wmo::resolve(code);
    let days = daily["time"].as_array().ok_or(Down)?;
    let at = |key: &str, i: usize| daily[key].get(i).and_then(Value::as_f64);
    let mut forecast = vec![];
    for (i, date) in days.iter().enumerate().skip(1) {
        let (Some(c), Some(high), Some(low)) = (at("weather_code", i), at("temperature_2m_max", i), at("temperature_2m_min", i))
        else {
            return Err(Down);
        };
        forecast.push(json!({"date": date, "icon": wmo::resolve(c as i64).1, "high": round(high), "low": round(low)}));
    }
    let mut out = json!({
        "temp": round(number(&current["temperature_2m"])?),
        "feelsLike": round(number(&current["apparent_temperature"])?),
        "condition": condition,
        "icon": icon,
        "humidity": round(number(&current["relative_humidity_2m"])?),
        "dewPoint": round(number(&current["dew_point_2m"])?),
        "windSpeed": round(number(&current["wind_speed_10m"])?),
        "forecast": forecast,
    });
    if let (Some(c), Some(high), Some(low)) = (at("weather_code", 0), at("temperature_2m_max", 0), at("temperature_2m_min", 0)) {
        out["today"] = json!({"condition": wmo::resolve(c as i64).0, "high": round(high), "low": round(low)});
    }
    Ok(out)
}

/// The reading for a place, from the shared cache when it is under 30 minutes old.
pub fn reading<H: Host + ?Sized>(host: &H, place: &Place, unit: &str, now: DateTime<Utc>, refresh: bool) -> Option<Value> {
    let key = cache::key("today", place.lat, place.lon, unit);
    let mut data = match (!refresh).then(|| cache::read(host, &key, now)).flatten() {
        Some(hit) => hit,
        None => {
            let fresh = fetch(host, place, unit).ok()?;
            cache::write(host, &key, fresh.clone(), now);
            fresh
        }
    };
    data["location"] = json!(place.label);
    data["unit"] = json!(unit);
    data["lat"] = json!(place.lat);
    data["lon"] = json!(place.lon);
    Some(data)
}

/// `{data}` with the reading. Null data means no place is known, or the service is down, which
/// also sets `unavailable` so callers can tell the two apart.
pub fn today<H: Host + ?Sized>(host: &H, client: Option<&str>) -> Result<Value> {
    let now = now(host)?;
    let Some(found) = resolve(host, client, now)? else { return Ok(json!({"data": null})) };
    let unit = unit(host)?;
    Ok(match reading(host, &found.place, unit, now, false) {
        Some(data) => json!({"data": data}),
        None => json!({"data": null, "unavailable": true}),
    })
}
