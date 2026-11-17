mod common;
use common::*;
use moss_weather_module::{guess::not_public, places};
use serde_json::json;

#[test]
fn a_saved_place_and_unit_round_trip() {
    let host = Fake::new("2026-11-13T10:00:00Z");
    assert_eq!(host.route("GET", "/location", json!({}), json!(null), None).1, json!({"location": null}));
    let (status, body) = host.route("PUT", "/location", json!({}), place("Seattle, Washington, United States"), None);
    assert_eq!((status, body["location"]["label"].as_str()), (200, Some("Seattle, Washington, United States")));
    assert_eq!(host.route("GET", "/location", json!({}), json!(null), None).1["location"]["lat"], 47.61);
    assert_eq!(host.route("GET", "/unit", json!({}), json!(null), None).1, json!({"unit": "imperial"}));
    host.route("PUT", "/unit", json!({}), json!({"unit": "metric"}), None);
    assert_eq!(host.route("GET", "/unit", json!({}), json!(null), None).1, json!({"unit": "metric"}));
    assert_eq!(host.route("PUT", "/unit", json!({}), json!({"unit": "kelvin"}), None).0, 400);
}

#[test]
fn bad_places_are_refused_and_null_clears() {
    let host = Fake::new("2026-11-13T10:00:00Z");
    assert_eq!(host.route("PUT", "/location", json!({}), json!({"lat": 99, "lon": 0, "label": "x"}), None).0, 400);
    assert_eq!(host.route("PUT", "/location", json!({}), json!({"lat": 1, "lon": 0, "label": "  "}), None).0, 400);
    host.route("PUT", "/location", json!({}), place("Seattle"), None);
    assert_eq!(host.route("PUT", "/location", json!({}), json!(null), None).1, json!({"location": null}));
    assert!(places::saved_place(&host).unwrap().is_none());
}

#[test]
fn search_labels_town_region_country() {
    let host = Fake::new("2026-11-13T10:00:00Z");
    host.serve("geocoding-api.open-meteo.com", json!({"results": [
        {"name": "Paris", "admin1": "Ile-de-France", "country": "France", "latitude": 48.85, "longitude": 2.35},
        {"name": "Paris", "country": "X", "latitude": 1.0, "longitude": 2.0}]}));
    let (status, body) = host.route("GET", "/location/search", json!({"query": "Paris"}), json!(null), None);
    assert_eq!(status, 200);
    assert_eq!(body["candidates"][0]["label"], "Paris, Ile-de-France, France");
    assert_eq!(body["candidates"][1]["label"], "Paris, X");
}

#[test]
fn search_failure_is_a_fixed_502() {
    let host = Fake::new("2026-11-13T10:00:00Z");
    let (status, body) = host.route("GET", "/location/search", json!({"query": "Paris"}), json!(null), None);
    assert_eq!(status, 502);
    assert_eq!(body["error"], moss_weather_module::SEARCH_DOWN);
}

#[test]
fn reverse_names_browser_coordinates() {
    let host = Fake::new("2026-11-13T10:00:00Z");
    host.serve("nominatim.openstreetmap.org", json!({"address": {"town": "Bend", "state": "Oregon", "country": "United States"}}));
    let (status, body) = host.route("GET", "/location/reverse", json!({"lat": "44.05", "lon": "-121.31"}), json!(null), None);
    assert_eq!((status, body["location"]["label"].as_str()), (200, Some("Bend, Oregon, United States")));
    assert_eq!(host.route("GET", "/location/reverse", json!({"lat": "91", "lon": "0"}), json!(null), None).0, 400);
}

#[test]
fn tailnet_private_and_loopback_addresses_are_not_public() {
    for ip in ["100.64.0.1", "100.100.1.2", "100.127.255.255", "10.0.0.5", "192.168.1.9", "172.16.0.1", "127.0.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:100.64.0.1", "0.0.0.0"] {
        assert!(not_public(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["8.8.8.8", "100.128.0.1", "2606:4700::1"] {
        assert!(!not_public(ip.parse().unwrap()), "{ip}");
    }
}
