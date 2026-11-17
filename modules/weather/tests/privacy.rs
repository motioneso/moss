mod common;
use common::*;
use serde_json::json;

const SECRET_LABEL: &str = "Zzyzx Private Hideaway";
const SECRET_IP: &str = "203.0.113.77";

/// Planted markers must not appear in anything a failing outside service or host can echo back.
#[test]
fn failures_never_repeat_a_place_or_an_address() {
    let host = Fake::new("2026-11-13T20:00:00Z");
    host.prefs.borrow_mut().insert("location".into(), place(SECRET_LABEL));
    let mut seen = vec![];
    for (m, p, q) in [("GET", "/today", json!({})), ("GET", "/forecast", json!({})), ("GET", "/location/search", json!({"query": SECRET_LABEL})), ("GET", "/location/reverse", json!({"lat": "1", "lon": "2"}))] {
        let (_, body) = host.route(m, p, q, json!(null), Some(SECRET_IP));
        seen.push(body.to_string());
    }
    seen.push(host.tool("weather.forecast", json!({"place": SECRET_LABEL})).to_string());
    seen.push(host.tool("weather.searchLocations", json!({"query": SECRET_LABEL})).to_string());
    for text in seen {
        assert!(!text.contains("no route") && !text.contains(SECRET_IP), "{text}");
    }
    let out = moss_weather_module::handle(&host, "route", &json!({"method":"GET","path":"/today","params":{},"query":{},"body":null,"client":SECRET_IP}).to_string()).unwrap();
    assert!(!out.contains(SECRET_IP));
}

#[test]
fn the_client_address_is_never_written_anywhere() {
    let host = Fake::new("2026-11-13T20:00:00Z");
    host.serve("ipwho.is", json!({"success": true, "city": "Bend", "country": "United States", "latitude": 44.0, "longitude": -121.0}));
    host.route("GET", "/today", json!({}), json!(null), Some(SECRET_IP));
    for (port, op, _, params) in host.calls.borrow().iter() {
        if port == "kv" && (op == "set" || op == "preference.write") {
            assert!(!params.to_string().contains(SECRET_IP));
        }
    }
}
