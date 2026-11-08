//! Compiled guest folder settings through installed routing, real preferences and roots.
#[path = "support/mod.rs"]
mod support;
use access_context::AccessContext;
use moss_module_host::{
    folder_settings::{FolderSetting, FolderSettingsPorts},
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    registry::Source,
    runtime::{DenyPorts, Host, Limits},
    sql::LegacyInventory,
    store::Installer,
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::Secret,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use uuid::Uuid;

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn installed_settings_match_legacy_and_owner_privacy_fails_without_rls() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var_os("NOTES_SETTINGS_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
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
        for migration in [
            moss_module_host::postgres::MIGRATION,
            moss_module_host::migrations::MIGRATION,
            moss_platform_jobs::MIGRATION,
            moss_module_host::jobs::MIGRATION,
        ] {
            db.batch_execute(migration).await.unwrap();
        }
        db
    });
    let database = rt
        .block_on(Database::connect(
            &std::env::var("JS55_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let actors: Vec<Uuid> = oracle["actors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().parse().unwrap())
        .collect();
    let roots: BTreeMap<_, _> = actors
        .iter()
        .zip(oracle["roots"].as_array().unwrap())
        .map(|(actor, path)| {
            (
                *actor,
                vec![std::path::PathBuf::from(path.as_str().unwrap())],
            )
        })
        .collect();
    let ports = FolderSettingsPorts::new(
        database.clone(),
        BTreeMap::from([(
            ("notes".into(), "source".into()),
            FolderSetting {
                path_key: "notes-source-path".into(),
                status_key: "notes-last-sync".into(),
                roots,
            },
        )]),
        Arc::new(DenyPorts),
    )
    .unwrap();
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let wasm = std::fs::read(std::env::var_os("NOTES_COMPONENT").unwrap()).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let keys = support::Registry::create(
        registry.path(),
        &moss_notes_checks::package_files(&repo, wasm).unwrap(),
    );
    let admin = AccessContext::new(actors[2], "notes-settings-install");
    let installer = Installer::new(
        data.path(),
        Arc::new(PostgresCatalog::new(database.clone(), admin.clone()).unwrap()),
        Arc::new(
            PostgresLifecycle::new(
                Secret::new(std::env::var("JS55_BOOTSTRAP_URL").unwrap()),
                database,
                data.path(),
            )
            .unwrap(),
        ),
        Host::new(Limits::default()).unwrap(),
        Arc::new(ports),
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
    let call = |actor, method: &str, path: &str, body: Value| -> Value {
        serde_json::from_str(
            &installer
                .dispatch_extended(
                    AccessContext::new(actor, "notes-settings-check"),
                    method,
                    &format!("/api/m/notes{path}"),
                    &body.to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    };
    for case in oracle["expected"].as_array().unwrap() {
        let actor: Uuid = case["actor"].as_str().unwrap().parse().unwrap();
        rt.block_on(async {
            bootstrap.execute("DELETE FROM app.preferences WHERE owner_user_id=$1",&[&actor]).await.unwrap();
            for (key,value) in [("notes-source-path",&case["source"]),("notes-last-sync",&case["status"])] {
                bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,$2,$3)",&[&actor,&key,value]).await.unwrap();
            }
        });
        let actual = call(
            actor,
            case["method"].as_str().unwrap(),
            case["route"].as_str().unwrap(),
            case["body"].clone(),
        );
        assert_eq!(
            actual, case["expected"],
            "{} {}",
            case["method"], case["route"]
        );
    }
    println!(
        "PASS {} actual legacy Settings handler comparisons through installed guest routes",
        oracle["expected"].as_array().unwrap().len()
    );
    rt.block_on(async {
        bootstrap.execute("DELETE FROM app.preferences WHERE owner_user_id=ANY($1::uuid[])",&[&actors]).await.unwrap();
        bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notes-source-path',$2)",&[&actors[0],&oracle["roots"][0]]).await.unwrap();
    });
    let private = || {
        for actor in &actors[1..] {
            assert_eq!(
                call(*actor, "GET", "/notes-source", Value::Null),
                json!({"status":200,"body":{"path":null}}),
                "Another account saw the private source"
            );
        }
    };
    private();
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"))
        .unwrap();
    let exposed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(private));
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY"))
        .unwrap();
    assert!(
        exposed.is_err(),
        "Privacy assertion must fail when RLS is removed"
    );
    private();
    for actor in &actors[1..] {
        let rejected = call(
            *actor,
            "PUT",
            "/notes-source",
            json!({"path":oracle["roots"][0],"actorUserId":actors[0]}),
        );
        assert_eq!(
            rejected["status"], 400,
            "Other account selected an owner's private root"
        );
        assert_eq!(
            call(*actor, "GET", "/notes-source", Value::Null)["body"]["path"],
            Value::Null
        );
    }
    assert_eq!(
        call(actors[0], "GET", "/notes-source", Value::Null)["body"]["path"],
        oracle["roots"][0]
    );
    call(actors[0], "PUT", "/notes-source", json!({"path":null}));
    assert!(Path::new(oracle["roots"][0].as_str().unwrap())
        .join("keep.md")
        .is_file());
    println!("PASS unrelated account and admin cannot read/link owner's source; privacy assertion failed without RLS and passed after restore; unlink retained files");
    let screen = installer
        .screen(&admin, "notes", "/settings/connections")
        .unwrap();
    assert!(screen.src.contains("/ui/index.html"));
}
