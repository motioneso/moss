//! Differential route envelopes, not installed HTTP or live UI evidence.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
#[path = "../../parity/src/canon.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod parity_canon;
use access_context::AccessContext;
use moss_module_host::{
    account_preferences::{AccountPreferencesPorts, Binding},
    context::ContextPorts,
    dispatch,
    linked_notes::{LinkedNotesPorts, PreferenceFolder, PreferenceFolders},
    runtime::{Host, Limits},
    transactional_database::TransactionalDatabasePorts,
};
use moss_people::repository::TABLES;
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};
use uuid::Uuid;
use vault::AllowedRoots;

#[test]
#[ignore = "Only through verify-gate and modules/people/tools/routes-gate.sh"]
fn compiled_people_routes_match_legacy_http_handlers_and_rows() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let component = std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap();
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("JS58_PEOPLE_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let database = rt
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let notes = tempfile::tempdir().unwrap();
    let notes_root = notes.path().join("People");
    std::fs::create_dir_all(notes_root.join("Family/Friends")).unwrap();
    std::fs::create_dir_all(notes_root.join("Work")).unwrap();
    let roots = ["actor", "other", "admin"]
        .into_iter()
        .map(|key| {
            let actor = Uuid::parse_str(oracle[key].as_str().unwrap()).unwrap();
            let access = AccessContext::new(actor, "people-route-roots");
            (
                actor,
                AllowedRoots::for_account(
                    &access,
                    if key == "actor" {
                        vec![notes_root.clone()]
                    } else {
                        vec![]
                    },
                ),
            )
        })
        .collect();
    let folders = PreferenceFolders::new(
        database.clone(),
        BTreeMap::from([(
            ("people".into(), "people-notes".into()),
            PreferenceFolder {
                preference: "people-notes-folder".into(),
                relative_to: Some("notes-source-path".into()),
            },
        )]),
        roots,
    )
    .unwrap();
    let data = tempfile::tempdir().unwrap();
    let services = installed::services(data.path());
    let preferences = Arc::new(
        AccountPreferencesPorts::new(
            database.clone(),
            BTreeMap::from([(
                ("people".into(), "people-folder".into()),
                Binding::Folder {
                    key: "people-notes-folder".into(),
                    roots: ["actor", "other", "admin"]
                        .into_iter()
                        .map(|key| {
                            (
                                Uuid::parse_str(oracle[key].as_str().unwrap()).unwrap(),
                                if key == "actor" {
                                    vec![notes_root.clone()]
                                } else {
                                    vec![]
                                },
                            )
                        })
                        .collect(),
                },
            )]),
            Arc::new(ContextPorts::new(services.clone())),
        )
        .unwrap(),
    );
    let ports = Arc::new(
        TransactionalDatabasePorts::new(
            database.clone(),
            Arc::new(LinkedNotesPorts::new(Arc::new(folders), preferences)),
        )
        .unwrap(),
    );
    let manifest = Arc::new(
        serde_json::from_str::<moss_module_host::manifest::Manifest>(include_str!(
            "../../../modules/people/moss.module.json"
        ))
        .unwrap(),
    );
    let host = Host::new(Limits::default()).unwrap();
    let known: HashSet<_> = oracle["knownIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let mut expected = parity_canon::Canon::new(
        oracle["startedAt"].as_str().unwrap().parse().unwrap(),
        &known,
    );
    let mut actual = parity_canon::Canon::new(chrono::Utc::now(), &known);
    let bootstrap = rt.block_on(async {
        let (db, connection) = tokio_postgres::connect(
            &std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db
    });
    let admin = AccessContext::new(
        Uuid::parse_str(oracle["admin"].as_str().unwrap()).unwrap(),
        "people-install",
    );
    let registry = tempfile::tempdir().unwrap();
    let installer = std::env::var_os("JS73_PEOPLE_PACKAGE").map(|_| {
        rt.block_on(async {
            bootstrap
                .batch_execute(moss_module_host::postgres::MIGRATION)
                .await
                .unwrap();
            bootstrap
                .batch_execute(moss_module_host::migrations::MIGRATION)
                .await
                .unwrap();
            bootstrap
                .batch_execute(moss_platform_jobs::MIGRATION)
                .await
                .unwrap();
            bootstrap
                .batch_execute(moss_module_host::jobs::MIGRATION)
                .await
                .unwrap();
        });
        let initial = installed::install(
            data.path(),
            registry.path(),
            database.clone(),
            &admin,
            ports.clone(),
        );
        drop(initial);
        let reopened = Arc::new(installed::reopen(
            data.path(),
            database.clone(),
            &admin,
            ports.clone(),
        ));
        services.bind(&reopened);
        println!("People signed package downloaded, installed with legacy SQL and reloaded");
        reopened
    });
    let owner = Uuid::parse_str(oracle["actor"].as_str().unwrap()).unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let method = case["method"].as_str().unwrap();
        let path = case["path"].as_str().unwrap();
        let mut request = dispatch::resolve(&manifest.routes, method, path).unwrap();
        request.body = case["body"].clone();
        let access = AccessContext::new(
            Uuid::parse_str(case["actor"].as_str().unwrap()).unwrap(),
            "people-route-parity",
        );
        let reply = if let Some(installer) = &installer {
            installer.dispatch_extended(
                access,
                method,
                &format!("/api/m/people{path}"),
                &case["body"].to_string(),
            )
        } else {
            host.call(
                &component,
                manifest.clone(),
                access,
                ports.clone(),
                "route",
                &serde_json::to_string(&request).unwrap(),
            )
        }
        .expect("Compiled route must return a response envelope");
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(
            actual.value(&reply),
            expected.value(&case["expected"]),
            "Route response differs: {method} {path}"
        );
        for table in TABLES {
            let rows: Vec<Value> = rt.block_on(async {
                bootstrap
                    .query(
                        &format!("SELECT to_jsonb(p) FROM {table} p WHERE owner_user_id=$1"),
                        &[&owner],
                    )
                    .await
                    .unwrap()
                    .iter()
                    .map(|r| r.get(0))
                    .collect()
            });
            assert_eq!(
                actual.rows(&rows),
                expected.rows(case["rows"][table].as_array().unwrap()),
                "Rows differ after {method} {path}: {table}"
            );
        }
    }
    if let Some(installer) = &installer {
        for (name, parameters) in [
            ("findPeopleByNames", json!({"names":["Route split"]})),
            ("resolve", json!({"query":"Route split"})),
            ("getPerson", json!({"personId":oracle["ids"]["primary"]})),
            ("listEmailIdentityValues", json!({})),
        ] {
            let access = AccessContext::new(owner, "people-consumer");
            let direct = host
                .call(
                    &component,
                    manifest.clone(),
                    access.clone(),
                    ports.clone(),
                    "api",
                    &json!({"name":name,"parameters":parameters}).to_string(),
                )
                .unwrap();
            let routed = installer.call("people.consumer",access,"route",&json!({"operation":"call","resource":"people","parameters":{"name":name,"parameters":parameters}}).to_string()).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&routed).unwrap(),
                serde_json::from_str::<Value>(&direct).unwrap(),
                "Installed consumer API {name}"
            );
        }
        for key in ["other", "admin"] {
            let reply = installer.call("people.consumer",AccessContext::new(Uuid::parse_str(oracle[key].as_str().unwrap()).unwrap(),"consumer-privacy"),"route",&json!({"operation":"call","resource":"people","parameters":{"name":"findPeopleByNames","parameters":{"names":["Route split"]}}}).to_string()).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&reply).unwrap(), json!([]));
        }
        let screen = installer
            .screen(
                &AccessContext::new(owner, "people-screen"),
                "people",
                "/settings/memory/people",
            )
            .unwrap();
        assert_eq!(screen.sandbox, "allow-scripts");
        let parts: Vec<_> = screen.src.splitn(5, '/').collect();
        let asset = installer
            .ui_asset(
                "people",
                parts[3],
                parts[4],
                &moss_module_host::frame::AssetPolicy::new("https://moss.example.test").unwrap(),
            )
            .unwrap();
        assert!(String::from_utf8(asset.body).unwrap().contains("people.js"));
        println!("All four public APIs routed through an installed consumer; other-user/admin lookup denied; installed Settings asset verified (no browser claimed)");
        let request = |actor, method, path, body: Value| {
            serde_json::from_str::<Value>(
                &installer
                    .dispatch_extended(
                        AccessContext::new(actor, "installed-folder"),
                        method,
                        &format!("/api/m/people{path}"),
                        &body.to_string(),
                    )
                    .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            request(
                owner,
                "PUT",
                "/people/notes-settings",
                json!({"folder":notes_root})
            )["status"],
            200
        );
        assert_eq!(
            request(
                owner,
                "PUT",
                "/people/notes-settings",
                json!([{"folder":"Work"}])
            ),
            json!({"status":400,"body":{"error":"body must be object"}})
        );
        assert_eq!(
            request(owner, "GET", "/people/notes-settings", Value::Null),
            json!({"status":200,"body":{"folder":notes_root}})
        );
        let person_path = format!("/people/{}", oracle["ids"]["primary"].as_str().unwrap());
        assert_eq!(
            request(owner, "PATCH", &person_path, json!({"aliases":{}}))["status"],
            200,
            "A missing canonical note falls back before reading note-only fields"
        );
        assert_eq!(
            request(owner, "GET", "/people/notes-directories", Value::Null),
            json!({"status":200,"body":{"path":null,"directories":[{"name":"Family","path":"Family"},{"name":"Work","path":"Work"}]}})
        );
        assert_eq!(
            request(
                owner,
                "GET",
                "/people/notes-directories?path=Family",
                Value::Null
            ),
            json!({"status":200,"body":{"path":"Family","directories":[{"name":"Friends","path":"Family/Friends"}]}})
        );
        assert_eq!(
            request(
                owner,
                "GET",
                "/people/notes-directories?path=..",
                Value::Null
            )["status"],
            400
        );
        for key in ["other", "admin"] {
            let actor = Uuid::parse_str(oracle[key].as_str().unwrap()).unwrap();
            assert_eq!(
                request(actor, "GET", "/people/notes-directories", Value::Null)["status"],
                400
            );
        }
        assert_eq!(
            request(owner, "PUT", "/people/notes-settings", json!({"folder":""})),
            json!({"status":400,"body":{"error":"People notes folder is unavailable"}})
        );
        assert_eq!(
            request(owner, "GET", "/people/notes-settings", Value::Null),
            json!({"status":200,"body":{"folder":notes_root}})
        );
        println!("Installed folder save, invalid root-array refusal without clearing, relative root/child browsing, traversal refusal, other-user/admin fixture refusals and empty-folder refusal without clearing passed");
        installed::clear_catalog(database, admin);
    }
    println!("{} legacy route responses and all seven table snapshots matched, including other-user/admin attempts",oracle["cases"].as_array().unwrap().len());
}
