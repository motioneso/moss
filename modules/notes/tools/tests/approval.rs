//! Signed installed API, actual legacy hooks, real preferences/files and RLS removal.
#[path = "support/mod.rs"]
mod support;
use access_context::AccessContext;
use moss_module_host::{
    folder_settings::{FolderSetting, FolderSettingsPorts},
    linked_notes::{LinkedNotesPorts, PreferenceFolder, PreferenceFolders},
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    registry::Source,
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    sql::LegacyInventory,
    store::Installer,
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::Secret,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;
use vault::AllowedRoots;

struct CheckPorts(Mutex<Arc<dyn Ports>>);
impl Ports for CheckPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let next = self.0.lock().unwrap().clone();
        next.invoke(scope, port, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        let next = self.0.lock().unwrap().clone();
        next.finish_call(scope, success)
    }
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn installed_approval_api_matches_legacy_and_fails_privacy_without_rls() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var_os("NOTES_APPROVAL_ORACLE").unwrap()).unwrap(),
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
        if !db
            .query_one("SELECT to_regnamespace('moss_modules') IS NOT NULL", &[])
            .await
            .unwrap()
            .get::<_, bool>(0)
        {
            for migration in [
                moss_module_host::postgres::MIGRATION,
                moss_module_host::migrations::MIGRATION,
                moss_platform_jobs::MIGRATION,
                moss_module_host::jobs::MIGRATION,
            ] {
                db.batch_execute(migration).await.unwrap();
            }
        }
        db.execute("DELETE FROM moss_modules.catalog", &[])
            .await
            .unwrap();
        db
    });
    let actors: Vec<Uuid> = oracle["actors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().parse().unwrap())
        .collect();
    let root = PathBuf::from(oracle["root"].as_str().unwrap());
    let wasm = std::fs::read(std::env::var_os("NOTES_COMPONENT").unwrap()).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let registry = tempfile::tempdir().unwrap();
    let keys = support::Registry::create(
        registry.path(),
        &moss_notes_checks::package_files(&repo, wasm).unwrap(),
    );
    let admin = AccessContext::new(actors[2], "notes-approval-install");
    for (url, role) in [
        ("JS55_APP_URL", RuntimeRole::App),
        ("JS55_WORKER_URL", RuntimeRole::Worker),
    ] {
        rt.block_on(bootstrap.execute("DELETE FROM moss_modules.catalog", &[]))
            .unwrap();
        let database = rt
            .block_on(Database::connect(&std::env::var(url).unwrap(), 4, role))
            .unwrap();
        let data = tempfile::tempdir().unwrap();
        let check_ports = Arc::new(CheckPorts(Mutex::new(Arc::new(DenyPorts))));
        let installer = Installer::new(
            data.path(),
            Arc::new(PostgresCatalog::new(database.clone(), admin.clone()).unwrap()),
            Arc::new(
                PostgresLifecycle::new(
                    Secret::new(std::env::var("JS55_BOOTSTRAP_URL").unwrap()),
                    database.clone(),
                    data.path(),
                )
                .unwrap(),
            ),
            Host::new(Limits::default()).unwrap(),
            check_ports.clone(),
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
        assert!(moss_notes_checks::manifest()
            .unwrap()
            .provides
            .contains_key("prepareNoteAction"));
        let make_ports = |roots: Vec<PathBuf>| -> Arc<dyn Ports> {
            // Shared allowed anchor is intentional: without preferences RLS,
            // a private selected folder would be exposed despite root validation.
            let settings_roots = actors.iter().map(|a| (*a, roots.clone())).collect();
            let file_roots = actors
                .iter()
                .map(|a| {
                    (
                        *a,
                        AllowedRoots::for_account(
                            &AccessContext::new(*a, "approval-roots"),
                            roots.clone(),
                        ),
                    )
                })
                .collect();
            Arc::new(
                FolderSettingsPorts::new(
                    database.clone(),
                    BTreeMap::from([(
                        ("notes".into(), "source".into()),
                        FolderSetting {
                            path_key: "notes-source-path".into(),
                            status_key: "notes-last-sync".into(),
                            roots: settings_roots,
                        },
                    )]),
                    Arc::new(LinkedNotesPorts::new(
                        Arc::new(
                            PreferenceFolders::new(
                                database.clone(),
                                BTreeMap::from([(
                                    ("notes".into(), "source".into()),
                                    PreferenceFolder {
                                        preference: "notes-source-path".into(),
                                        relative_to: None,
                                    },
                                )]),
                                file_roots,
                            )
                            .unwrap(),
                        ),
                        Arc::new(DenyPorts),
                    )),
                )
                .unwrap(),
            )
        };
        let call = |actor, tool: &str, input: &str, ports: Arc<dyn Ports>| -> Value {
            *check_ports.0.lock().unwrap() = ports;
            serde_json::from_str(&installer.call("notes",AccessContext::new(actor,"notes-installed-approval"),"api",&json!({"name":"prepareNoteAction","parameters":{"tool":tool,"inputJson":input}}).to_string()).unwrap()).unwrap()
        };
        for case in oracle["expected"].as_array().unwrap() {
            rt.block_on(async {
                bootstrap.execute("DELETE FROM app.preferences WHERE owner_user_id=ANY($1::uuid[])",&[&actors]).await.unwrap();
                bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notes-source-path',$2)",&[&actors[0],&case["source"]]).await.unwrap();
            });
            let roots = serde_json::from_value(case["roots"].clone()).unwrap();
            let actual = call(
                actors[0],
                case["tool"].as_str().unwrap(),
                case["inputJson"].as_str().unwrap(),
                make_ports(roots),
            );
            assert_eq!(
                actual, case["expected"],
                "source {:?}; {}",
                case["source"], case["inputJson"]
            );
        }
        rt.block_on(async {
            bootstrap.execute("DELETE FROM app.preferences WHERE owner_user_id=ANY($1::uuid[])",&[&actors]).await.unwrap();
            bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'notes-source-path',$2)",&[&actors[0],&oracle["root"]]).await.unwrap();
        });
        let input = r#"{"path":"Journal/note.md"}"#;
        let private = || {
            for actor in &actors[1..] {
                assert_eq!(
                    call(
                        *actor,
                        "notes.delete",
                        input,
                        make_ports(vec![root.clone()])
                    ),
                    json!({"error":{"statusCode":409,"error":"Notes source is not configured"}}),
                    "Other account saw private approval target"
                );
            }
        };
        private();
        rt.block_on(
            bootstrap.batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"),
        )
        .unwrap();
        let exposed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(private));
        rt.block_on(
            bootstrap.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY"),
        )
        .unwrap();
        assert!(
            exposed.is_err(),
            "Approval privacy assertion must fail with RLS removed"
        );
        private();
        let first = call(
            actors[0],
            "notes.delete",
            input,
            make_ports(vec![root.clone()]),
        );
        assert!(first["ok"]["version"].is_string());
        assert_eq!(
            std::fs::read_to_string(root.join("Journal/note.md")).unwrap(),
            oracle["content"].as_str().unwrap()
        );
        // Preparation must not make the default package's write handler callable.
        assert!(installer
            .call(
                "notes",
                AccessContext::new(actors[0], "no-approved-write"),
                "tool",
                r#"{"tool":"notes.delete","parameters":{"path":"Journal/note.md"}}"#
            )
            .is_err());
        std::fs::write(root.join("Journal/note.md"), "external synthetic edit").unwrap();
        let changed = call(
            actors[0],
            "notes.delete",
            input,
            make_ports(vec![root.clone()]),
        );
        assert_ne!(first["ok"]["version"], changed["ok"]["version"]);
        std::fs::write(
            root.join("Journal/note.md"),
            oracle["content"].as_str().unwrap(),
        )
        .unwrap();
        println!("PASS {:?}: {} legacy approval/source comparisons; other-account/admin RLS negative control; preparation is read-only; versions change with content",role,oracle["expected"].as_array().unwrap().len());
    }
}
