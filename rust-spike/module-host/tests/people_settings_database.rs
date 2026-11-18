//! Real compiled Settings routes with unchanged app.preferences and account-bound roots.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    account_preferences::{AccountPreferencesPorts, Binding},
    runtime::{DenyPorts, Host, Limits},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
};
use uuid::Uuid;

#[test]
#[ignore = "Only through verify-gate and the People gate"]
fn people_settings_preserve_shared_preferences_and_owner_privacy() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let actor = Uuid::new_v4();
    let other = Uuid::new_v4();
    let admin = Uuid::new_v4();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("notes");
    let folder = root.join("People");
    std::fs::create_dir_all(&folder).unwrap();
    let outside = temp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let bootstrap=rt.block_on(async {
        let (db,connection)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {let _=connection.await;});
        for (id,email,is_admin) in [(actor,"settings-owner@example.test",false),(other,"settings-other@example.test",false),(admin,"settings-admin@example.test",true)] {
            db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Settings test',$3)",&[&id,&email,&is_admin]).await.unwrap();
        }
        db
    });
    let component = std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap();
    let manifest = Arc::new(
        serde_json::from_str::<moss_module_host::manifest::Manifest>(include_str!(
            "../../../modules/people/moss.module.json"
        ))
        .unwrap(),
    );
    manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
    let host = Host::new(Limits::default()).unwrap();
    for (env, role) in [
        ("JS43_APP_URL", RuntimeRole::App),
        ("JS43_WORKER_URL", RuntimeRole::Worker),
    ] {
        // Each role gets the same isolated starting state. In particular, the
        // other account's null folder must not turn the RLS-off control into a
        // multiple-row backend failure instead of the intended observed leak.
        rt.block_on(async {
            bootstrap.execute("DELETE FROM app.preferences WHERE owner_user_id=ANY($1::uuid[])", &[&vec![actor, other, admin]]).await.unwrap();
            bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'people-notes-folder',$2),($1,'sourceBehaviors',$3)",&[&actor,&json!(folder),&json!({"unrelated.behavior":false})]).await.unwrap();
        });
        let database = rt
            .block_on(Database::connect(&std::env::var(env).unwrap(), 4, role))
            .unwrap();
        let bindings = BTreeMap::from([
            (
                ("people".into(), "people-folder".into()),
                Binding::Folder {
                    key: "people-notes-folder".into(),
                    roots: [actor, other, admin]
                        .into_iter()
                        .map(|id| (id, vec![root.clone()]))
                        .collect(),
                },
            ),
            (
                ("people".into(), "people-suggestions".into()),
                Binding::BooleanOverride {
                    key: "sourceBehaviors".into(),
                    entry: "people.notes.suggest-updates".into(),
                    default: true,
                },
            ),
        ]);
        let ports = Arc::new(
            AccountPreferencesPorts::new(database, bindings, Arc::new(DenyPorts)).unwrap(),
        );
        let call = |id, method: &str, path: &str, body: Value| {
            let mut request =
                moss_module_host::dispatch::resolve(&manifest.routes, method, path).unwrap();
            request.body = body;
            let reply = host
                .call(
                    &component,
                    manifest.clone(),
                    AccessContext::new(id, "people-settings"),
                    ports.clone(),
                    "route",
                    &serde_json::to_string(&request).unwrap(),
                )
                .unwrap();
            serde_json::from_str::<Value>(&reply).unwrap()
        };
        assert_eq!(
            call(actor, "GET", "/people/notes-settings", Value::Null),
            json!({"status":200,"body":{"folder":folder}})
        );
        let privacy = || {
            for id in [other, admin] {
                assert_eq!(
                    call(id, "GET", "/people/notes-settings", Value::Null),
                    json!({"status":200,"body":{"folder":null}}),
                    "Other users/admins must not read the owner's folder"
                );
            }
        };
        rt.block_on(
            bootstrap.batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"),
        )
        .unwrap();
        let red = catch_unwind(AssertUnwindSafe(privacy));
        rt.block_on(
            bootstrap.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY"),
        )
        .unwrap();
        assert!(
            red.is_err(),
            "Privacy assertion must fail when protection is removed"
        );
        println!("{env}: Settings privacy FAILED with RLS removed");
        privacy();
        println!("{env}: same Settings privacy PASSED with RLS restored");
        assert_eq!(
            call(actor, "GET", "/people/note-suggestions", Value::Null)["body"],
            json!({"enabled":true})
        );
        assert_eq!(
            call(
                actor,
                "PUT",
                "/people/note-suggestions",
                json!({"enabled":false})
            )["body"],
            json!({"enabled":false})
        );
        assert_eq!(
            call(other, "GET", "/people/note-suggestions", Value::Null)["body"],
            json!({"enabled":true})
        );
        let blob:Value=rt.block_on(bootstrap.query_one("SELECT value_json FROM app.preferences WHERE owner_user_id=$1 AND key='sourceBehaviors'",&[&actor])).unwrap().get(0);
        assert_eq!(
            blob,
            json!({"unrelated.behavior":false,"people.notes.suggest-updates":false})
        );
        assert_eq!(
            call(
                actor,
                "PUT",
                "/people/notes-settings",
                json!({"folder":outside})
            )["status"],
            400
        );
        assert_eq!(
            call(
                actor,
                "PUT",
                "/people/notes-settings",
                json!({"folder":"../outside"})
            )["status"],
            400
        );
        assert_eq!(
            call(
                actor,
                "PUT",
                "/people/notes-settings",
                json!({"folder":123})
            )["status"],
            400
        );
        assert_eq!(
            call(
                actor,
                "PUT",
                "/people/note-suggestions",
                json!({"enabled":"false"})
            )["status"],
            400
        );
        assert_eq!(
            call(actor, "GET", "/people/note-folders", Value::Null)["body"]["directories"][0]
                ["path"],
            json!(root)
        );
        let target = format!("/people/note-folders?path={}", root.display());
        assert_eq!(
            call(actor, "GET", &target, Value::Null)["body"]["directories"][0]["path"],
            json!(folder)
        );
        assert_eq!(
            call(
                other,
                "PUT",
                "/people/notes-settings",
                json!({"folder":null})
            )["status"],
            400
        );
        assert_eq!(
            call(other, "GET", "/people/notes-settings", Value::Null)["body"],
            json!({"folder":null})
        );
        assert_eq!(
            call(actor, "GET", "/people/notes-settings", Value::Null)["body"],
            json!({"folder":folder})
        );
        assert_eq!(
            call(
                actor,
                "PUT",
                "/people/notes-settings",
                json!({"folder":null})
            ),
            json!({"status":400,"body":{"error":"People notes folder is unavailable"}})
        );
        assert_eq!(
            call(actor, "GET", "/people/notes-settings", Value::Null)["body"],
            json!({"folder":folder})
        );
        assert_eq!(
            call(
                actor,
                "PUT",
                "/people/notes-settings",
                json!({"folder":folder})
            )["body"],
            json!({"folder":folder})
        );
        rt.block_on(bootstrap.execute(
            "DELETE FROM app.preferences WHERE key='sourceBehaviors' AND owner_user_id=$1",
            &[&actor],
        ))
        .unwrap();
        println!(
            "{env}: compiled Settings save/rejected-clear/browse/default-on/sibling settings checks PASSED"
        );
    }
    rt.block_on(bootstrap.execute(
        "DELETE FROM app.users WHERE id=ANY($1::uuid[])",
        &[&vec![actor, other, admin]],
    ))
    .unwrap();
}
