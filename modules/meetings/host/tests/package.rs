use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("MEETINGS_COMPONENT_WASM")
            .expect("Run modules/meetings/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_meetings_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "meetings-package"),
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
    let err = call("job", &json!({"queue":"meetings.x","payload":{"title":"SECRET-TITLE"}}).to_string()).unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-TITLE"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_meetings_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 17);
    for needed in ["moss.module.json", "code/module.wasm", "LICENSE", "NOTICE", "CHANGELOG.md"] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_meetings_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_meetings_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str| {
        authorize(&manifest, port, &Request {
            operation: operation.into(),
            resource: resource.into(),
            parameters: if port == "db" { json!({"kind":"select"}) } else { json!({}) },
        })
    };
    for operation in ["get", "set", "lock"] {
        assert!(ask("kv", operation, "meetings.preferences").is_ok(), "kv {operation}");
    }
    assert!(ask("kv", "get", "memory.core").is_err());
    assert!(ask("kv", "delete", "meetings.preferences").is_err());
    assert!(ask("db", "query", "app.meeting_records").is_ok());
    assert!(ask("db", "query", "app.users").is_err());
    assert!(ask("db", "query", "app.preferences").is_err());
    assert!(ask("jobs", "enqueue", "meetings.stop-summary").is_err());
    assert!(ask("network", "fetch", "example.test").is_err());
}

#[test]
fn changing_one_byte_of_the_legacy_sql_stops_the_build() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path();
    std::fs::copy(root().join("LICENSE"), copy.join("LICENSE")).unwrap();
    let from = root().join("packages/meetings");
    let to = copy.join("packages/meetings/sql");
    std::fs::create_dir_all(&to).unwrap();
    for entry in std::fs::read_dir(from.join("sql")).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
    }
    assert!(moss_meetings_host::package::files(copy, &component()).is_ok(), "untouched copy builds");
    let target = to.join("0273_meeting_records.sql");
    let mut bytes = std::fs::read(&target).unwrap();
    bytes.push(b' ');
    std::fs::write(&target, bytes).unwrap();
    let err = moss_meetings_host::package::files(copy, &component()).unwrap_err();
    assert!(format!("{err:#}").contains("Legacy Meetings SQL changed"), "{err:#}");
}
