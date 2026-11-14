//! The hourly forecast for a local window such as tonight, 18:00 to 22:00.
use crate::places::{saved_place, search, unit, Place};
use crate::resolve::{resolve, Resolved};
use crate::util::{finite, get_json, iso, now, Down, OPEN_METEO};
use crate::{cache, today, wmo};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use moss_module_sdk::Host;
use serde_json::{json, Value};
use std::str::FromStr;

const HOUR: i64 = 3600;
const STALE_READING_SECONDS: i64 = 30 * 60;
const STALE_OBSERVATION_SECONDS: i64 = 2 * 60 * 60;
const BAD_WINDOW: &str = "Choose a local window of 1\u{2013}12 hours within the next five days.";

pub struct Query {
    pub place: Option<String>,
    pub day_offset: i64,
    pub start: i64,
    pub end: i64,
    pub refresh: bool,
}

/// Reads a query from route text or tool values. A wrongly typed member is refused.
pub fn parse_query(input: &Value) -> Option<Query> {
    let object = input.as_object()?;
    let number = |key: &str, default: i64| match object.get(key) {
        None | Some(Value::Null) => Some(default),
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    };
    let refresh = match object.get("refresh") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) if s == "true" || s == "false" => s == "true",
        _ => return None,
    };
    let place = match object.get("place") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if (2..=200).contains(&s.chars().count()) => Some(s.clone()),
        _ => return None,
    };
    Some(Query { place, day_offset: number("dayOffset", 0)?, start: number("startHour", 18)?, end: number("endHour", 22)?, refresh })
}

fn valid(q: &Query) -> bool {
    q.start >= 0 && q.end <= 24 && q.end > q.start && q.end - q.start <= 12 && (0..=4).contains(&q.day_offset)
}

fn local_midnight(date: NaiveDate, zone: Tz) -> Option<DateTime<Utc>> {
    (0..4).find_map(|hour| match zone.from_local_datetime(&date.and_hms_opt(hour, 0, 0)?) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => Some(t.with_timezone(&Utc)),
        chrono::LocalResult::None => None,
    })
}

/// Each real hour of the local day inside the window. A repeated hour at the end of daylight
/// saving time counts twice and a skipped hour not at all.
pub fn slots(date: NaiveDate, zone: Tz, start: i64, end: i64) -> Option<Vec<i64>> {
    let first = local_midnight(date, zone)?.timestamp();
    let next = local_midnight(date.succ_opt()?, zone)?.timestamp();
    Some(
        (0..)
            .map(|k| first + k * HOUR)
            .take_while(|t| *t < next)
            .filter(|t| {
                let hour = DateTime::from_timestamp(*t, 0).map(|d| d.with_timezone(&zone).hour() as i64);
                hour.is_some_and(|h| h >= start && h < end)
            })
            .collect(),
    )
}

/// The source's hourly readings, as the shared cache keeps them.
fn fetch<H: Host + ?Sized>(host: &H, place: &Place, unit: &str, now: DateTime<Utc>) -> Result<Value, Down> {
    let imperial = unit == "imperial";
    let url = format!(
        "https://{OPEN_METEO}/v1/forecast?latitude={}&longitude={}\
         &hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m&current=temperature_2m\
         &forecast_days=5&timezone=auto&timeformat=unixtime&temperature_unit={}&wind_speed_unit={}",
        place.lat,
        place.lon,
        if imperial { "fahrenheit" } else { "celsius" },
        if imperial { "mph" } else { "kmh" },
    );
    let data = get_json(host, OPEN_METEO, &url)?;
    let zone = data["timezone"].as_str().ok_or(Down)?;
    Tz::from_str(zone).map_err(|_| Down)?;
    let units = &data["hourly_units"];
    if units["temperature_2m"] != if imperial { "\u{b0}F" } else { "\u{b0}C" } || units["time"] != "unixtime" {
        return Err(Down);
    }
    let list = |key: &str| data["hourly"][key].as_array().cloned().unwrap_or_default();
    let times = list("time");
    if times.len() > 128 {
        return Err(Down);
    }
    let (temps, codes) = (list("temperature_2m"), list("weather_code"));
    let rains = if units["precipitation_probability"] == "%" { list("precipitation_probability") } else { vec![] };
    let winds = if units["wind_speed_10m"] == if imperial { "mp/h" } else { "km/h" } { list("wind_speed_10m") } else { vec![] };
    let stamp = |v: &Value| finite(v, 0.0, 4_102_444_800.0).map(|n| n as i64);
    let counts = |t: i64| times.iter().filter(|v| stamp(v) == Some(t)).count();
    let mut intervals = vec![];
    for (i, time) in times.iter().enumerate() {
        let Some(at) = stamp(time) else { continue };
        let Some(temperature) = temps.get(i).and_then(|v| finite(v, -150.0, 200.0)) else { continue };
        if counts(at) > 1 {
            continue;
        }
        let condition = codes.get(i).and_then(|v| finite(v, 0.0, 99.0)).map(|c| wmo::resolve(c as i64).0).unwrap_or("Unknown");
        intervals.push(json!({
            "at": at,
            "temperature": temperature,
            "condition": condition,
            "rainProbability": rains.get(i).and_then(|v| finite(v, 0.0, 100.0)),
            "windSpeed": winds.get(i).and_then(|v| finite(v, 0.0, 500.0)),
        }));
    }
    Ok(json!({
        "timeZone": zone,
        "windUnit": if imperial { "mph" } else { "km/h" },
        "retrievedAt": now.timestamp(),
        "observedAt": stamp(&data["current"]["time"]),
        "intervals": intervals,
    }))
}

fn window(source: &Value, resolved: &Resolved, unit: &str, q: &Query, now: DateTime<Utc>) -> Option<Value> {
    let zone = Tz::from_str(source["timeZone"].as_str()?).ok()?;
    let date = now.with_timezone(&zone).date_naive().checked_add_signed(Duration::days(q.day_offset))?;
    let wanted = slots(date, zone, q.start, q.end)?;
    let (first, last) = (*wanted.first()?, *wanted.last()?);
    let mut seen = std::collections::BTreeSet::new();
    let mut intervals: Vec<(i64, &Value)> = source["intervals"]
        .as_array()?
        .iter()
        .filter_map(|i| Some((i["at"].as_i64()?, i)))
        .filter(|(at, _)| wanted.contains(at) && seen.insert(*at))
        .collect();
    intervals.sort_by_key(|(at, _)| *at);
    let at = |t: i64| iso(DateTime::from_timestamp(t, 0).unwrap_or_default());
    let rows: Vec<Value> = intervals
        .iter()
        .map(|(t, i)| {
            json!({
                "startsAt": at(*t), "endsAt": at(*t + HOUR), "temperature": i["temperature"],
                "condition": i["condition"], "rainProbability": i["rainProbability"], "windSpeed": i["windSpeed"],
            })
        })
        .collect();
    let retrieved = source["retrievedAt"].as_i64()?;
    let observed = source["observedAt"].as_i64();
    let stale = now.timestamp() - retrieved > STALE_READING_SECONDS
        || observed.is_some_and(|o| now.timestamp() - o > STALE_OBSERVATION_SECONDS);
    Some(json!({
        "place": resolved.place.label,
        "approximate": resolved.source == "timezone-fallback" || resolved.source == "ip-geo",
        "locationSource": resolved.source,
        "timeZone": source["timeZone"],
        "unit": unit,
        "windUnit": source["windUnit"],
        "localDate": date.to_string(),
        "startHour": q.start,
        "endHour": q.end,
        "requestedStart": at(first),
        "requestedEnd": at(last + HOUR),
        "coveredStart": intervals.first().map(|(t, _)| at(*t)),
        "coveredEnd": intervals.last().map(|(t, _)| at(*t + HOUR)),
        "coverage": if intervals.len() == wanted.len() { "complete" } else if intervals.is_empty() { "missing" } else { "partial" },
        "observedAt": observed.map(|o| at(o)),
        "retrievedAt": at(retrieved),
        "stale": stale,
        "intervals": rows,
    }))
}

enum Pick {
    Found(Resolved),
    Ambiguous(Vec<Place>),
    None_(&'static str),
    Down,
}

/// A place named in the request. A shortened name of the saved place keeps the saved place.
fn named<H: Host + ?Sized>(host: &H, name: &str) -> moss_module_sdk::Result<Pick> {
    let parts: Vec<String> = name.split(',').map(|p| p.trim().to_lowercase()).collect();
    if let Some(saved) = saved_place(host)? {
        let held: Vec<String> = saved.label.split(',').map(|p| p.trim().to_lowercase()).collect();
        if parts[0] == held[0] && parts[1..].iter().all(|p| held[1..].contains(p)) {
            return Ok(Pick::Found(Resolved { place: saved, source: "stored-preference" }));
        }
    }
    let Ok(found) = search(host, &parts[0], 10) else { return Ok(Pick::Down) };
    let mut matches: Vec<Place> = found
        .into_iter()
        .filter(|c| {
            let words: Vec<String> = c.label.to_lowercase().split(',').map(|w| w.trim().to_owned()).collect();
            parts[1..].iter().all(|q| words.contains(q))
        })
        .collect();
    Ok(match matches.len() {
        0 => Pick::None_("No unique place found. Give the city and region/country, or set a weather location in Profile."),
        1 => Pick::Found(Resolved { place: matches.remove(0), source: "conversation" }),
        _ => Pick::Ambiguous(matches),
    })
}

pub fn read<H: Host + ?Sized>(host: &H, q: &Query, client: Option<&str>) -> moss_module_sdk::Result<Value> {
    if !valid(q) {
        return Ok(json!({"status": "unavailable", "reason": BAD_WINDOW}));
    }
    let now = now(host)?;
    let unit = unit(host)?;
    let resolved = match &q.place {
        Some(name) => named(host, name)?,
        None => match resolve(host, client, now)? {
            Some(found) => Pick::Found(found),
            None => Pick::None_("No weather location is available. Set a place in Settings \u{2192} Profile or name a city and region in this conversation."),
        },
    };
    let resolved = match resolved {
        Pick::Found(found) => found,
        Pick::Ambiguous(candidates) => {
            return Ok(json!({"status": "ambiguous", "candidates": candidates.iter().map(Place::json).collect::<Vec<_>>()}))
        }
        Pick::None_(reason) => return Ok(json!({"status": "unresolved", "reason": reason})),
        Pick::Down => return Ok(json!({"status": "unavailable", "reason": DOWN})),
    };
    let key = cache::key("hourly", resolved.place.lat, resolved.place.lon, unit);
    let cached = (!q.refresh).then(|| cache::read(host, &key, now)).flatten();
    let source = match cached {
        Some(hit) => Some(hit),
        None => fetch(host, &resolved.place, unit, now).ok().inspect(|fresh| cache::write(host, &key, fresh.clone(), now)),
    };
    let outlook = || today::reading(host, &resolved.place, unit, now, false);
    let Some(source) = source else {
        return Ok(json!({"status": "unavailable", "outlook": outlook(), "reason": DOWN}));
    };
    let Some(forecast) = window(&source, &resolved, unit, q, now) else {
        return Ok(json!({"status": "unavailable", "reason": "The requested local window cannot be resolved from this forecast."}));
    };
    let empty = forecast["intervals"].as_array().is_some_and(Vec::is_empty);
    let mut out = json!({"status": "forecast", "forecast": forecast});
    if empty {
        out["outlook"] = outlook().unwrap_or(Value::Null);
    }
    Ok(out)
}

const DOWN: &str = "The hourly forecast is unavailable. Current or daily temperatures cannot establish an evening rain window. Ask for the current outlook or explicitly retry the forecast.";
