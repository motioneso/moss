//! Which place to show: the saved one, then a guess from the request address, then a city
//! for the saved time zone.
use crate::places::{saved_place, Place};
use crate::{guess, tzcity};
use chrono::{DateTime, Utc};
use moss_module_sdk::{Host, Result};
use serde_json::json;
use std::str::FromStr;

pub struct Resolved {
    pub place: Place,
    pub source: &'static str,
}

/// The saved locale time zone, or none when the person has not saved one. The shared default
/// zone never stands in, because it would pick a city for someone who never chose a zone.
pub fn saved_zone<H: Host + ?Sized>(host: &H) -> Option<String> {
    let read = host.call("kv", "preference.read", "saved-timezone", json!({})).ok()?;
    let zone = read["value"].as_str()?;
    chrono_tz::Tz::from_str(zone).ok().map(|_| zone.to_owned())
}

pub fn resolve<H: Host + ?Sized>(host: &H, client: Option<&str>, now: DateTime<Utc>) -> Result<Option<Resolved>> {
    if let Some(place) = saved_place(host)? {
        return Ok(Some(Resolved { place, source: "stored-preference" }));
    }
    if let Some(place) = guess::guess(host, client, now) {
        return Ok(Some(Resolved { place, source: "ip-geo" }));
    }
    Ok(saved_zone(host)
        .and_then(|zone| tzcity::city_for(&zone))
        .map(|(lat, lon, label)| Resolved {
            place: Place { lat, lon, label: label.to_owned() },
            source: "timezone-fallback",
        }))
}
