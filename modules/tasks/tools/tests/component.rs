use access_context::AccessContext;
use moss_module_host::runtime::{DenyPorts, Host, Limits};
use std::sync::Arc;

#[test]
fn rust_component_runs_without_native_adapter_or_wasi() {
    let path =
        std::env::var_os("TASKS_COMPONENT").expect("Set TASKS_COMPONENT to the built component");
    let wasm = std::fs::read(path).unwrap();
    let manifest = Arc::new(moss_tasks_checks::manifest().unwrap());
    let host = Host::new(Limits::default()).unwrap();
    host.validate(&wasm, &manifest).unwrap();
    let invoke = |kind: &str, payload: &str| {
        host.call(
            &wasm,
            manifest.clone(),
            AccessContext::new(uuid::Uuid::new_v4(), "component-check"),
            Arc::new(DenyPorts),
            kind,
            payload,
        )
    };
    assert_eq!(invoke("health", "").unwrap(), "{}");
    assert_eq!(invoke("install", "").unwrap(), "{}");
    assert!(invoke("unknown", "{}").is_err());
    let invalid = serde_json::json!({
        "method":"POST","path":"/tasks","params":{},"query":{},
        "body":{"title":"x","status":"invalid"}
    });
    let rejected: serde_json::Value =
        serde_json::from_str(&invoke("route", &invalid.to_string()).unwrap()).unwrap();
    assert_eq!(rejected["status"], 400);
    assert_eq!(
        rejected["body"]["error"],
        "body/status must be equal to one of the allowed values"
    );
}

#[test]
fn archive_contains_real_component_and_original_migrations() {
    let wasm =
        std::fs::read(std::env::var_os("TASKS_COMPONENT").expect("Build Tasks component first"))
            .unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let files = moss_tasks_checks::package_files(&root, wasm.clone()).unwrap();
    let bytes = moss_module_host::archive::pack(&files).unwrap();
    assert_eq!(bytes, moss_module_host::archive::pack(&files).unwrap());
    let package = moss_module_host::archive::Package::read(
        &bytes,
        &moss_module_host::trust::digest(&bytes),
        &"0.1.0".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(package.files["code/module.wasm"], wasm);
    assert_eq!(package.manifest.database.migrations.len(), 9);
    for (path, original) in moss_tasks_checks::legacy_files(&root).unwrap() {
        assert_eq!(package.files[&path], original);
    }
    assert_eq!(package.manifest.id, "tasks");
}
