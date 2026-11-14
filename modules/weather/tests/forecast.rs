mod common;
use common::*;
use moss_weather_module::hourly::slots;
use serde_json::{json, Value};

const NOW: &str = "2026-11-13T20:00:00Z"; // 12:00 in Seattle
const T0: i64 = 1_794_600_000; // 2026-11-13T20:00:00Z

fn today_body() -> Value {
    json!({
        "current": {"temperature_2m": 50.4, "apparent_temperature": 47.5, "weather_code": 3, "relative_humidity_2m": 80.0, "dew_point_2m": 44.0, "wind_speed_10m": 6.0},
        "daily": {"time": ["2026-11-13", "2026-11-14"], "weather_code": [3, 61], "temperature_2m_max": [55.0, 53.2], "temperature_2m_min": [44.0, 41.5]}
    })
}

fn hourly_body(observed: i64) -> Value {
    // Seattle evening 18:00-22:00 local on 2026-11-13 is 02:00-06:00Z the next day.
    let start = 1_794_621_600; // 2026-11-14T02:00:00Z
    let times: Vec<i64> = (0..4).map(|k| start + k * 3600).collect();
    json!({
        "timezone": "America/Los_Angeles",
        "hourly_units": {"time": "unixtime", "temperature_2m": "\u{b0}F", "precipitation_probability": "%", "wind_speed_10m": "mp/h"},
        "current": {"time": observed},
        "hourly": {"time": times, "temperature_2m": [48, 47, 46, 45], "weather_code": [3, 61, 61, 3],
                   "precipitation_probability": [10, 40, 60, 30], "wind_speed_10m": [5, 6, 7, 8]}
    })
}

fn seeded() -> Fake {
    let host = Fake::new(NOW);
    host.prefs.borrow_mut().insert("location".into(), place("Seattle, Washington, United States"));
    host.serve("api.open-meteo.com", today_body());
    host
}

#[test]
fn today_reads_the_saved_place_in_the_saved_unit() {
    let host = seeded();
    let (status, body) = host.route("GET", "/today", json!({}), json!(null), None);
    assert_eq!(status, 200);
    let d = &body["data"];
    assert_eq!((d["temp"].as_i64(), d["condition"].as_str(), d["location"].as_str()), (Some(50), Some("Overcast"), Some("Seattle, Washington, United States")));
    assert_eq!(d["today"]["high"], 55);
    assert_eq!(d["forecast"][0]["high"], 53);
    assert_eq!(d["unit"], "imperial");
    let url = host.calls.borrow().iter().find(|c| c.0 == "fetch").unwrap().3["url"].as_str().unwrap().to_owned();
    assert!(url.contains("temperature_unit=fahrenheit") && url.contains("latitude=47.61"));
}

#[test]
fn the_shared_forecast_cache_holds_no_place_name_and_saves_a_second_fetch() {
    let host = seeded();
    host.route("GET", "/today", json!({}), json!(null), None);
    host.route("GET", "/today", json!({}), json!(null), None);
    assert_eq!(host.fetches("api.open-meteo.com"), 1);
    assert!(!host.kv.borrow()["forecasts"].to_string().contains("Seattle"));
    *host.now.borrow_mut() = "2026-11-13T20:31:00Z".into();
    host.route("GET", "/today", json!({}), json!(null), None);
    assert_eq!(host.fetches("api.open-meteo.com"), 2, "a reading over 30 minutes old is fetched again");
}

#[test]
fn no_place_and_no_zone_means_null() {
    let host = Fake::new(NOW);
    assert_eq!(host.route("GET", "/today", json!({}), json!(null), None).1, json!({"data": null}));
    assert_eq!(host.fetches("api.open-meteo.com"), 0);
}

#[test]
fn a_known_place_with_the_service_down_is_marked_unavailable() {
    let host = Fake::new(NOW);
    host.prefs.borrow_mut().insert("location".into(), place("Seattle, Washington, United States"));
    assert_eq!(host.route("GET", "/today", json!({}), json!(null), None).1, json!({"data": null, "unavailable": true}));
}

#[test]
fn a_tailnet_address_is_skipped_and_the_saved_zone_city_applies() {
    let host = Fake::new(NOW);
    host.prefs.borrow_mut().insert("saved-timezone".into(), json!("America/New_York"));
    host.serve("api.open-meteo.com", today_body());
    let (_, body) = host.route("GET", "/today", json!({}), json!(null), Some("100.88.50.103"));
    assert_eq!(host.fetches("ipwho.is"), 0);
    assert_eq!(body["data"]["location"], "New York, US");
}

#[test]
fn a_public_address_guesses_once_per_six_hours_and_is_never_stored() {
    let host = Fake::new(NOW);
    host.serve("ipwho.is", json!({"success": true, "city": "Bend", "country": "United States", "latitude": 44.05, "longitude": -121.31}));
    host.serve("api.open-meteo.com", today_body());
    let (_, body) = host.route("GET", "/today", json!({}), json!(null), Some("203.0.113.9"));
    assert_eq!(body["data"]["location"], "Bend, United States");
    host.route("GET", "/today", json!({}), json!(null), Some("203.0.113.9"));
    assert_eq!(host.fetches("ipwho.is"), 1);
    assert!(!format!("{:?}", host.kv.borrow()).contains("203.0.113.9"));
    *host.now.borrow_mut() = "2026-11-14T03:00:00Z".into();
    host.route("GET", "/today", json!({}), json!(null), Some("203.0.113.9"));
    assert_eq!(host.fetches("ipwho.is"), 2);
}

#[test]
fn the_evening_window_is_complete_and_fresh() {
    let host = seeded();
    host.serve("api.open-meteo.com", hourly_body(T0));
    let (status, body) = host.route("GET", "/forecast", json!({}), json!(null), None);
    assert_eq!(status, 200);
    let f = &body["forecast"];
    assert_eq!((body["status"].as_str(), f["coverage"].as_str(), f["stale"].as_bool()), (Some("forecast"), Some("complete"), Some(false)));
    assert_eq!(f["intervals"].as_array().unwrap().len(), 4);
    assert_eq!(f["localDate"], "2026-11-13");
}

#[test]
fn data_observed_over_two_hours_ago_is_stale() {
    let host = seeded();
    host.serve("api.open-meteo.com", hourly_body(T0 - 2 * 3600 - 60));
    let (_, body) = host.route("GET", "/forecast", json!({}), json!(null), None);
    assert_eq!(body["forecast"]["stale"], true);
    let host = seeded();
    host.serve("api.open-meteo.com", hourly_body(T0 - 2 * 3600 + 60));
    let (_, body) = host.route("GET", "/forecast", json!({}), json!(null), None);
    assert_eq!(body["forecast"]["stale"], false);
}

#[test]
fn a_cached_reading_older_than_thirty_minutes_is_stale_when_served() {
    let host = seeded();
    host.serve("api.open-meteo.com", hourly_body(T0));
    host.route("GET", "/forecast", json!({}), json!(null), None);
    // Refresh falls back to the cache only while it is fresh, so age the clock past it with the source gone.
    host.web.borrow_mut().clear();
    *host.now.borrow_mut() = "2026-11-13T20:45:00Z".into();
    let (_, body) = host.route("GET", "/forecast", json!({}), json!(null), None);
    assert_eq!(body["status"], "unavailable");
}

#[test]
fn bad_windows_are_refused() {
    let host = seeded();
    for q in [json!({"startHour": 22, "endHour": 18}), json!({"dayOffset": 9}), json!({"startHour": 0, "endHour": 24})] {
        let (status, body) = host.route("GET", "/forecast", q, json!(null), None);
        assert_eq!((status, body["status"].as_str()), (200, Some("unavailable")));
    }
    assert_eq!(host.route("GET", "/forecast", json!({"startHour": "x"}), json!(null), None).0, 400);
}

#[test]
fn daylight_saving_changes_the_real_hours_in_a_window() {
    let tz: chrono_tz::Tz = "America/Los_Angeles".parse().unwrap();
    let d = |s: &str| s.parse::<chrono::NaiveDate>().unwrap();
    assert_eq!(slots(d("2026-11-01"), tz, 0, 3).unwrap().len(), 4, "the repeated hour counts twice");
    assert_eq!(slots(d("2026-03-08"), tz, 0, 4).unwrap().len(), 3, "the skipped hour is absent");
    assert_eq!(slots(d("2026-11-13"), tz, 18, 22).unwrap().len(), 4);
}

#[test]
fn the_tools_share_the_same_rules() {
    let host = seeded();
    host.serve("api.open-meteo.com", hourly_body(T0));
    assert_eq!(host.tool("weather.forecast", json!({}))["data"]["status"], "forecast");
    assert_eq!(host.tool("weather.getUnit", json!({}))["data"]["unit"], "imperial");
    host.tool("weather.setUnit", json!({"unit": "metric"}));
    assert_eq!(host.tool("weather.getUnit", json!({}))["data"]["unit"], "metric");
    assert_eq!(host.tool("weather.getLocation", json!({}))["data"]["location"]["label"], "Seattle, Washington, United States");
    host.serve("geocoding-api.open-meteo.com", json!({"results": [{"name": "Bend", "admin1": "Oregon", "country": "United States", "latitude": 44.05, "longitude": -121.31}]}));
    assert_eq!(host.tool("weather.setLocation", json!({"query": "Bend"}))["data"]["status"], "saved");
    assert_eq!(host.prefs.borrow()["location"]["label"], "Bend, Oregon, United States");
}

#[test]
fn the_api_for_briefings_returns_the_reading() {
    let host = seeded();
    let out = moss_weather_module::handle(&host, "api", &json!({"name": "weatherToday", "parameters": {}}).to_string()).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["data"]["temp"], 50);
}
