use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("BRIEFINGS_COMPONENT_WASM")
            .expect("Run modules/briefings/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_briefings_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "briefings-package"),
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
    let err = call("job", &json!({"queue":"briefings-run","payload":{"title":"SECRET-TITLE"}}).to_string()).unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-TITLE"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_briefings_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 6);
    for needed in ["moss.module.json", "code/module.wasm", "LICENSE", "NOTICE", "CHANGELOG.md"] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_briefings_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_briefings_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str, parameters: Value| {
        authorize(&manifest, port, &Request {
            operation: operation.into(),
            resource: resource.into(),
            parameters,
        })
    };
    let select = || json!({"kind":"select"});
    let schedule = json!({
        "cron":"0 7 * * *","timezone":"UTC","key":"k",
        "params":{"definition-id":"11111111-1111-4111-8111-111111111111","run-kind":"scheduled","briefing-type":"morning"}
    });
    let cancel = json!({"id":"11111111-1111-4111-8111-111111111111"});
    assert!(ask("db", "query", "app.briefing_definitions", select()).is_ok());
    assert!(ask("db", "query", "app.briefing_runs", select()).is_ok());
    assert!(ask("db", "query", "app.users", select()).is_err());
    assert!(ask("db", "query", "app.tasks", select()).is_err());
    assert!(ask("jobs", "schedule", "briefings-run", schedule.clone()).is_ok());
    assert!(ask("jobs", "unschedule", "briefings-run", cancel).is_ok());
    assert!(ask("jobs", "schedule", "tasks-recurrence", schedule).is_err());
    assert!(ask("kv", "get", "memory.core", json!({})).is_err());
    assert!(ask("network", "fetch", "example.test", json!({})).is_err());
}

#[test]
fn changing_one_byte_of_the_legacy_sql_stops_the_build() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path();
    std::fs::copy(root().join("LICENSE"), copy.join("LICENSE")).unwrap();
    let from = root().join("packages/briefings");
    let to = copy.join("packages/briefings/sql");
    std::fs::create_dir_all(&to).unwrap();
    for entry in std::fs::read_dir(from.join("sql")).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
    }
    assert!(moss_briefings_host::package::files(copy, &component()).is_ok(), "untouched copy builds");
    let target = to.join("0015_briefings_module.sql");
    let mut bytes = std::fs::read(&target).unwrap();
    bytes.push(b' ');
    std::fs::write(&target, bytes).unwrap();
    let err = moss_briefings_host::package::files(copy, &component()).unwrap_err();
    assert!(format!("{err:#}").contains("Legacy Briefings SQL changed"), "{err:#}");
}
