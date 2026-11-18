//! Production Notes component and signed package against disposable PostgreSQL only.
mod support;
use access_context::AccessContext;
use moss_module_host::{
    legacy,
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    registry::Source,
    runtime::{DenyPorts, Host, Limits, Ports},
    sql::LegacyInventory,
    store::Installer,
    transactional_database::TransactionalDatabasePorts,
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::Secret,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use uuid::Uuid;

const REQUEST: &str = r#"{"name":"collectManagedNotesExportSection","parameters":{}}"#;

async fn snapshot(db: &tokio_postgres::Client) -> BTreeMap<String, Value> {
    let mut rows = BTreeMap::new();
    for table in legacy::tables("notes") {
        let result = db.query_one(&format!("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner_user_id,to_jsonb(t)::text),'[]'::jsonb) FROM {table} t"), &[]).await.unwrap();
        rows.insert(table.clone(), result.get(0));
    }
    let ledger = db.query_one("SELECT jsonb_agg(to_jsonb(t) ORDER BY version) FROM app.schema_migrations t WHERE version IN ('0336','0337','0340')", &[]).await.unwrap();
    let ledger: Value = ledger.get(0);
    assert_eq!(
        ledger
            .as_array()
            .expect("Legacy ledger rows must exist")
            .len(),
        3
    );
    rows.insert("ledger".into(), ledger);
    rows
}

#[test]
#[ignore = "Only through scripts/run-gate.sh and modules/notes/tools/gate.sh"]
fn installed_notes_export_matches_legacy_and_rls_controls_fail_first() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let oracle: Value =
        serde_json::from_slice(&std::fs::read(std::env::var_os("NOTES_ORACLE").unwrap()).unwrap())
            .unwrap();
    let wasm = std::fs::read(std::env::var_os("NOTES_COMPONENT").unwrap()).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let bootstrap = rt.block_on(async {
        let (db, connection) = tokio_postgres::connect(
            &std::env::var("JS55_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.batch_execute(moss_module_host::postgres::MIGRATION)
            .await
            .unwrap();
        db.batch_execute(moss_module_host::migrations::MIGRATION)
            .await
            .unwrap();
        db.batch_execute(moss_platform_jobs::MIGRATION)
            .await
            .unwrap();
        db.batch_execute(moss_module_host::jobs::MIGRATION)
            .await
            .unwrap();
        db
    });
    let before = rt.block_on(snapshot(&bootstrap));
    let manifest = Arc::new(moss_notes_checks::read_only_manifest().unwrap());
    let host = Host::new(Limits::default()).unwrap();
    host.validate(&wasm, &manifest).unwrap();
    let mut ports = BTreeMap::<&str, Arc<dyn Ports>>::new();
    let mut app = None;
    for (role, env, runtime_role) in [
        ("app", "JS55_APP_URL", RuntimeRole::App),
        ("worker", "JS55_WORKER_URL", RuntimeRole::Worker),
    ] {
        let database = rt
            .block_on(Database::connect(
                &std::env::var(env).unwrap(),
                4,
                runtime_role,
            ))
            .unwrap();
        if role == "app" {
            app = Some(database.clone());
        }
        ports.insert(
            role,
            Arc::new(TransactionalDatabasePorts::new(database, Arc::new(DenyPorts)).unwrap()),
        );
    }
    let run = |case: &Value| -> Value {
        let reply = host
            .call(
                &wasm,
                manifest.clone(),
                AccessContext::new(
                    Uuid::parse_str(case["actor"].as_str().unwrap()).unwrap(),
                    "notes-export",
                ),
                ports[case["role"].as_str().unwrap()].clone(),
                "api",
                REQUEST,
            )
            .expect("Production Notes export must execute");
        serde_json::from_str(&reply).unwrap()
    };
    // Baseline is taken from the real TypeScript collector, on identical committed rows.
    for case in oracle["expected"].as_array().unwrap() {
        assert_eq!(run(case), case["value"], "legacy export parity");
    }
    println!("PASS compiled Notes export: six TypeScript comparisons across both owners and unrelated admin, app and worker; source pagination crossed");
    for (table, section) in [
        ("app.notes_managed_actors", "actors"),
        ("app.notes_managed_sources", "sources"),
        ("app.notes_destination_bindings", "bindings"),
        ("app.notes_recording_contributions", "contributions"),
        ("app.notes_contribution_proposals", "proposals"),
        ("app.notes_contribution_operations", "operations"),
    ] {
        rt.block_on(
            bootstrap.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")),
        )
        .unwrap();
        let exposed: Vec<_> = oracle["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| (run(case)[section].clone(), case["value"][section].clone()))
            .collect();
        rt.block_on(
            bootstrap.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")),
        )
        .unwrap();
        let failed = exposed
            .into_iter()
            .filter(|(actual, expected)| {
                std::panic::catch_unwind(|| {
                    assert!(
                        actual == expected,
                        "export privacy assertion failed without RLS"
                    )
                })
                .is_err()
            })
            .count();
        assert_eq!(
            failed, 6,
            "each real guest privacy assertion must detect missing RLS"
        );
        for case in oracle["expected"].as_array().unwrap() {
            assert_eq!(run(case), case["value"]);
        }
        println!("PASS {table}: six production guest assertions failed without RLS; all restored exports match");
    }
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let files = moss_notes_checks::package_files(&root, wasm).unwrap();
    let keys = support::Registry::create(registry.path(), &files);
    let admin = AccessContext::new(
        Uuid::parse_str(oracle["actors"][2].as_str().unwrap()).unwrap(),
        "notes-install",
    );
    let app = app.unwrap();
    let installer = Installer::new(
        data.path(),
        Arc::new(PostgresCatalog::new(app.clone(), admin.clone()).unwrap()),
        Arc::new(
            PostgresLifecycle::new(
                Secret::new(std::env::var("JS55_BOOTSTRAP_URL").unwrap()),
                app,
                data.path(),
            )
            .unwrap(),
        ),
        Host::new(Limits::default()).unwrap(),
        ports["app"].clone(),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let source = installer
        .refresh(
            &admin,
            Source::Folder(registry.path().into()),
            &keys.public,
            &keys.public,
            "notes-test-registry",
        )
        .unwrap();
    installer
        .install(&admin, &source, &keys.artifact, true)
        .unwrap();
    for case in oracle["expected"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["role"] == "app")
    {
        let access = AccessContext::new(
            Uuid::parse_str(case["actor"].as_str().unwrap()).unwrap(),
            "installed-notes",
        );
        let actual: Value = serde_json::from_str(
            &installer
                .call("notes", access.clone(), "api", REQUEST)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(actual, case["value"]);
        assert!(
            installer.set_enabled(&access, "notes", false).is_err(),
            "Legacy required Notes must remain enabled"
        );
        assert!(installer.call("notes", access, "api", &json!({"name":"collectManagedNotesExportSection","parameters":{"actorUserId":oracle["actors"][0]}}).to_string()).is_err());
    }
    assert_eq!(
        rt.block_on(snapshot(&bootstrap)),
        before,
        "Signed install and export retain all six tables and legacy migration identities"
    );
    println!("PASS signed registry package installed through real PostgreSQL lifecycle; actual guest dispatch, required-module disable refusal and forged actor refusal; original rows and core ledger unchanged");
}
