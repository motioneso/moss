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
fn the_package_asks_only_for_its_own_memory_resources() {
    let manifest = moss_memory_host::package::manifest().unwrap();
    let ports: Vec<_> = manifest.capabilities.iter().map(|c| c.port.as_str()).collect();
    assert_eq!(ports, ["kv", "db", "vault", "jobs", "context"]);
    let ask = |port: &str, operation: &str, resource: &str| {
        authorize(
            &manifest,
            port,
            &Request {
                operation: operation.into(),
                resource: resource.into(),
                parameters: json!({}),
            },
        )
    };
    for (operation, resource) in [
        ("get", "memory.recall"),
        ("get", "memory.core"),
        ("set", "memory.entity"),
        ("set", "memory.fact"),
        ("set", "memory.index"),
    ] {
        ask("kv", operation, resource).unwrap();
    }
    assert!(ask("kv", "get", "memory.anything").is_err());
    assert!(ask("kv", "delete", "memory.fact").is_err());
    for port in ["embed", "ai", "credentials", "fetch"] {
        assert!(ask(port, "get", "memory.recall").is_err(), "{port} must be refused");
    }
    // A declared port still refuses any table or source the manifest does not name.
    for port in ["db", "vault"] {
        assert!(ask(port, "get", "memory.anything").is_err(), "{port} must refuse an unnamed resource");
    }
}

#[test]
fn the_five_routes_and_two_tools_are_declared() {
    let manifest = moss_memory_host::package::manifest().unwrap();
    let routes: Vec<_> = manifest.routes.iter().map(|r| (r.method.as_str(), r.path.as_str())).collect();
    assert_eq!(
        routes,
        [
            ("GET", "/graph/recall"),
            ("GET", "/graph/core"),
            ("POST", "/graph/entities"),
            ("POST", "/graph/facts"),
            ("POST", "/vault-index/start")
        ]
    );
    assert!(manifest.routes.iter().all(|r| r.sign_in));
    let mut tools: Vec<_> = manifest.tools.keys().map(String::as_str).collect();
    tools.sort();
    assert_eq!(tools, ["memory.recall", "memory.remember"]);
    assert_eq!(manifest.tools["memory.recall"].risk, "read");
    assert_eq!(manifest.tools["memory.remember"].risk, "write");
    let features: Vec<_> = manifest.features.iter().filter_map(|f| f["id"].as_str()).collect();
    for id in ["memory.recall", "memory.remember", "memory.vault-index"] {
        assert!(features.contains(&id), "{id} must be in the app map");
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
    assert_eq!(manifest.database.owned_tables.len(), 17);
    let mut expected = manifest.database.owned_tables.clone();
    expected.retain(|t| t != "app.memory_ingest_nudges");
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
    assert_eq!(package.manifest.database.migrations.len(), 23);
    assert_eq!(package.manifest.screens["/settings/memory"], "ui/index.html");
    moss_module_host::sql::check(&package, &Default::default()).unwrap();
    for path in package.manifest.database.migrations.iter().filter(|p| moss_module_host::legacy::entry("memory", p).is_some()) {
        assert_eq!(
            moss_module_host::legacy::checksum(&package, path).unwrap(),
            moss_module_host::legacy::entry("memory", path).unwrap().checksum
        );
    }
}
