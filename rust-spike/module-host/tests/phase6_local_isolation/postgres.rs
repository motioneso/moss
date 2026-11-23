use super::fixture;
use moss_module_host::{
    application::{Application, Configuration},
    archive::{self, Package},
    jobs::{manifest_hash, module_key, specs},
    local_packages,
    runtime::Limits,
};
use moss_platform_contracts::Actor;
use moss_platform_jobs::{Queue, Role};
use safety_core::{
    db::{DataContext, Database, RuntimeRole},
    secret::Secret,
};
use serde_json::json;
use std::sync::Arc;

fn open(f: &fixture::Fixture, db: Database) -> Application {
    Application::open_extended(
        f.data.path(),
        db,
        f.admin.clone(),
        Configuration {
            migrations: Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS43_APP_URL").unwrap()),
            cipher: f.cipher.clone(),
            intelligence: Arc::new(fixture::NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: Some(Limits::default().fuel),
            browser_dir: None,
        },
    )
    .unwrap()
}
fn bytes(f: &fixture::Fixture, version: &str) -> Vec<u8> {
    let original = f.bytes(version);
    let mut package =
        Package::read_for_review(&original, &moss_module_host::trust::digest(&original)).unwrap();
    let manifest = &mut package.manifest;
    manifest.jobs.insert("tick".into(), Default::default());
    manifest.capabilities.push(
        serde_json::from_value(
            json!({"port":"jobs","operations":["enqueue"],"resources":["tick"]}),
        )
        .unwrap(),
    );
    manifest.job_retries.insert("tick".into(), 0);
    let table = format!(
        "app.{}rows",
        moss_module_host::manifest::table_prefix(&f.id)
    );
    manifest.database.owned_tables.push(table.clone());
    manifest.database.migrations.push("sql/001_rows.sql".into());
    package.files.insert("sql/001_rows.sql".into(), format!("CREATE TABLE {table} (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES app.users(id), title text NOT NULL)").into_bytes());
    package.files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(manifest).unwrap(),
    );
    archive::pack(&package.files).unwrap()
}
#[test]
#[ignore = "Requires verify-gate test:rust-phase6-local-isolation"]
fn installed_postgres_local_lifecycle_and_job_isolation() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let f = fixture::Fixture::new();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (db, database) = rt.block_on(async {
        let (db, connection) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { connection.await.unwrap(); });
        for sql in [moss_module_host::postgres::MIGRATION, moss_module_host::migrations::MIGRATION,
            moss_platform_jobs::MIGRATION, moss_module_host::jobs::MIGRATION, local_packages::MIGRATION, local_packages::LIFECYCLE_MIGRATION] {
            db.batch_execute(sql).await.unwrap();
        }
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'local-owner@example.test','Builder',false),($2,'local-other@example.test','Other',false),($3,'local-admin@example.test','Admin',true)", &[&f.owner.actor_user_id(), &f.other.actor_user_id(), &f.admin.actor_user_id()]).await.unwrap();
        let database = Database::connect(&std::env::var("JS43_APP_URL").unwrap(), 4, RuntimeRole::App).await.unwrap();
        (db, database)
    });
    let first = bytes(&f, "1.0.0");
    let signature = f.signer.sign(&f.owner, &first).unwrap();
    let verified = f.signer.verify(&f.owner, &first, &signature).unwrap();
    rt.block_on(local_packages::record(&database, &f.owner, &verified))
        .unwrap();
    let assert_rows = |visible: bool| {
        rt.block_on(async {
            for actor in [&f.owner, &f.other, &f.admin] {
                // Metadata queries use the signed-in DataContext, never the auth DB role.
                let cx = DataContext::open(&database, actor).await.unwrap();
                let rows = cx
                    .db()
                    .query(
                        "SELECT module_id,digest FROM moss_modules.local_packages",
                        &[],
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    rows.len(),
                    usize::from(visible || actor.actor_user_id() == f.owner.actor_user_id()),
                    "PRIVATE-CATALOG-MARKER RLS leak for {}",
                    actor.request_id()
                );
                cx.commit().await.unwrap();
            }
        });
    };
    assert_rows(false);
    // Prove the very same account-scoped query exposes the planted package when RLS is removed.
    rt.block_on(
        db.batch_execute("ALTER TABLE moss_modules.local_packages DISABLE ROW LEVEL SECURITY"),
    )
    .unwrap();
    assert_rows(true);
    rt.block_on(db.batch_execute("ALTER TABLE moss_modules.local_packages ENABLE ROW LEVEL SECURITY; ALTER TABLE moss_modules.local_packages FORCE ROW LEVEL SECURITY")).unwrap();
    assert_rows(false);
    println!(
        "local catalog RLS: owner marker visible with policy disabled, hidden after restoration"
    );
    let mut app = open(&f, database.clone());
    app.installer
        .install_local(&f.owner, &f.signer, &first, &signature, true)
        .unwrap();
    rt.block_on(async {
        let cx = DataContext::open(&database, &f.admin).await.unwrap();
        let state: serde_json::Value = cx
            .db()
            .query_one("SELECT state FROM moss_modules.catalog WHERE id", &[])
            .await
            .unwrap()
            .get(0);
        assert!(
            !state.to_string().contains("PRIVATE-NAV-MARKER"),
            "PRIVATE-CATALOG-MARKER admin read local manifest metadata"
        );
        cx.commit().await.unwrap();
    });
    let manifest = Package::read_for_review(&first, &signature.digest)
        .unwrap()
        .manifest;
    let queue = rt
        .block_on(Queue::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            Role::Producer,
            specs(&manifest),
        ))
        .unwrap();
    let worker = Secret::new(std::env::var("JS43_WORKER_URL").unwrap());
    for actor in [&f.owner, &f.other, &f.admin] {
        rt.block_on(queue.enqueue(Actor::from_authenticated_session(actor.actor_user_id(), uuid::Uuid::new_v4()), &specs(&manifest)[0].name,
            json!({"actorUserId":actor.actor_user_id(),"moduleId":module_key(&manifest.id),"manifestHash":manifest_hash(&manifest),"jobKind":specs(&manifest)[0].name,"params":{}}), uuid::Uuid::new_v4(), chrono::Utc::now())).unwrap();
        let result = app.installer.run_job(&worker);
        assert!(
            !matches!(result, Ok(false)),
            "queued fixture was not claimed: {}",
            actor.request_id()
        );
        assert_eq!(
            result.is_ok(),
            actor.actor_user_id() == f.owner.actor_user_id(),
            "PRIVATE-CODE-MARKER job reached guest for {}: {result:?}",
            actor.request_id()
        );
    }
    drop(app);
    app = open(&f, database.clone());
    assert!(app
        .installer
        .call(&f.id, f.owner.clone(), "health", "{}")
        .unwrap()
        .contains("PRIVATE-CODE-MARKER"));
    for actor in [&f.other, &f.admin] {
        assert!(app.installer.installed_for(actor).unwrap().is_empty());
        assert!(app.installer.package_for_account(actor, &f.id).is_err());
    }
    let next = bytes(&f, "2.0.0");
    let signature = f.signer.sign(&f.owner, &next).unwrap();
    let verified = f.signer.verify(&f.owner, &next, &signature).unwrap();
    // This previously refused a changed digest, preventing a locally signed upgrade.
    rt.block_on(local_packages::record(&database, &f.owner, &verified))
        .unwrap();
    app.installer
        .install_local(&f.owner, &f.signer, &next, &signature, true)
        .unwrap();
    assert_eq!(
        app.installer.installed_for(&f.owner).unwrap()[0]
            .manifest
            .version
            .to_string(),
        "2.0.0"
    );
    app.installer.remove(&f.owner, &f.id, None).unwrap();
    drop(app);
    app = open(&f, database.clone());
    assert!(app.installer.installed_for(&f.owner).unwrap().is_empty());
    app.installer
        .install_local(&f.owner, &f.signer, &next, &signature, true)
        .unwrap();
    app.installer
        .remove(&f.owner, &f.id, Some("Sample counter"))
        .unwrap();
    println!("installed PostgreSQL host: builder install, queued job, restart, upgrade, remove, reinstall and delete passed");
}
