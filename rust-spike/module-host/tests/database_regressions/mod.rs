use access_context::AccessContext;
use moss_module_host::{jobs::specs, manifest::Manifest, store::Installer};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn upgrade_changes_existing_rows_and_restores_privacy(
    installer: &Installer,
    owner: &AccessContext,
    member: &AccessContext,
    source: &moss_module_host::registry::Catalog,
    keys: &super::common::Keys,
    original_bytes: &[u8],
) {
    let mut package = moss_module_host::archive::Package::read(
        original_bytes,
        &moss_module_host::trust::digest(original_bytes),
        &"0.1.0".parse().unwrap(),
    )
    .unwrap();
    let table = "app.sample_records_entries";
    for access in [owner, member] {
        for title in ["keep", "delete me"] {
            let request = json!({"operation":"insert","resource":table,"parameters":{"values":{"id":uuid::Uuid::new_v4(),"title":title}}});
            installer
                .call(
                    &package.manifest.id,
                    access.clone(),
                    "route",
                    &request.to_string(),
                )
                .unwrap();
        }
    }
    package.manifest.version = "1.1.0".parse().unwrap();
    for (path, sql) in [
        (
            "sql/0002_update.sql",
            "UPDATE app.sample_records_entries SET title='migrated' WHERE title='keep'",
        ),
        (
            "sql/0003_delete.sql",
            "DELETE FROM app.sample_records_entries WHERE title='delete me'",
        ),
    ] {
        package.manifest.database.migrations.push(path.into());
        package.files.insert(path.into(), sql.as_bytes().to_vec());
    }
    package.files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(&package.manifest).unwrap(),
    );
    let bytes = moss_module_host::archive::pack(&package.files).unwrap();
    let hash = moss_module_host::trust::digest(&bytes);
    installer
        .import_file(
            owner,
            source,
            &bytes,
            &super::common::Keys::sign(&keys.publisher, hash.as_bytes()),
            "sample",
            true,
        )
        .unwrap();
    let select = json!({"operation":"select","resource":table,"parameters":{}}).to_string();
    for access in [owner, member] {
        let rows: Value = serde_json::from_str(
            &installer
                .call(&package.manifest.id, access.clone(), "route", &select)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            rows.as_array().unwrap().len(),
            1,
            "The upgrade DELETE must remove old rows without exposing another account's rows"
        );
        assert_eq!(
            rows[0]["title"], "migrated",
            "The upgrade UPDATE must transform existing rows"
        );
        assert_eq!(rows[0]["owner_user_id"], access.actor_user_id().to_string());
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        let row = db.query_one("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::text::regclass", &[&table]).await.unwrap();
        assert!(row.get::<_, bool>(0) && row.get::<_, bool>(1), "Upgrade migrations must restore forced row-level security");
    });
    println!("PASS row-changing upgrades: UPDATE and DELETE affect both accounts; real Wasm reads remain owner-scoped and forced RLS is restored");
}

pub fn schedule_only_jobs_survive_execution_and_upgrade(
    installer: &Installer,
    access: &AccessContext,
    original: &Manifest,
    original_files: &BTreeMap<String, Vec<u8>>,
    install: &impl Fn(&BTreeMap<String, Vec<u8>>),
    worker: &Secret,
) {
    let mut manifest = original.clone();
    manifest.version = "1.2.0".parse().unwrap();
    manifest.capabilities[0].operations = ["schedule".into(), "unschedule".into()].into();
    let mut files = original_files.clone();
    files.insert(
        "moss.module.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    install(&files);
    let enqueue = json!({"operation":"enqueue","resource":"sync","parameters":{"count":4}});
    assert!(installer
        .call(&manifest.id, access.clone(), "route", &enqueue.to_string())
        .is_err());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for upgrade in [false, true] {
        let request = json!({"operation":"schedule","resource":"sync","parameters":{"cron":"0 9 * * *","timezone":"UTC","params":{"count":4}}});
        let response: Value = serde_json::from_str(
            &installer
                .call(&manifest.id, access.clone(), "route", &request.to_string())
                .unwrap(),
        )
        .unwrap();
        let id: uuid::Uuid = response["id"].as_str().unwrap().parse().unwrap();
        if upgrade {
            manifest.version = "1.3.0".parse().unwrap();
            files.insert(
                "moss.module.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            );
            install(&files);
        }
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move { let _ = connection.await; });
            // Advance only this test schedule through the real scheduler, without sleeping.
            db.execute("UPDATE moss_queue.schedules SET next_at=clock_timestamp()-interval '1 minute' WHERE id=$1", &[&id]).await.unwrap();
            let queue = moss_platform_jobs::Queue::connect(worker.expose_secret(), moss_platform_jobs::Role::Worker, specs(&manifest)).await.unwrap();
            assert_eq!(queue.tick().await.unwrap(), 1, "A schedule-only module must retain its schedule across upgrades");
        });
        assert!(
            installer.run_job(worker).unwrap(),
            "A schedule-only module must execute its due job"
        );
        assert!(!installer.run_job(worker).unwrap());
        let cancel = json!({"operation":"unschedule","resource":"sync","parameters":{"id":id}});
        assert_eq!(
            installer
                .call(&manifest.id, access.clone(), "route", &cancel.to_string())
                .unwrap(),
            r#"{"cancelled":true}"#
        );
    }
    installer.remove(access, &manifest.id, None).unwrap();
    println!("PASS schedule-only jobs: direct enqueue refused, real scheduler fires, Wasm job executes before and after an upgrade");
}
