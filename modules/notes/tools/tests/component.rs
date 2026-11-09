use access_context::AccessContext;
use moss_module_host::{
    archive::{pack, Package},
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    trust,
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

#[derive(Default)]
struct CountingPorts(AtomicUsize);
impl Ports for CountingPorts {
    fn invoke(&self, _: &CallScope, _: &str, _: &Request) -> anyhow::Result<serde_json::Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(serde_json::json!({"rows":[], "affectedRows":1}))
    }
}

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
    let sync_ports = Arc::new(CountingPorts::default());
    assert!(
        host.call(
            &wasm,
            manifest.clone(),
            AccessContext::new(uuid::Uuid::new_v4(), "ordinary-sync-unavailable"),
            sync_ports.clone(),
            "api",
            r#"{"name":"requestNotesSync","parameters":{}}"#
        )
        .is_err(),
        "Unassembled sync request API must stay unavailable"
    );
    assert_eq!(
        sync_ports.0.load(Ordering::SeqCst),
        0,
        "Ordinary sync must refuse before invoking any host service"
    );
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
    assert_eq!(package.manifest.database.migrations.len(), 4);
    assert_eq!(package.manifest.database.owned_tables.len(), 7);
    assert!(!package.manifest.accounts.supports_user_disable);
    assert!(package.manifest.navigation.is_empty());
    assert!(
        package.manifest.tools.len() == 1 && package.manifest.tools["notes.search"].risk == "read",
        "Only read-only search is offered; unfinished write tools stay unavailable"
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
            std::fs::read(
                root.join(
                    if moss_module_host::legacy::entry("notes", &path).is_some() {
                        "packages/notes"
                    } else {
                        "modules/notes"
                    }
                )
                .join(&path)
            )
            .unwrap()
        );
    }
}

#[test]
fn builder_refuses_changed_sql() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for changed in [
        "sql/0336_notes_managed_source_lifecycle.sql",
        "sql/0360_notes_sync_checkpoints.sql",
    ] {
        let temp = tempfile::tempdir().unwrap();
        for path in moss_notes_checks::manifest().unwrap().database.migrations {
            let owner = if moss_module_host::legacy::entry("notes", &path).is_some() {
                "packages/notes"
            } else {
                "modules/notes"
            };
            let destination = temp.path().join(owner).join(&path);
            std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
            std::fs::copy(root.join(owner).join(&path), destination).unwrap();
        }
        let owner = if moss_module_host::legacy::entry("notes", changed).is_some() {
            "packages/notes"
        } else {
            "modules/notes"
        };
        std::fs::write(
            temp.path().join(owner).join(changed),
            b"-- changed migration\n",
        )
        .unwrap();
        assert!(moss_notes_checks::package_files(temp.path(), vec![])
            .unwrap_err()
            .to_string()
            .contains("Notes migration bytes changed"));
    }
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
