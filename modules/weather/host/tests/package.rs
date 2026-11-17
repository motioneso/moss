use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("WEATHER_COMPONENT_WASM")
            .expect("Run modules/weather/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_weather_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "weather-package"),
        Arc::new(DenyPorts),
        kind,
        payload,
    )
}

#[test]
fn the_component_loads_with_the_real_host() {
    assert_eq!(call("health", "{}").unwrap(), "{}");
}

#[test]
fn an_unknown_route_is_a_plain_404() {
    let out = call("route", r#"{"method":"GET","path":"/nope","params":{},"query":{},"body":null}"#).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["status"], 404);
}

#[test]
fn a_job_is_refused_with_fixed_text() {
    let err = call("job", &json!({"queue":"weather-x","payload":{"title":"SECRET-TITLE"}}).to_string()).unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-TITLE"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_weather_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 0);
    for needed in ["moss.module.json", "code/module.wasm", "LICENSE", "NOTICE", "CHANGELOG.md"] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_weather_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_weather_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str, parameters: Value| {
        authorize(&manifest, port, &Request {
            operation: operation.into(),
            resource: resource.into(),
            parameters,
        })
    };
    assert!(ask("kv", "preference.read", "location", json!({})).is_ok());
    assert!(ask("kv", "preference.write", "unit", json!({"value":"metric"})).is_ok());
    assert!(ask("kv", "preference.read", "saved-timezone", json!({})).is_ok());
    assert!(ask("kv", "get", "forecasts", json!({})).is_ok());
    assert!(ask("kv", "preference.read", "locale", json!({})).is_err());
    assert!(ask("kv", "get", "memory.core", json!({})).is_err());
    assert!(ask("fetch", "get", "api.open-meteo.com", json!({"url":"https://api.open-meteo.com/v1/forecast"})).is_ok());
    assert!(ask("fetch", "get", "ipwho.is", json!({"url":"https://ipwho.is/8.8.8.8"})).is_ok());
    assert!(ask("fetch", "get", "example.test", json!({"url":"https://example.test/"})).is_err());
    assert!(ask("db", "query", "app.users", json!({"kind":"select"})).is_err());
    assert!(ask("jobs", "schedule", "weather-x", json!({})).is_err());
}

#[test]
fn only_the_forecast_cache_is_shared_across_accounts() {
    let manifest = moss_weather_host::package::manifest().unwrap();
    assert_eq!(manifest.install_wide_kv.iter().collect::<Vec<_>>(), ["forecasts"]);
}
