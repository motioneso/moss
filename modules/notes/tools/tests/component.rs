use access_context::AccessContext;
use moss_module_host::{
    archive::{pack, Package},
    runtime::{DenyPorts, Host, Limits},
    trust,
};
use std::{path::Path, sync::Arc};

#[test]
fn actual_guest_runs_without_wasi_and_archive_is_reproducible() {
    let wasm = std::fs::read(
        std::env::var_os("NOTES_COMPONENT").expect("Build Notes and set NOTES_COMPONENT"),
    )
    .unwrap();
    let manifest = Arc::new(moss_notes_checks::manifest().unwrap());
    let host = Host::new(Limits::default()).unwrap();
    host.validate(&wasm, &manifest).unwrap();
    for kind in ["health", "install"] {
        assert_eq!(
            host.call(
                &wasm,
                manifest.clone(),
                AccessContext::new(uuid::Uuid::new_v4(), "notes-component"),
                Arc::new(DenyPorts),
                kind,
                ""
            )
            .unwrap(),
            "{}"
        );
    }
    let unavailable = host
        .call(
            &wasm,
            manifest.clone(),
            AccessContext::new(uuid::Uuid::new_v4(), "notes-route-unavailable"),
            Arc::new(DenyPorts),
            "route",
            r#"{"method":"GET","path":"/notes-source","params":{},"query":{},"body":null}"#,
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&unavailable).unwrap(),
        serde_json::json!({"status":500,"body":{"error":"Internal Server Error"}})
    );
    assert!(host
        .call(
            &wasm,
            manifest,
            AccessContext::new(uuid::Uuid::new_v4(), "notes-component"),
            Arc::new(DenyPorts),
            "api",
            r#"{"name":"collectManagedNotesExportSection","parameters":{}}"#
        )
        .is_err());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let files = moss_notes_checks::package_files(&root, wasm.clone()).unwrap();
    let bytes = pack(&files).unwrap();
    assert_eq!(bytes, pack(&files).unwrap());
    let package = Package::read(&bytes, &trust::digest(&bytes), &"0.1.0".parse().unwrap()).unwrap();
    assert_eq!(package.files["code/module.wasm"], wasm);
    assert_eq!(package.manifest.database.migrations.len(), 3);
    assert_eq!(package.manifest.database.owned_tables.len(), 6);
    assert!(!package.manifest.accounts.supports_user_disable);
    assert!(package.manifest.navigation.is_empty());
    assert!(
        package.manifest.tools.is_empty(),
        "Unfinished chat tools must not be offered"
    );
    assert!(
        package.manifest.jobs.is_empty(),
        "Unfinished sync must not be scheduled"
    );
    assert!(package.manifest.capability("jobs").is_err());
    assert!(!package
        .manifest
        .capability("vault")
        .unwrap()
        .operations
        .contains("notes.compare-write"));
    for path in package.manifest.database.migrations {
        assert_eq!(
            package.files[&path],
            std::fs::read(root.join("packages/notes").join(&path)).unwrap()
        );
    }
}

#[test]
fn builder_refuses_changed_legacy_sql() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("packages/notes/sql");
    std::fs::create_dir_all(&folder).unwrap();
    for path in moss_notes_checks::manifest().unwrap().database.migrations {
        std::fs::copy(
            root.join("packages/notes").join(&path),
            temp.path().join("packages/notes").join(&path),
        )
        .unwrap();
    }
    std::fs::write(
        folder.join("0336_notes_managed_source_lifecycle.sql"),
        b"-- changed migration\n",
    )
    .unwrap();
    assert!(moss_notes_checks::package_files(temp.path(), vec![])
        .unwrap_err()
        .to_string()
        .contains("Notes migration bytes changed"));
}

#[test]
fn guest_excludes_machine_build_paths() {
    let wasm = std::fs::read(std::env::var_os("NOTES_COMPONENT").unwrap()).unwrap();
    for prefix in [b"/home/".as_slice(), b"/tmp/".as_slice()] {
        assert!(
            !wasm.windows(prefix.len()).any(|bytes| bytes == prefix),
            "Notes guest contains a machine-specific build path"
        );
    }
}
