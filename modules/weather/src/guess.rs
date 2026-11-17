//! Where a person probably is, from the address their request came from. The address is used
//! for one lookup and is never saved. The guessed place is kept per person for six hours.
use crate::places::Place;
use crate::util::{encode, get_json, IPWHO};
use chrono::{DateTime, Utc};
use moss_module_sdk::Host;
use serde_json::{json, Value};
use std::net::IpAddr;

const KEEP_SECONDS: i64 = 6 * 60 * 60;

/// True for an address that is not on the public internet: loopback, private, link-local,
/// carrier-grade (which includes tailnet addresses) and the IPv6 equivalents.
pub fn not_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return not_public(IpAddr::V4(mapped));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || v6.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

fn lookup<H: Host + ?Sized>(host: &H, ip: IpAddr) -> Option<Place> {
    let url = format!("https://{IPWHO}/{}", encode(&ip.to_string()));
    let data = get_json(host, IPWHO, &url).ok()?;
    if data["success"] != true {
        return None;
    }
    let label = [data["city"].as_str(), data["country"].as_str()]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    Place::from_json(&json!({
        "lat": data["latitude"],
        "lon": data["longitude"],
        "label": if label.is_empty() { "Unknown" } else { &label },
    }))
}

/// The person's guessed place. A non-public or missing address gives none and calls no one.
pub fn guess<H: Host + ?Sized>(host: &H, client: Option<&str>, now: DateTime<Utc>) -> Option<Place> {
    let ip: IpAddr = client?.trim_start_matches('[').trim_end_matches(']').parse().ok()?;
    if not_public(ip) {
        return None;
    }
    let kept = host.call("kv", "get", "ip-guess", json!({})).unwrap_or(Value::Null);
    if let Some(at) = kept["at"].as_i64() {
        if (0..KEEP_SECONDS).contains(&(now.timestamp() - at)) {
            return Place::from_json(&kept["place"]);
        }
    }
    let place = lookup(host, ip);
    let value = json!({"at": now.timestamp(), "place": place.as_ref().map(Place::json)});
    let _ = host.call("kv", "set", "ip-guess", value);
    place
}
