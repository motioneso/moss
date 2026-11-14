use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("GOALS_COMPONENT_WASM")
            .expect("Run modules/goals/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_goals_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "goals-package"),
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
fn an_unsupported_invocation_leaks_no_request_text() {
    let err = call("job", &json!({"queue":"goals-x","payload":{"title":"SECRET-TITLE"}}).to_string()).unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-TITLE"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_goals_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 3);
    for needed in ["moss.module.json", "code/module.wasm", "LICENSE", "NOTICE", "CHANGELOG.md"] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_goals_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_goals_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str| {
        authorize(&manifest, port, &Request {
            operation: operation.into(),
            resource: resource.into(),
            parameters: json!({"kind":"select"}),
        })
    };
    assert!(ask("db", "query", "app.moss_goals").is_ok());
    assert!(ask("db", "query", "app.moss_goal_evidence").is_ok());
    assert!(ask("db", "query", "app.users").is_err());
    assert!(ask("db", "query", "app.tasks").is_err());
    assert!(ask("jobs", "enqueue-after-commit", "goals-memory-sync").is_err());
    assert!(ask("kv", "get", "goals.store").is_err());
}

#[test]
fn changing_one_byte_of_the_legacy_sql_stops_the_build() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path();
    std::fs::copy(root().join("LICENSE"), copy.join("LICENSE")).unwrap();
    let from = root().join("packages/goals");
    let to = copy.join("packages/goals");
    std::fs::create_dir_all(to.join("sql")).unwrap();
    for name in ["0123_long_running_goals.sql", "0182_moss_rename_goals.sql", "0300_goals_id_defaults.sql"] {
        let mut bytes = std::fs::read(from.join("sql").join(name)).unwrap();
        if name.starts_with("0123") {
            bytes.push(b'\n');
        }
        std::fs::write(to.join("sql").join(name), bytes).unwrap();
    }
    assert!(moss_goals_host::package::files(copy, &component()).is_err());
}
