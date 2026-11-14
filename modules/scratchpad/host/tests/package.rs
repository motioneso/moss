use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(std::env::var("SCRATCHPAD_COMPONENT_WASM").expect("Run modules/scratchpad/tools/check.sh")).unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_scratchpad_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "scratchpad-package"),
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
fn a_job_failure_never_repeats_the_payload() {
    let err = call("job", &json!({"queue":"scratchpad.x","payload":{"body":"SECRET-SCREEN-TEXT"}}).to_string()).unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-SCREEN-TEXT"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_scratchpad_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 2);
    for needed in ["moss.module.json", "code/module.wasm", "NOTICE", "CHANGELOG.md"] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_scratchpad_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_scratchpad_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str| {
        authorize(&manifest, port, &Request { operation: operation.into(), resource: resource.into(), parameters: json!({}) }).is_ok()
    };
    assert!(ask("kv", "insert", "scratchpad.store"));
    assert!(!ask("kv", "insert", "meetings.store"));
    assert!(!ask("kv", "drop-everything", "scratchpad.store"));
    assert!(!ask("ai", "generate", "anything"));
}

#[test]
fn changing_one_byte_of_the_legacy_sql_stops_the_build() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path();
    std::fs::copy(root().join("LICENSE"), copy.join("LICENSE")).unwrap();
    let to = copy.join("packages/scratchpad/sql");
    std::fs::create_dir_all(&to).unwrap();
    std::fs::copy(root().join("packages/scratchpad/sql/0282_scratchpad_segments.sql"), to.join("0282_scratchpad_segments.sql")).unwrap();
    let own = copy.join("modules/scratchpad/sql");
    std::fs::create_dir_all(&own).unwrap();
    let name = "0367_scratchpad_index_marks.sql";
    std::fs::copy(root().join("modules/scratchpad/sql").join(name), own.join(name)).unwrap();
    assert!(moss_scratchpad_host::package::files(copy, &component()).is_ok(), "untouched copy with the new migration builds");
    let target = to.join("0282_scratchpad_segments.sql");
    let mut bytes = std::fs::read(&target).unwrap();
    bytes.push(b' ');
    std::fs::write(&target, bytes).unwrap();
    assert!(moss_scratchpad_host::package::files(copy, &component()).is_err(), "a changed byte must stop the build");
    // The new migration is pinned the same way.
    std::fs::copy(root().join("packages/scratchpad/sql/0282_scratchpad_segments.sql"), &target).unwrap();
    let mut mine = std::fs::read(own.join("0367_scratchpad_index_marks.sql")).unwrap();
    mine.push(b' ');
    std::fs::write(own.join("0367_scratchpad_index_marks.sql"), mine).unwrap();
    assert!(moss_scratchpad_host::package::files(copy, &component()).is_err(), "a changed migration must stop the build");
}
