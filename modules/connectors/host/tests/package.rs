use access_context::AccessContext;
use moss_module_host::runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn core() -> Vec<u8> {
    std::fs::read(
        std::env::var("CONNECTORS_CORE_WASM")
            .expect("Run modules/connectors/tools/check.sh to build the real Rust guest"),
    )
    .unwrap()
}

/// Answers the package's kv calls from fixed data and records every request.
struct Fixed(Mutex<Vec<String>>);
impl Ports for Fixed {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        assert_eq!(port, "kv");
        self.0.lock().unwrap().push(request.resource.clone());
        Ok(match request.resource.as_str() {
            "connectors.providers" => json!([{"id":"google","providerType":"google","displayName":"Google","status":"available","defaultScopes":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]),
            "connectors.accounts" => json!([]),
            _ => anyhow::bail!("Unexpected resource"),
        })
    }
}

fn call(ports: Arc<dyn Ports>, kind: &str, payload: &str) -> Result<String, anyhow::Error> {
    let manifest = moss_connectors_host::package::manifest().unwrap();
    let wasm = moss_connectors_host::package::component(&core()).unwrap();
    let host = Host::new(Limits::default()).unwrap();
    host.call(
        &wasm,
        Arc::new(manifest),
        AccessContext::new(uuid::Uuid::new_v4(), "connectors-package"),
        ports,
        kind,
        payload,
    )
}

#[test]
fn rust_component_loads_with_the_real_host() {
    assert_eq!(call(Arc::new(DenyPorts), "health", "{}").unwrap(), "{}");
}

#[test]
fn a_route_runs_in_wasm_through_declared_kv_resources_only() {
    let ports = Arc::new(Fixed(Mutex::new(vec![])));
    let out = call(
        ports.clone(),
        "route",
        r#"{"method":"GET","path":"/providers","params":{},"query":{},"body":null}"#,
    )
    .unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(response["status"], 200);
    assert_eq!(response["body"]["providers"][0]["id"], "google");
    assert_eq!(*ports.0.lock().unwrap(), ["connectors.providers"]);
}

#[test]
fn a_host_failure_reaches_the_caller_as_a_scrubbed_500() {
    let out = call(
        Arc::new(DenyPorts),
        "route",
        r#"{"method":"GET","path":"/accounts","params":{},"query":{},"body":null}"#,
    )
    .unwrap();
    let response: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(response["status"], 500);
    assert_eq!(response["body"], json!({"error":"Internal server error"}));
}

#[test]
fn undeclared_resources_are_refused() {
    use moss_module_host::runtime::authorize;
    let manifest = moss_connectors_host::package::manifest().unwrap();
    let ask = |resource: &str| {
        authorize(
            &manifest,
            "kv",
            &Request { operation: "get".into(), resource: resource.into(), parameters: json!({}) },
        )
    };
    assert!(ask("connectors.accounts").is_ok());
    assert!(ask("connectors.secrets").is_err());
    assert!(authorize(
        &manifest,
        "db",
        &Request { operation: "query".into(), resource: "app.connector_accounts".into(), parameters: json!({}) }
    )
    .is_err());
}

#[test]
fn package_preserves_all_eighteen_applied_sql_files_byte_for_byte() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_connectors_host::package::pack(&root, &core()).unwrap();
    let package = moss_module_host::archive::Package::read(
        &bytes,
        &moss_module_host::trust::digest(&bytes),
        &"0.1.0".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(package.manifest.database.migrations.len(), 18);
    assert!(package.files["ui/connectors_bg.wasm"].starts_with(b"\0asm"));
    assert_eq!(package.manifest.screens["/settings/connections"], "ui/settings.html");
    moss_module_host::sql::check(&package, &Default::default()).unwrap();
    for path in &package.manifest.database.migrations {
        assert_eq!(
            moss_module_host::legacy::checksum(&package, path).unwrap(),
            moss_module_host::legacy::entry("connectors", path).unwrap().checksum
        );
    }
}
