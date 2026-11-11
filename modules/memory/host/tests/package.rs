use access_context::AccessContext;
use moss_module_host::runtime::{authorize, DenyPorts, Host, Limits, Request};
use serde_json::{json, Value};
use std::sync::Arc;

fn core() -> Vec<u8> {
    std::fs::read(
        std::env::var("MEMORY_CORE_WASM")
            .expect("Run modules/memory/tools/check.sh to build the real Rust guest"),
    )
    .unwrap()
}

fn call(kind: &str, payload: &str) -> anyhow::Result<String> {
    let manifest = moss_memory_host::package::manifest().unwrap();
    let wasm = moss_memory_host::package::component(&core()).unwrap();
    Host::new(Limits::default()).unwrap().call(
        &wasm,
        Arc::new(manifest),
        AccessContext::new(uuid::Uuid::new_v4(), "memory-package"),
        Arc::new(DenyPorts),
        kind,
        payload,
    )
}

#[test]
fn the_rust_component_loads_with_the_real_host() {
    assert_eq!(call("health", "{}").unwrap(), "{}");
}

#[test]
fn an_unknown_route_is_a_plain_404() {
    let out = call(
        "route",
        r#"{"method":"GET","path":"/x","params":{},"query":{},"body":null}"#,
    )
    .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["status"], 404);
}

#[test]
fn the_package_asks_for_no_host_ports() {
    let manifest = moss_memory_host::package::manifest().unwrap();
    assert!(manifest.capabilities.is_empty());
    let ask = |port: &str| {
        authorize(
            &manifest,
            port,
            &Request {
                operation: "get".into(),
                resource: "memory.anything".into(),
                parameters: json!({}),
            },
        )
    };
    for port in ["kv", "db", "embed", "ai", "vault", "credentials"] {
        assert!(ask(port).is_err(), "{port} must be refused");
    }
}

#[test]
fn memory_is_required_bundled_and_cannot_be_removed() {
    let manifest = moss_memory_host::package::manifest().unwrap();
    let lifecycle = manifest.lifecycle.clone().unwrap();
    assert!(lifecycle.required && lifecycle.bundled && !lifecycle.removable);
    assert!(!manifest.removable());
    assert_eq!(manifest.database.ledger, moss_module_host::manifest::Ledger::CoreLegacy);
}

#[test]
fn the_sixteen_legacy_tables_match_the_frozen_inventory() {
    let manifest = moss_memory_host::package::manifest().unwrap();
    assert_eq!(manifest.database.owned_tables.len(), 16);
    let mut expected = manifest.database.owned_tables.clone();
    expected.sort();
    let mut frozen = moss_module_host::legacy::tables("memory").to_vec();
    frozen.sort();
    assert_eq!(frozen, expected);
}

#[test]
fn the_package_keeps_every_applied_sql_file_byte_for_byte() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_memory_host::package::pack(&root, &core()).unwrap();
    let package = moss_module_host::archive::Package::read(
        &bytes,
        &moss_module_host::trust::digest(&bytes),
        &"0.1.0".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(package.manifest.database.migrations.len(), 22);
    assert_eq!(package.manifest.screens["/settings/memory"], "ui/index.html");
    moss_module_host::sql::check(&package, &Default::default()).unwrap();
    for path in &package.manifest.database.migrations {
        assert_eq!(
            moss_module_host::legacy::checksum(&package, path).unwrap(),
            moss_module_host::legacy::entry("memory", path).unwrap().checksum
        );
    }
}
