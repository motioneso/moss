use access_context::AccessContext;
use moss_module_host::linked_notes::{FolderProvider, PreferenceFolder, PreferenceFolders};
use safety_core::db::{Database, RuntimeRole};
use serde_json::json;
use std::time::Duration;
use std::{
    collections::BTreeMap,
    panic::{catch_unwind, AssertUnwindSafe},
};
use uuid::Uuid;
use vault::AllowedRoots;

#[test]
#[ignore = "Only through verify-gate and modules/notes/tools/gate.sh"]
fn folder_preferences_respect_owner_rls_and_legacy_relative_settings() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let owner = AccessContext::new(Uuid::new_v4(), "notes-owner");
    let admin = AccessContext::new(Uuid::new_v4(), "notes-admin");
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("notes");
    let selected = base.join("Contacts");
    std::fs::create_dir_all(&selected).unwrap();
    let db = runtime.block_on(async {
        let (db,connection)=tokio_postgres::connect(&std::env::var("JS47_BOOTSTRAP_URL").unwrap(),tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {let _=connection.await;});
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'notes-owner@example.test','Notes owner',false),($2,'notes-admin@example.test','Notes admin',true)", &[&owner.actor_user_id(),&admin.actor_user_id()]).await.unwrap();
        db.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'test-folder',$2),($1,'test-base',$3)", &[&owner.actor_user_id(),&json!("Contacts"),&json!(base.to_str().unwrap())]).await.unwrap();
        db
    });
    for (name, role) in [
        ("JS47_APP_URL", RuntimeRole::App),
        ("JS47_WORKER_URL", RuntimeRole::Worker),
    ] {
        let database = runtime
            .block_on(Database::connect(&std::env::var(name).unwrap(), 4, role))
            .unwrap();
        let resources = BTreeMap::from([(
            ("notes".into(), "linked-notes".into()),
            PreferenceFolder {
                preference: "test-folder".into(),
                relative_to: Some("test-base".into()),
            },
        )]);
        // Both accounts may select this trusted test root. RLS alone must hide the
        // owner's folder preference from an admin who has not linked a folder.
        let roots = BTreeMap::from([
            (
                owner.actor_user_id(),
                AllowedRoots::for_account(&owner, vec![base.clone()]),
            ),
            (
                admin.actor_user_id(),
                AllowedRoots::for_account(&admin, vec![base.clone()]),
            ),
        ]);
        let provider = PreferenceFolders::new(database, resources, roots).unwrap();
        let private_setting_assertion = || {
            assert!(
                provider
                    .resolve(&admin, "notes", "linked-notes", Duration::from_secs(5))
                    .is_err(),
                "admin must not see another account's chosen folder"
            )
        };
        // A real failing assertion first, with only the existing preference RLS
        // removed in this isolated gate server. Restore before every protected run.
        runtime
            .block_on(db.batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"))
            .unwrap();
        let red = catch_unwind(AssertUnwindSafe(private_setting_assertion));
        runtime
            .block_on(db.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY"))
            .unwrap();
        assert!(
            red.is_err(),
            "negative control must expose the privacy regression"
        );
        println!("{name}: owner-preference privacy assertion FAILED with RLS removed");
        private_setting_assertion();
        assert!(provider
            .resolve(&owner, "notes", "linked-notes", Duration::from_secs(5))
            .is_ok());
        println!("{name}: same owner-preference assertion PASSED with RLS restored");
        assert!(provider
            .resolve(&owner, "notes", "undeclared", Duration::from_secs(5))
            .is_err());
        for setting in [json!("../outside"), json!("/outside"), json!("")] {
            runtime.block_on(db.execute("UPDATE app.preferences SET value_json=$2 WHERE owner_user_id=$1 AND key='test-folder'", &[&owner.actor_user_id(),&setting])).unwrap();
            assert!(provider
                .resolve(&owner, "notes", "linked-notes", Duration::from_secs(5))
                .is_err());
        }
        // Absolute legacy settings are used directly; relative ones join the base.
        for setting in [json!(selected.to_str().unwrap()), json!("Contacts")] {
            runtime.block_on(db.execute("UPDATE app.preferences SET value_json=$2 WHERE owner_user_id=$1 AND key='test-folder'", &[&owner.actor_user_id(),&setting])).unwrap();
            assert!(provider
                .resolve(&owner, "notes", "linked-notes", Duration::from_secs(5))
                .is_ok());
        }
    }
}

#[test]
#[ignore = "Only through verify-gate and modules/notes/tools/gate.sh"]
fn a_saturated_preference_pool_returns_within_the_call_budget() {
    use safety_core::db::DataContext;
    use std::sync::mpsc;
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let actor = AccessContext::new(Uuid::new_v4(), "saturated-notes-pool");
    let temp = tempfile::tempdir().unwrap();
    let database = runtime
        .block_on(Database::connect(
            &std::env::var("JS47_APP_URL").unwrap(),
            1,
            RuntimeRole::App,
        ))
        .unwrap();
    let held = runtime
        .block_on(DataContext::open(&database, &actor))
        .unwrap();
    let provider = PreferenceFolders::new(
        database,
        BTreeMap::from([(
            ("notes".into(), "linked-notes".into()),
            PreferenceFolder {
                preference: "test-folder".into(),
                relative_to: None,
            },
        )]),
        BTreeMap::from([(
            actor.actor_user_id(),
            AllowedRoots::for_account(&actor, vec![temp.path().into()]),
        )]),
    )
    .unwrap();
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        sender
            .send(
                provider
                    .resolve(&actor, "notes", "linked-notes", Duration::from_millis(100))
                    .is_err(),
            )
            .unwrap();
    });
    let result = receiver.recv_timeout(Duration::from_secs(2));
    // Always release the connection and join, including the failing-first run.
    runtime.block_on(held.commit()).unwrap();
    worker.join().unwrap();
    assert!(
        result.unwrap_or(false),
        "folder lookup waited beyond its call budget for a full pool"
    );
}
