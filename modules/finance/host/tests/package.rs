use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("FINANCE_COMPONENT_WASM")
            .expect("Run modules/finance/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    Host::new(Limits::default()).unwrap().call(
        &component(),
        Arc::new(moss_finance_host::package::manifest().unwrap()),
        AccessContext::new(uuid::Uuid::new_v4(), "finance-package"),
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
    let err = call("job", &json!({"queue":"finance-x","payload":{"title":"SECRET-TITLE"}}).to_string()).unwrap_err();
    assert!(!format!("{err:#}").contains("SECRET-TITLE"));
}

#[test]
fn the_package_builds_and_the_manifest_validates() {
    let files = moss_finance_host::package::files(&root(), &component()).unwrap();
    assert_eq!(files.keys().filter(|k| k.starts_with("sql/")).count(), 42);
    for needed in ["moss.module.json", "code/module.wasm", "LICENSE", "NOTICE", "CHANGELOG.md"] {
        assert!(files.contains_key(needed), "{needed} missing");
    }
    assert!(moss_finance_host::package::pack(&root(), &component()).is_ok());
}

#[test]
fn the_package_asks_only_for_its_own_resources() {
    let manifest = moss_finance_host::package::manifest().unwrap();
    let ask = |port: &str, operation: &str, resource: &str| {
        authorize(&manifest, port, &Request {
            operation: operation.into(),
            resource: resource.into(),
            parameters: json!({"kind":"select"}),
        })
    };
    assert!(ask("db", "query", "app.finance_accounts").is_ok());
    assert!(ask("db", "query", "app.finance_transactions").is_ok());
    assert!(ask("db", "query", "app.finance_activity").is_ok());
    assert!(ask("db", "query", "app.finance_imports").is_err());
    assert!(ask("db", "query", "app.users").is_err());
    assert!(ask("context", "local-date", "account").is_ok());
    assert!(ask("kv", "get", "finance.store").is_err());
    assert!(ask("ai", "generate", "chat").is_err());
    assert!(ask("tools", "run", "finance.manual.entry-create").is_ok());
    assert!(ask("tools", "run", "finance.accounts.list").is_err());
    assert!(ask("jobs", "enqueue-after-commit", "finance-sync").is_err());
}

#[test]
fn changing_one_byte_of_the_legacy_sql_stops_the_build() {
    let scratch = tempfile::tempdir().unwrap();
    let copy = scratch.path();
    std::fs::copy(root().join("LICENSE"), copy.join("LICENSE")).unwrap();
    let from = root().join("external-modules/finance");
    let to = copy.join("external-modules/finance");
    std::fs::create_dir_all(to.join("sql")).unwrap();
    for entry in std::fs::read_dir(from.join("sql")).unwrap() {
        let name = entry.unwrap().file_name();
        let mut bytes = std::fs::read(from.join("sql").join(&name)).unwrap();
        if name.to_string_lossy().starts_with("0001") {
            bytes.push(b'\n');
        }
        std::fs::write(to.join("sql").join(&name), bytes).unwrap();
    }
    assert!(moss_finance_host::package::files(copy, &component()).is_err());
}
