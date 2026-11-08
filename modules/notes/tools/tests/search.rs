//! Installed real guest + PostgreSQL retrieval. Query embeddings are an explicit
//! deterministic stand-in, identical to the legacy oracle; this is not live chat.
#[path = "support/mod.rs"]
mod support;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    memory_search::{MemorySearchPorts, QueryEmbeddings},
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    registry::Source,
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    sql::LegacyInventory,
    store::Installer,
};
use safety_core::{
    db::{DataContext, Database, RuntimeRole},
    secret::Secret,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

struct Embeddings {
    vectors: BTreeMap<String, Vec<f64>>,
    actors: Mutex<Vec<Uuid>>,
}
impl QueryEmbeddings for Embeddings {
    fn embed_query(&self, scope: &CallScope, query: &str) -> Result<Vec<f64>> {
        self.actors
            .lock()
            .unwrap()
            .push(scope.access().actor_user_id());
        self.vectors.get(query).cloned().ok_or_else(|| {
            anyhow::anyhow!("Synthetic provider error containing private query: {query}")
        })
    }
}

// Emulate a trusted outer wrapper to exercise adapter checks independently of
// the guest's input parser and the Wasm linker's permission check.
struct Rewrite {
    next: Arc<dyn Ports>,
    request: Request,
}
impl Ports for Rewrite {
    fn invoke(&self, scope: &CallScope, port: &str, _: &Request) -> Result<Value> {
        self.next.invoke(scope, port, &self.request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

// Check the database protection directly; the production search additionally
// filters owner_user_id, which must still protect it when RLS is removed below.
fn privacy_probe(
    rt: &tokio::runtime::Runtime,
    db: &Database,
    actor: Uuid,
    owner: Uuid,
) -> (usize, u64, u64) {
    rt.block_on(async {
        let cx = DataContext::open(db, &AccessContext::new(actor, "notes-search-privacy"))
            .await
            .unwrap();
        let rows = cx
            .db()
            .query(
                "SELECT text FROM app.memory_chunks WHERE owner_user_id=$1",
                &[&owner],
            )
            .await
            .unwrap();
        let updated = cx
            .db()
            .execute(
                "UPDATE app.memory_chunks SET text='negative control' WHERE owner_user_id=$1",
                &[&owner],
            )
            .await
            .unwrap();
        let deleted = cx
            .db()
            .execute(
                "DELETE FROM app.memory_chunks WHERE owner_user_id=$1",
                &[&owner],
            )
            .await
            .unwrap();
        // Drop rolls back both negative-control writes.
        (rows.len(), updated, deleted)
    })
}

#[test]
#[ignore = "Only through scripts/run-gate.sh"]
fn installed_search_matches_legacy_and_privacy_controls_fail_first() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var_os("NOTES_SEARCH_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let actors: Vec<Uuid> = serde_json::from_value(oracle["actors"].clone()).unwrap();
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
    let app = rt
        .block_on(Database::connect(
            &std::env::var("JS55_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let worker = rt
        .block_on(Database::connect(
            &std::env::var("JS55_WORKER_URL").unwrap(),
            4,
            RuntimeRole::Worker,
        ))
        .unwrap();
    let embeddings = Arc::new(Embeddings {
        vectors: serde_json::from_value(oracle["queries"].clone()).unwrap(),
        actors: Mutex::new(vec![]),
    });
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let wasm = std::fs::read(std::env::var_os("NOTES_COMPONENT").unwrap()).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let keys = support::Registry::create(
        registry.path(),
        &moss_notes_checks::package_files(&repo, wasm.clone()).unwrap(),
    );
    let admin = AccessContext::new(actors[2], "notes-search-install");
    let make = |database: Database, sources: BTreeMap<(String, String), String>| {
        Installer::new(
            data.path(),
            // Installer metadata uses app credentials even for worker execution.
            Arc::new(PostgresCatalog::new(app.clone(), admin.clone()).unwrap()),
            Arc::new(
                PostgresLifecycle::new(
                    Secret::new(std::env::var("JS55_BOOTSTRAP_URL").unwrap()),
                    app.clone(),
                    data.path(),
                )
                .unwrap(),
            ),
            Host::new(Limits::default()).unwrap(),
            Arc::new(
                MemorySearchPorts::new(database, embeddings.clone(), sources, Arc::new(DenyPorts))
                    .unwrap(),
            ),
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap()
    };
    let sources = BTreeMap::from([(("notes".into(), "source".into()), "notes".into())]);
    let installed = make(app.clone(), sources.clone());
    let source = installed
        .refresh(
            &admin,
            Source::Folder(registry.path().into()),
            &keys.public,
            &keys.public,
            "notes-test-registry",
        )
        .unwrap();
    installed
        .install(&admin, &source, &keys.artifact, true)
        .unwrap();
    let worker_installed = make(worker.clone(), sources);
    let run = |case: &Value| -> Value {
        let installer = if case["role"] == "app" {
            &installed
        } else {
            &worker_installed
        };
        let actor: Uuid = case["actor"].as_str().unwrap().parse().unwrap();
        let payload = json!({"tool":"notes.search","parameters":case["parameters"]});
        serde_json::from_str(
            &installer
                .call(
                    "notes",
                    AccessContext::new(actor, "notes-search"),
                    "tool",
                    &payload.to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    };
    for case in oracle["expected"].as_array().unwrap() {
        assert_eq!(run(case), case["value"], "{case}");
    }
    assert_eq!(
        embeddings.actors.lock().unwrap().len(),
        18,
        "Empty queries never embed"
    );
    println!("PASS installed compiled Notes search: 24 legacy comparisons, two owners and unrelated admin, app and worker, semantic order, source filter, limit and exact projection");
    for db in [&app, &worker] {
        for actor in &actors[1..] {
            assert_eq!(privacy_probe(&rt, db, *actor, actors[0]), (0, 0, 0));
        }
    }
    rt.block_on(
        bootstrap.batch_execute("ALTER TABLE app.memory_chunks DISABLE ROW LEVEL SECURITY"),
    )
    .unwrap();
    let mut failures = 0;
    for db in [&app, &worker] {
        for actor in &actors[1..] {
            let actual = privacy_probe(&rt, db, *actor, actors[0]);
            failures += usize::from(
                std::panic::catch_unwind(|| {
                    assert_eq!(
                        actual,
                        (0, 0, 0),
                        "privacy assertion must fail with RLS removed"
                    )
                })
                .is_err(),
            );
        }
    }
    // A second, independent owner predicate keeps the actual compiled search private.
    for case in oracle["expected"].as_array().unwrap() {
        assert_eq!(run(case), case["value"]);
    }
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.memory_chunks ENABLE ROW LEVEL SECURITY"))
        .unwrap();
    assert_eq!(failures, 4);
    for db in [&app, &worker] {
        for actor in &actors[1..] {
            assert_eq!(privacy_probe(&rt, db, *actor, actors[0]), (0, 0, 0));
        }
    }
    println!("PASS memory RLS removal control: four cross-account read/update/delete assertions failed without RLS, passed restored; compiled search stayed owner-only with RLS removed");

    let manifest = Arc::new(moss_notes_checks::manifest().unwrap());
    let host = Host::new(Limits::default()).unwrap();
    let missing = make(app.clone(), BTreeMap::new());
    assert!(missing
        .call(
            "notes",
            AccessContext::new(actors[0], "unbound-search"),
            "tool",
            r#"{"tool":"notes.search","parameters":{"query":"coffee"}}"#
        )
        .is_err());
    let ports: Arc<dyn Ports> = Arc::new(
        MemorySearchPorts::new(
            worker,
            embeddings.clone(),
            BTreeMap::from([(("notes".into(), "source".into()), "notes".into())]),
            Arc::new(DenyPorts),
        )
        .unwrap(),
    );
    let before = embeddings.actors.lock().unwrap().len();
    for parameters in [
        json!({"query":"coffee","limit":1,"sourceKind":"vault"}),
        json!({"query":"coffee","limit":0}),
        json!({"query":"coffee","limit":21}),
        json!({"query":"coffee","limit":1,"ownerUserId":actors[0]}),
    ] {
        assert!(host
            .call(
                &wasm,
                manifest.clone(),
                AccessContext::new(actors[1], "forged-search"),
                Arc::new(Rewrite {
                    next: ports.clone(),
                    request: Request {
                        operation: "index.search".into(),
                        resource: "source".into(),
                        parameters
                    }
                }),
                "tool",
                r#"{"tool":"notes.search","parameters":{"query":"coffee"}}"#
            )
            .is_err());
    }
    let mut denied = (*manifest).clone();
    denied
        .capabilities
        .iter_mut()
        .find(|c| c.port == "vault")
        .unwrap()
        .operations
        .retain(|op| op != "index.search");
    assert!(host
        .call(
            &wasm,
            Arc::new(denied),
            AccessContext::new(actors[1], "denied-search"),
            ports.clone(),
            "tool",
            r#"{"tool":"notes.search","parameters":{"query":"coffee"}}"#
        )
        .is_err());
    assert_eq!(
        embeddings.actors.lock().unwrap().len(),
        before,
        "Rejected calls never reach the provider"
    );
    let failure = host
        .call(
            &wasm,
            manifest,
            AccessContext::new(actors[0], "provider-failure"),
            ports,
            "tool",
            r#"{"tool":"notes.search","parameters":{"query":"private-error-marker"}}"#,
        )
        .unwrap_err();
    assert!(!format!("{failure:#}").contains("private-error-marker"));
    println!("PASS unbound source, undeclared capability, forged parameters, invalid limits, and provider error redaction");
}
