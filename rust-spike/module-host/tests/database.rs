mod common;
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
    let installer = Installer::new(
        data.path(),
        catalog.clone(),
        Arc::new(
            PostgresLifecycle::new(
                Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
                app,
                data.path(),
            )
            .unwrap(),
        ),
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
    assert_eq!(
        catalog.load().unwrap().installed["sample.records"]
            .manifest
            .version
            .to_string(),
        "1.0.0"
    );
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
