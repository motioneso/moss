use access_context::AccessContext;
use moss_module_host::runtime::{DenyPorts, Host, Limits};
use std::sync::Arc;

#[test]
fn injected_public_references_use_declared_read_only_host_resources() {
    use moss_module_host::runtime::{authorize, Request};
    let manifest = moss_calendar_host::package::manifest().unwrap();
    for resource in ["calendar.task-reference", "calendar.briefing-reference"] {
        authorize(
            &manifest,
            "kv",
            &Request {
                operation: "get".into(),
                resource: resource.into(),
                parameters: serde_json::json!({"id":uuid::Uuid::new_v4()}),
            },
        )
        .unwrap();
    }
    assert!(!manifest.capabilities.iter().any(|cap| cap.port == "api"));
}

pub fn core() -> Vec<u8> {
    std::fs::read(
        std::env::var("CALENDAR_CORE_WASM")
            .expect("Run modules/calendar/tools/check.sh to build the real Rust guest"),
    )
    .unwrap()
}
#[test]
fn rust_component_loads_with_the_real_host() {
    let manifest = moss_calendar_host::package::manifest().unwrap();
    let wasm = moss_calendar_host::package::component(&core()).unwrap();
    let host = Host::new(Limits::default()).unwrap();
    let access = AccessContext::new(uuid::Uuid::new_v4(), "calendar-package");
    assert_eq!(
        host.call(
            &wasm,
            Arc::new(manifest),
            access,
            Arc::new(DenyPorts),
            "health",
            "{}"
        )
        .unwrap(),
        "{}"
    );
}
#[test]
fn package_preserves_all_fifteen_applied_sql_files() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_calendar_host::package::pack(&root, &core()).unwrap();
    let package = moss_module_host::archive::Package::read(
        &bytes,
        &moss_module_host::trust::digest(&bytes),
        &"0.1.0".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(package.manifest.database.migrations.len(), 15);
    assert!(package.files["ui/calendar_bg.wasm"].starts_with(b"\0asm"));
    assert_eq!(package.manifest.screens["/calendar"], "ui/index.html");
    assert_eq!(
        package.manifest.screens["/settings/calendar"],
        "ui/settings.html"
    );
    moss_module_host::sql::check(&package, &Default::default()).unwrap();
    for path in &package.manifest.database.migrations {
        assert_eq!(
            moss_module_host::legacy::checksum(&package, path).unwrap(),
            moss_module_host::legacy::entry("calendar", path)
                .unwrap()
                .checksum
        );
    }
}
