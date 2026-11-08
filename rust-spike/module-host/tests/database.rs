mod common;
mod database_regressions;
use access_context::AccessContext;
use moss_module_host::{
    local::LocalPorts,
    migrations::PostgresLifecycle,
    postgres::{PostgresCatalog, MIGRATION},
    registry::Source,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::Secret,
};
use std::sync::Arc;
use tokio_postgres::NoTls;

#[test]
#[ignore = "Only through verify-gate and tools/gate.sh"]
fn a_postgres_catalog_and_real_sample_install() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let actor = uuid::Uuid::new_v4();
    let member = uuid::Uuid::new_v4();
    let app=runtime.block_on(async {
        let (db,connection)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();
        tokio::spawn(async move {let _=connection.await;});
        db.batch_execute(MIGRATION).await.unwrap();db.batch_execute(moss_module_host::migrations::MIGRATION).await.unwrap();
        db.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
        db.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
        // Gate-only users are synthetic and live only in the throwaway database.
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'module-admin@example.test','Module admin',true),($2,'module-member@example.test','Module member',false)",&[&actor,&member]).await.unwrap();
        Database::connect(&std::env::var("JS43_APP_URL").unwrap(),4,RuntimeRole::App).await.unwrap()
    });
    let access = AccessContext::new(actor, "real-host-install");
    let catalog = Arc::new(PostgresCatalog::new(app.clone(), access.clone()).unwrap());
    let member_catalog =
        PostgresCatalog::new(app.clone(), AccessContext::new(member, "member")).unwrap();
    assert!(member_catalog.load().is_err());
    let state = State {
        revision: 1,
        ..State::default()
    };
    catalog.commit(0, &state).unwrap();
    assert!(catalog.commit(0, &state).is_err());
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let artifact = keys.write(registry.path(), "1.0.0", 1, vec![]);
    let installer = Installer::new(
        data.path(),
        catalog.clone(),
        Arc::new(
            PostgresLifecycle::new(
                Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
                app.clone(),
                data.path(),
            )
            .unwrap(),
        ),
        Host::new(Limits::default()).unwrap(),
        Arc::new(LocalPorts::new(data.path()).unwrap()),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let source = installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    installer
        .install(&access, &source, &artifact, true)
        .unwrap();
    installer
        .call(
            "sample.counter",
            access.clone(),
            "route",
            r#"{"operation":"set","resource":"counter","parameters":{"count":9}}"#,
        )
        .unwrap();
    assert_eq!(
        installer
            .call(
                "sample.counter",
                access.clone(),
                "route",
                r#"{"operation":"get","resource":"counter","parameters":{}}"#
            )
            .unwrap(),
        r#"{"count":9}"#
    );
    drop(installer);
    assert_eq!(
        catalog.load().unwrap().installed["sample.counter"].digest,
        artifact.digest
    );
    let reopened = PostgresCatalog::new(app, access).unwrap();
    assert_eq!(
        reopened.load().unwrap().installed["sample.counter"].digest,
        artifact.digest
    );
    // Each test owns a temporary data directory; do not leave its catalog pointing at
    // files which TempDir deletes before the next independent startup audit.
    let current = reopened.load().unwrap();
    reopened
        .commit(
            current.revision,
            &State {
                revision: current.revision + 1,
                ..State::default()
            },
        )
        .unwrap();
    println!("PASS PostgreSQL catalog: admin-only configuration, stale-write refusal, signed package installed and run by Wasmtime, saved account data, active version survives reopening");
}

#[test]
#[ignore = "Only through verify-gate and tools/gate.sh; run serially"]
fn b_module_database_role_and_schema_rollback() {
    use moss_module_host::{database::DatabasePorts, manifest::Capability};
    use std::collections::BTreeSet;
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let actor = uuid::Uuid::new_v4();
    let member = uuid::Uuid::new_v4();
    let app=rt.block_on(async {
        let (db,connection)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();tokio::spawn(async move {let _=connection.await;});
        // The other serial database test owns the catalog schema setup.
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'records-admin@example.test','Records admin',true),($2,'records-member@example.test','Records member',false)",&[&actor,&member]).await.unwrap();
        Database::connect(&std::env::var("JS43_APP_URL").unwrap(),4,RuntimeRole::App).await.unwrap()
    });
    let access = AccessContext::new(actor, "database-module");
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let registry_file = registry.path().join("registry.json");
    let mut identity: moss_module_host::trust::RegistryIdentity =
        serde_json::from_slice(&std::fs::read(&registry_file).unwrap()).unwrap();
    identity.id = "database-registry".into();
    let identity_bytes = serde_json::to_vec(&identity).unwrap();
    std::fs::write(&registry_file, &identity_bytes).unwrap();
    std::fs::write(
        registry.path().join("registry.json.sig"),
        common::Keys::sign(&keys.root, &identity_bytes),
    )
    .unwrap();
    let catalog = Arc::new(PostgresCatalog::new(app.clone(), access.clone()).unwrap());
    let ports = Arc::new(
        DatabasePorts::new(app.clone(), Arc::new(LocalPorts::new(data.path()).unwrap())).unwrap(),
    );
    let lifecycle = Arc::new(
        PostgresLifecycle::new(
            Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            app.clone(),
            data.path(),
        )
        .unwrap(),
    );
    let installer = Installer::new(
        data.path(),
        catalog.clone(),
        lifecycle.clone(),
        Host::new(Limits::default()).unwrap(),
        ports,
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let source = installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "database-registry",
        )
        .unwrap();
    let table = "app.sample_records_entries";
    let mut manifest = common::manifest("1.0.0");
    manifest.id = "sample.records".into();
    manifest.database.owned_tables = vec![table.into()];
    manifest.database.migrations = vec!["sql/0001_entries.sql".into()];
    manifest.database.access.insert(
        table.into(),
        moss_module_host::manifest::TableAccess::OwnerOrShare {
            resource_type: "sample.records.entry".into(),
            share_key: "id".into(),
        },
    );
    manifest.capabilities = vec![Capability {
        port: "db".into(),
        operations: BTreeSet::from([
            "select".into(),
            "insert".into(),
            "update".into(),
            "delete".into(),
        ]),
        resources: BTreeSet::from([table.into()]),
        allow_private: false,
    }];
    let mut files = common::files(&manifest);
    files.insert(
        "code/module.wasm".into(),
        wat::parse_str(
            include_str!("../sample/module.wat")
                .replace("moss:module/kv@1.0.0", "moss:module/db@1.0.0"),
        )
        .unwrap(),
    );
    files.insert("sql/0001_entries.sql".into(),b"CREATE TABLE app.sample_records_entries (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES app.users(id), title text NOT NULL)".to_vec());
    let bytes = moss_module_host::archive::pack(&files).unwrap();
    let digest = moss_module_host::trust::digest(&bytes);
    let original_bytes = bytes.clone();
    installer
        .import_file(
            &access,
            &source,
            &bytes,
            &common::Keys::sign(&keys.publisher, digest.as_bytes()),
            "sample",
            true,
        )
        .unwrap();
    let row_id = uuid::Uuid::new_v4();
    let request=serde_json::json!({"operation":"insert","resource":table,"parameters":{"values":{"id":row_id,"title":"Private row"}}}).to_string();
    installer
        .call("sample.records", access.clone(), "route", &request)
        .unwrap();
    let get =
        serde_json::json!({"operation":"select","resource":table,"parameters":{}}).to_string();
    assert_eq!(
        installer
            .call(
                "sample.records",
                AccessContext::new(member, "other"),
                "route",
                &get
            )
            .unwrap(),
        "[]"
    );
    let rows: serde_json::Value = serde_json::from_str(
        &installer
            .call("sample.records", access.clone(), "route", &get)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(rows[0]["title"], "Private row");
    // Grant view, then manage through the same real share model the generated policy uses.
    rt.block_on(async {
        let (db,c)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();tokio::spawn(async move{let _=c.await;});
        db.execute("INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('sample.records.entry',$1,$2,$3,'view')",&[&row_id,&actor,&member]).await.unwrap();
        // Existing-schema fixture probes serial, identity and generated-column recovery.
        db.batch_execute("ALTER TABLE app.sample_records_entries ADD COLUMN serial_value serial, ADD COLUMN identity_value bigint GENERATED ALWAYS AS IDENTITY, ADD COLUMN upper_title text GENERATED ALWAYS AS (upper(title)) STORED").await.unwrap();
    });
    let member_access = AccessContext::new(member, "shared");
    assert!(installer
        .call("sample.records", member_access.clone(), "route", &get)
        .unwrap()
        .contains("Private row"));
    let edit=serde_json::json!({"operation":"update","resource":table,"parameters":{"id":row_id,"values":{"title":"Shared edit"}}}).to_string();
    assert_eq!(
        installer
            .call("sample.records", member_access.clone(), "route", &edit)
            .unwrap(),
        "[]"
    );
    rt.block_on(async {
        let (db, c) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = c.await;
        });
        db.execute(
            "UPDATE app.shares SET level='manage' WHERE resource_id=$1",
            &[&row_id],
        )
        .await
        .unwrap();
    });
    assert!(installer
        .call("sample.records", member_access.clone(), "route", &edit)
        .unwrap()
        .contains("Shared edit"));
    let delete =
        serde_json::json!({"operation":"delete","resource":table,"parameters":{"id":row_id}})
            .to_string();
    assert_eq!(
        installer
            .call("sample.records", member_access, "route", &delete)
            .unwrap(),
        "[]"
    );
    let reset=serde_json::json!({"operation":"update","resource":table,"parameters":{"id":row_id,"values":{"title":"Private row"}}}).to_string();
    installer
        .call("sample.records", access.clone(), "route", &reset)
        .unwrap();
    let foreign_table = "app.sample_records_unowned";
    rt.block_on(async {
        let (db, connection) =
            tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), NoTls)
                .await
                .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.batch_execute(&format!(
            "CREATE TABLE {foreign_table}(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL)"
        ))
        .await
        .unwrap();
    });
    let mut takeover = manifest.clone();
    takeover.version = "1.0.1".parse().unwrap();
    takeover.database.owned_tables.push(foreign_table.into());
    let mut takeover_files = files.clone();
    takeover_files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(&takeover).unwrap(),
    );
    let takeover_bytes = moss_module_host::archive::pack(&takeover_files).unwrap();
    let takeover_digest = moss_module_host::trust::digest(&takeover_bytes);
    assert!(installer
        .import_file(
            &access,
            &source,
            &takeover_bytes,
            &common::Keys::sign(&keys.publisher, takeover_digest.as_bytes()),
            "sample",
            true
        )
        .is_err());
    let mut update = manifest.clone();
    update.version = "1.1.0".parse().unwrap();
    update.database.migrations.push("sql/0002_extra.sql".into());
    files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(&update).unwrap(),
    );
    files.insert(
        "sql/0002_extra.sql".into(),
        b"ALTER TABLE app.sample_records_entries ADD COLUMN extra text".to_vec(),
    );
    // A real component returns failure from its health hook after schema migration.
    let broken = common::unhealthy_source().replace("moss:module/kv@1.0.0", "moss:module/db@1.0.0");
    files.insert("code/module.wasm".into(), wat::parse_str(broken).unwrap());
    let bytes = moss_module_host::archive::pack(&files).unwrap();
    let digest = moss_module_host::trust::digest(&bytes);
    let health_error = installer
        .import_file(
            &access,
            &source,
            &bytes,
            &common::Keys::sign(&keys.publisher, digest.as_bytes()),
            "sample",
            true,
        )
        .unwrap_err();
    assert_eq!(
        health_error.to_string(),
        "The module could not finish this request"
    );
    let rows: serde_json::Value = serde_json::from_str(
        &installer
            .call("sample.records", access.clone(), "route", &get)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(rows[0]["title"], "Private row");
    assert!(rows[0].get("extra").is_none());
    assert_eq!(rows[0]["serial_value"], 1);
    assert_eq!(rows[0]["identity_value"], 1);
    assert_eq!(rows[0]["upper_title"], "PRIVATE ROW");
    assert_eq!(
        catalog.load().unwrap().installed["sample.records"]
            .manifest
            .version
            .to_string(),
        "1.0.0"
    );
    // Simulate process death after DDL commits but before catalog activation. A fresh host
    // must restore schema and data, and the same journal must be safe to replay twice.
    use moss_module_host::store::Lifecycle;
    let before = catalog.load().unwrap();
    lifecycle.pause_jobs("sample.records").unwrap();
    let snapshot = lifecycle.snapshot("sample.records").unwrap();
    let root = vault::Root::open(&data.path().join("modules")).unwrap();
    let now = chrono::Utc::now();
    root.subdir("snapshots")
        .unwrap()
        .subdir("sample.records")
        .unwrap()
        .subdir(&snapshot)
        .unwrap()
        .write(
            "snapshot.json",
            &serde_json::to_vec(&moss_module_host::recovery::Snapshot {
                module: "sample.records".into(),
                id: snapshot.clone(),
                created: now,
                expires: now + chrono::Duration::days(30),
                reason: "upgrade".into(),
                previous: Some(before.installed["sample.records"].clone()),
            })
            .unwrap(),
        )
        .unwrap();
    let journal=serde_json::to_vec(&serde_json::json!({"module":"sample.records","snapshot":snapshot,"before":before,"target":digest})).unwrap();
    rt.block_on(async {
        let (db, c) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = c.await;
        });
        db.batch_execute("ALTER TABLE app.sample_records_entries ADD COLUMN crash_only text")
            .await
            .unwrap();
    });
    for _ in 0..2 {
        root.write("operation.json", &journal).unwrap();
        let restarted = Installer::new(
            data.path(),
            catalog.clone(),
            lifecycle.clone(),
            Host::new(Limits::default()).unwrap(),
            Arc::new(
                DatabasePorts::new(app.clone(), Arc::new(LocalPorts::new(data.path()).unwrap()))
                    .unwrap(),
            ),
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap();
        let rows: serde_json::Value = serde_json::from_str(
            &restarted
                .call("sample.records", access.clone(), "route", &get)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(rows[0]["title"], "Private row");
        assert!(rows[0].get("crash_only").is_none());
        assert!(!data.path().join("modules/operation.json").exists());
    }
    installer.remove(&access, "sample.records", None).unwrap();
    // A failing reinstall must not mistake retained tables for an empty first install.
    assert!(installer
        .import_file(
            &access,
            &source,
            &bytes,
            &common::Keys::sign(&keys.publisher, digest.as_bytes()),
            "sample",
            true
        )
        .is_err());
    let original_digest = moss_module_host::trust::digest(&original_bytes);
    installer
        .import_file(
            &access,
            &source,
            &original_bytes,
            &common::Keys::sign(&keys.publisher, original_digest.as_bytes()),
            "sample",
            true,
        )
        .unwrap();
    let rows: serde_json::Value = serde_json::from_str(
        &installer
            .call("sample.records", access.clone(), "route", &get)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(rows[0]["title"], "Private row");
    installer.remove(&access, "sample.records", None).unwrap();
    assert!(catalog
        .load()
        .unwrap()
        .retained
        .contains_key("sample.records"));
    installer
        .remove(&access, "sample.records", Some("Sample counter"))
        .unwrap();
    assert!(!catalog
        .load()
        .unwrap()
        .retained
        .contains_key("sample.records"));
    installer
        .import_file(
            &access,
            &source,
            &original_bytes,
            &common::Keys::sign(&keys.publisher, original_digest.as_bytes()),
            "sample",
            true,
        )
        .unwrap();
    assert_eq!(
        installer
            .call("sample.records", access, "route", &get)
            .unwrap(),
        "[]"
    );
    println!("PASS module SQL: restricted owner, generated forced RLS, actor-scoped typed queries, failed health hook restores old schema and rows");
}

#[test]
#[ignore = "Only through verify-gate and tools/gate.sh; run serially"]
fn c_real_queue_pauses_rebinds_upgrades_and_runs_with_actor() {
    use moss_module_host::{
        jobs::{manifest_hash, JobPorts},
        manifest::{Capability, ParameterKind},
        store::Lifecycle,
    };
    use serde_json::json;
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let actor = uuid::Uuid::new_v4();
    let member = uuid::Uuid::new_v4();
    let app=rt.block_on(async {
        let (db,c)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();tokio::spawn(async move{let _=c.await;});
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'queue-admin@example.test','Queue admin',true),($2,'queue-member@example.test','Queue member',false)",&[&actor,&member]).await.unwrap();
        Database::connect(&std::env::var("JS43_APP_URL").unwrap(),4,RuntimeRole::App).await.unwrap()
    });
    let access = AccessContext::new(actor, "queue");
    let catalog = Arc::new(PostgresCatalog::new(app.clone(), access.clone()).unwrap());
    // Earlier tests' temporary package directories have ended.
    let before = catalog.load().unwrap();
    catalog
        .commit(
            before.revision,
            &State {
                revision: before.revision + 1,
                ..State::default()
            },
        )
        .unwrap();
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let lifecycle = Arc::new(
        PostgresLifecycle::new(
            Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            app.clone(),
            data.path(),
        )
        .unwrap(),
    );
    let ports = Arc::new(
        JobPorts::new(
            Secret::new(std::env::var("JS43_APP_URL").unwrap()),
            app,
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let installer = Installer::new(
        data.path(),
        catalog.clone(),
        lifecycle.clone(),
        Host::new(Limits::default()).unwrap(),
        ports,
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let source = installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    let mut m = common::manifest("1.0.0");
    m.id = "sample.jobs".into();
    m.capabilities = vec![Capability {
        port: "jobs".into(),
        operations: [
            "enqueue".into(),
            "cancel".into(),
            "schedule".into(),
            "unschedule".into(),
        ]
        .into(),
        resources: ["sync".into()].into(),
        allow_private: false,
    }];
    m.jobs.insert(
        "sync".into(),
        [("count".into(), ParameterKind::Count)].into(),
    );
    let mut files = common::files(&m);
    files.insert(
        "code/module.wasm".into(),
        wat::parse_str(
            include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/jobs@"),
        )
        .unwrap(),
    );
    let install = |files: &std::collections::BTreeMap<String, Vec<u8>>| {
        let bytes = moss_module_host::archive::pack(files).unwrap();
        let hash = moss_module_host::trust::digest(&bytes);
        installer
            .import_file(
                &access,
                &source,
                &bytes,
                &common::Keys::sign(&keys.publisher, hash.as_bytes()),
                "sample",
                true,
            )
            .unwrap();
    };
    install(&files);
    let enqueue =
        json!({"operation":"enqueue","resource":"sync","parameters":{"count":2}}).to_string();
    let response: serde_json::Value = serde_json::from_str(
        &installer
            .call("sample.jobs", access.clone(), "route", &enqueue)
            .unwrap(),
    )
    .unwrap();
    let id: uuid::Uuid = response["id"].as_str().unwrap().parse().unwrap();
    let cancel = json!({"operation":"cancel","resource":"sync","parameters":{"id":id}}).to_string();
    assert_eq!(
        installer
            .call(
                "sample.jobs",
                AccessContext::new(member, "other"),
                "route",
                &cancel
            )
            .unwrap(),
        "{\"cancelled\":false}"
    );
    lifecycle.pause_jobs("sample.jobs").unwrap();
    let worker = Secret::new(std::env::var("JS43_WORKER_URL").unwrap());
    assert!(!installer.run_job(&worker).unwrap());
    lifecycle.resume_jobs("sample.jobs").unwrap();
    installer
        .set_enabled(&access, "sample.jobs", false)
        .unwrap();
    assert!(installer
        .call("sample.jobs", access.clone(), "route", &enqueue)
        .is_err());
    assert!(!installer.run_job(&worker).unwrap());
    installer
        .set_enabled(
            &AccessContext::new(member, "member-choice"),
            "sample.jobs",
            true,
        )
        .unwrap();
    assert!(
        !installer.run_job(&worker).unwrap(),
        "Another account cannot enable this actor's work"
    );
    installer.set_enabled(&access, "sample.jobs", true).unwrap();
    let schedule=json!({"operation":"schedule","resource":"sync","parameters":{"cron":"0 9 * * *","timezone":"UTC","params":{"count":3}}}).to_string();
    let scheduled: serde_json::Value = serde_json::from_str(
        &installer
            .call("sample.jobs", access.clone(), "route", &schedule)
            .unwrap(),
    )
    .unwrap();
    let unschedule =
        json!({"operation":"unschedule","resource":"sync","parameters":{"id":scheduled["id"]}})
            .to_string();
    assert_eq!(
        installer
            .call(
                "sample.jobs",
                AccessContext::new(member, "other"),
                "route",
                &unschedule
            )
            .unwrap(),
        r#"{"cancelled":false}"#
    );
    assert_eq!(
        installer
            .call("sample.jobs", access.clone(), "route", &unschedule)
            .unwrap(),
        r#"{"cancelled":true}"#
    );
    m.version = "1.1.0".parse().unwrap();
    files.insert("moss.module.json".into(), serde_json::to_vec(&m).unwrap());
    install(&files);
    let installed = catalog.load().unwrap().installed["sample.jobs"]
        .manifest
        .clone();
    assert_eq!(installed.version, m.version);
    assert_eq!(
        manifest_hash(&installed),
        manifest_hash(&m),
        "Manifest identity changed on catalog round-trip"
    );
    rt.block_on(async {
        let (db, c) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = c.await;
        });
        let payload: serde_json::Value = db
            .query_one("SELECT payload FROM moss_queue.jobs WHERE id=$1", &[&id])
            .await
            .unwrap()
            .get(0);
        assert_eq!(payload["manifestHash"], manifest_hash(&m));
        assert_eq!(payload["actorUserId"], actor.to_string());
    });
    assert!(installer.run_job(&worker).unwrap());
    assert!(!installer.run_job(&worker).unwrap());
    let response: serde_json::Value = serde_json::from_str(
        &installer
            .call("sample.jobs", access.clone(), "route", &enqueue)
            .unwrap(),
    )
    .unwrap();
    let cancel = json!({"operation":"cancel","resource":"sync","parameters":{"id":response["id"]}})
        .to_string();
    assert_eq!(
        installer
            .call("sample.jobs", access.clone(), "route", &cancel)
            .unwrap(),
        "{\"cancelled\":true}"
    );
    installer
        .call("sample.jobs", access.clone(), "route", &enqueue)
        .unwrap();
    installer.remove(&access, "sample.jobs", None).unwrap();
    assert!(!installer.run_job(&worker).unwrap());
    database_regressions::schedule_only_jobs_survive_execution_and_upgrade(
        &installer, &access, &m, &files, &install, &worker,
    );
    println!("PASS real Phase 2b queue: account-bound enqueue and cancellation, pause blocks claims, compatible upgrade rebinds payload, Wasm worker executes, removal stops work");
}

#[test]
#[ignore = "Only through verify-gate and tools/gate.sh; run serially"]
fn d_existing_core_and_module_ledgers_keep_their_hashes() {
    use moss_module_host::{archive::Package, manifest::Ledger, store::Lifecycle};
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let app = rt
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let data = tempfile::tempdir().unwrap();
    let lifecycle = PostgresLifecycle::new(
        Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
        app,
        data.path(),
    )
    .unwrap();
    let mut m = common::manifest("1.0.0");
    m.id = "tasks".into();
    m.database.ledger = Ledger::CoreLegacy;
    m.database.owned_tables = vec!["app.tasks".into(), "app.task_activity".into()];
    let mut files = common::files(&m);
    let mut paths: Vec<_> = std::fs::read_dir("../../packages/tasks/sql")
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "sql"))
        .collect();
    paths.sort();
    for path in paths {
        let name = format!("sql/{}", path.file_name().unwrap().to_str().unwrap());
        m.database.migrations.push(name.clone());
        files.insert(name, std::fs::read(path).unwrap());
    }
    m.validate(&"0.1.0".parse().unwrap()).unwrap();
    let mut package = Package {
        manifest: m,
        files,
        digest: String::new(),
    };
    moss_module_host::sql::check(&package, &LegacyInventory::default()).unwrap();
    // Adoption snapshots must include legacy tables before the new ownership mirror exists.
    let adoption = lifecycle.snapshot("tasks").unwrap();
    let snapshot: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            data.path()
                .join(format!("modules/snapshots/tasks/{adoption}/database.json")),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(snapshot["tables"].get("app.tasks").is_some());
    // The saved core rows must be restored too, including before the ownership mirror exists.
    rt.block_on(async {
        let (db, conn) =
            tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), NoTls)
                .await
                .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let version =
            moss_module_host::legacy::version(&package.manifest.database.migrations[0]).unwrap();
        db.execute(
            "DELETE FROM app.schema_migrations WHERE version=$1",
            &[&version],
        )
        .await
        .unwrap();
    });
    lifecycle.restore("tasks", &adoption).unwrap();
    lifecycle.restore("tasks", &adoption).unwrap();
    lifecycle.discard_snapshot("tasks", &adoption).unwrap();
    lifecycle.migrate(&package, None).unwrap();
    lifecycle.audit(&package).unwrap();
    let first = package.manifest.database.migrations[0].clone();
    package.files.get_mut(&first).unwrap().push(b' ');
    assert!(lifecycle.audit(&package).is_err());
    let mut m = common::manifest("1.0.0");
    m.id = "sample.ledger".into();
    m.database.ledger = Ledger::ModuleLegacy;
    m.database.owned_tables = vec!["app.sample_ledger_entries".into()];
    m.database.migrations = vec!["sql/0001_entries.sql".into()];
    let mut files = common::files(&m);
    files.insert("sql/0001_entries.sql".into(),b"CREATE TABLE app.sample_ledger_entries(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES app.users(id))".to_vec());
    let p = Package {
        manifest: m,
        files,
        digest: String::new(),
    };
    lifecycle.migrate(&p, None).unwrap();
    lifecycle.audit(&p).unwrap();
    lifecycle.migrate(&p, None).unwrap();
    println!("PASS legacy ledgers: compiled Tasks inventory retains original core checksums, changed bytes fail startup audit, module ledger applies once with original text hash");
}

#[test]
#[ignore = "Only through verify-gate and tools/gate.sh"]
fn e_frozen_meeting_sidecars_project_real_rows_and_restore_force_rls() {
    use moss_module_host::{archive::Package, manifest::Ledger};
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (mut db,conn)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();
        tokio::spawn(async move {let _=conn.await;});
        let tx=db.transaction().await.unwrap();
        // This entire fixture is rolled back, including its DDL. It touches only the gate DB.
        let tables:Vec<String>=tx.query("SELECT tablename FROM pg_tables WHERE schemaname='app' AND tablename LIKE 'meeting\\_%' ESCAPE '\\'",&[]).await.unwrap().iter().map(|r|format!("app.{}",r.get::<_,String>(0))).collect();
        if !tables.is_empty(){tx.batch_execute(&format!("DROP TABLE {} CASCADE",tables.join(","))).await.unwrap();}
        tx.batch_execute("CREATE TABLE app.meeting_records(id uuid PRIMARY KEY,owner_user_id uuid);
CREATE TABLE app.meeting_transcript_batches(meeting_id uuid,version integer,input_json text,history_sources_json text,history_omitted_sources integer);
CREATE TABLE app.meeting_history_segments(meeting_id uuid,owner_user_id uuid,segment_key text,revision double precision,start_ms double precision,end_ms double precision,finality text,search_terms text[]);
CREATE TABLE app.meeting_output_requests(meeting_id uuid,request_key uuid,input_json text,result_json text,history_kind text,history_result_status text,history_result_code text);
CREATE TABLE app.meeting_output_artifacts(id uuid,meeting_id uuid,version integer,artifact_json text,history_origin text,history_notes_revision integer,history_transcript_revision integer,history_stale boolean,history_overview text);
CREATE TABLE app.meeting_export_receipts(meeting_id uuid,artifact_version integer,receipt_json text,history_write_status text,history_index_status text,history_updated_at text);
CREATE TABLE app.meeting_capture_grants(id uuid,state_json text,recorded_duration_ms integer);").await.unwrap();
        let id=uuid::Uuid::new_v4();let owner=uuid::Uuid::new_v4();let request=uuid::Uuid::new_v4();
        tx.execute("INSERT INTO app.meeting_records VALUES($1,$2)",&[&id,&owner]).await.unwrap();
        let input=serde_json::json!({"events":[{"segment":{"segmentId":"one","revision":1,"startMs":0,"endMs":20,"finality":"final","text":"old"}},{"segment":{"segmentId":"one","revision":2,"startMs":0,"endMs":25,"finality":"final","text":"new searchable"}}],"sources":[{"kind":"mic","label":"A"},{"kind":"mic","label":"A"},{"kind":"tab","label":"B"}]}).to_string();
        tx.execute("INSERT INTO app.meeting_transcript_batches(meeting_id,version,input_json) VALUES($1,1,$2)",&[&id,&input]).await.unwrap();
        tx.execute("INSERT INTO app.meeting_output_requests(meeting_id,request_key,input_json,result_json) VALUES($1,$2,$3,$4)",&[&id,&request,&r#"{"kind":"generate"}"#,&r#"{"status":"saved","code":"ok"}"#]).await.unwrap();
        let artifact=serde_json::json!({"origin":"generated","inputs":{"notesRevision":3},"stale":false,"content":{"overview":"  hello\n\u{feff}world\0  "}}).to_string();
        tx.execute("INSERT INTO app.meeting_output_artifacts(id,meeting_id,version,artifact_json) VALUES($1,$1,1,$2)",&[&id,&artifact]).await.unwrap();
        tx.execute("INSERT INTO app.meeting_export_receipts(meeting_id,artifact_version,receipt_json) VALUES($1,1,$2)",&[&id,&r#"{"writeStatus":"saved","indexStatus":"queued","updatedAt":"2026-11-08"}"#]).await.unwrap();
        tx.execute("INSERT INTO app.meeting_capture_grants(id,state_json) VALUES($1,$2)",&[&id,&r#"{"recordedDurationMs":4500.0}"#]).await.unwrap();
        let mut m=common::manifest("1.0.0");m.id="meetings".into();m.database.ledger=Ledger::CoreLegacy;
        let mut p=Package{manifest:m,files:Default::default(),digest:String::new()};
        for name in ["0280_meeting_history.sql","0292_meeting_minimal.sql"] {
            let path=format!("sql/{name}");p.files.insert(path.clone(),std::fs::read(format!("../../packages/meetings/sql/{name}")).unwrap());
            moss_module_host::legacy::backfill(&tx,&p,&path).await.unwrap();
        }
        let row=tx.query_one("SELECT revision,search_terms FROM app.meeting_history_segments",&[]).await.unwrap();
        assert_eq!(row.get::<_,f64>(0),2.0);assert_eq!(row.get::<_,Vec<String>>(1),["new","searchable"]);
        let row=tx.query_one("SELECT history_sources_json,history_omitted_sources FROM app.meeting_transcript_batches",&[]).await.unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&row.get::<_,String>(0)).unwrap().as_array().unwrap().len(),2);assert_eq!(row.get::<_,i32>(1),0);
        let row=tx.query_one("SELECT history_origin,history_notes_revision,history_transcript_revision,history_stale,history_overview FROM app.meeting_output_artifacts",&[]).await.unwrap();
        assert_eq!(row.get::<_,String>(0),"generated");assert_eq!(row.get::<_,i32>(1),3);assert_eq!(row.get::<_,i32>(2),0);assert!(!row.get::<_,bool>(3));assert_eq!(row.get::<_,String>(4),"hello world");
        assert_eq!(tx.query_one("SELECT recorded_duration_ms FROM app.meeting_capture_grants",&[]).await.unwrap().get::<_,i32>(0),4500);
        assert!(tx.query("SELECT relforcerowsecurity FROM pg_class WHERE oid IN ('app.meeting_records'::regclass,'app.meeting_history_segments'::regclass,'app.meeting_capture_grants'::regclass)",&[]).await.unwrap().iter().all(|r|r.get::<_,bool>(0)));
        let path="sql/0292_meeting_minimal.sql";p.files.get_mut(path).unwrap().push(b' ');
        assert!(moss_module_host::legacy::backfill(&tx,&p,path).await.is_err());
        tx.rollback().await.unwrap();
        println!("PASS frozen backfills: real PostgreSQL latest segments, sources, artifact/request/export/capture projections, forced RLS; altered inventory bytes refused");
    });
}
