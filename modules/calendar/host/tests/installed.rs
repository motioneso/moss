#[path = "support/auto_plan_oracle.rs"]
mod auto_plan_oracle;
#[path = "support/day_plan_oracle.rs"]
mod day_plan_oracle;
#[path = "support/kv_guard.rs"]
mod kv_guard;
#[path = "support/operation_oracle.rs"]
mod operation_oracle;
#[path = "support/preview_oracle.rs"]
mod preview_oracle;
#[path = "support/read_oracle.rs"]
mod read_oracle;
#[path = "support/registry.rs"]
mod registry;
#[path = "support/settings_oracle.rs"]
mod settings_oracle;
#[path = "support/settings_scope.rs"]
mod settings_scope;
mod support;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{CallScope, Request},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Calendar data has no AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("Calendar data has no embeddings")
    }
}
#[test]
#[ignore = "Only through verify-gate"]
fn signed_rust_package_reuses_data_and_commits_only_successful_drafts() {
    let f = support::Fixture::new();
    f.rt.block_on(async {
        f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
        f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
        f.root.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'calendar.prep_task_mode','\"auto\"')",&[&f.a]).await.unwrap();
    });
    f.rt.block_on(async {
        for (actor, name) in [(f.a, "Cedar"), (f.b, "Juniper")] {
            f.root.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'persona.bundle',$2)", &[&actor, &json!({"assistantName":name,"personaText":"private persona must not be projected"})]).await.unwrap();
        }
    });
    read_oracle::seed(&f);
    let preview_seeded = preview_oracle::seed(&f);
    let dir = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_calendar_host::package::pack(&root, &f.core()).unwrap();
    let (key, publisher, artifact) = registry::publish(registry.path(), &bytes);
    let database = f.db.clone();
    let preview_refs = preview_seeded.references.clone();
    let captured = Arc::new(kv_guard::Captured::default());
    let observing = captured.clone();
    let app = Application::open_extended_with(
        dir.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
        },
        move |next| {
            let guarded: Arc<dyn moss_module_host::runtime::Ports> = Arc::new(
                moss_calendar_host::CalendarPorts::new(database, next.clone())?
                    .with_references(preview_refs.clone()),
            );
            *observing.guarded.lock().unwrap() = Some(guarded.clone());
            *observing.downstream.lock().unwrap() = Some(next);
            Ok(Arc::new(kv_guard::Observe {
                state: observing,
                next: guarded,
            }))
        },
    )
    .unwrap();
    let source = app
        .installer
        .refresh(
            &f.access(f.a),
            Source::Folder(registry.path().into()),
            &key,
            &publisher,
            "calendar-test-registry",
        )
        .unwrap();
    app.installer
        .install(&f.access(f.a), &source, &artifact, true)
        .unwrap();
    let call = |actor, method, path: &str, body: Value| -> Value {
        serde_json::from_str(
            &app.dispatch_extended(
                f.access(actor),
                method,
                &format!("/api/m/calendar{path}"),
                &body.to_string(),
            )
            .unwrap(),
        )
        .unwrap()
    };
    let owner = call(f.a, "GET", "/events", Value::Null);
    assert!(owner["body"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == f.event.to_string()));
    for actor in [f.b, f.admin] {
        let foreign = call(actor, "GET", &format!("/events/{}", f.event), Value::Null);
        assert_eq!(foreign["status"], 404);
        let plan = call(
            actor,
            "GET",
            "/day-plan?localDay=2026-11-08&timeZone=UTC",
            Value::Null,
        );
        assert_eq!(plan["body"]["plan"], Value::Null);
        let write = call(
            actor,
            "PATCH",
            &format!("/day-plans/{}/draft", f.plan),
            json!({"localDay":"2026-11-08","timeZone":"UTC","expectedRevision":1,"eveningIntent":{"notes":"foreign"}}),
        );
        assert_eq!(write["status"], 404);
    }
    read_oracle::compare(&app, &f);
    preview_oracle::compare(&app, &f, &preview_seeded);
    day_plan_oracle::verify(&app, &f);
    let settings = call(f.a, "GET", "/briefing-settings", Value::Null);
    assert_eq!(settings["body"]["settings"]["prepTaskMode"], "auto");
    let display = call(f.a, "GET", "/display-settings", Value::Null);
    assert_eq!(display["status"], 200);
    assert!(display["body"]["now"].as_str().is_some());
    assert_eq!(
        display["body"]["dateFormat"], "24",
        "Missing locale uses the production clock default"
    );
    assert_eq!(display["body"]["assistantName"], "Cedar");
    assert_eq!(
        call(f.b, "GET", "/display-settings", Value::Null)["body"]["assistantName"],
        "Juniper"
    );
    let no_foreign_name = || {
        call(f.admin, "GET", "/display-settings", Value::Null)["body"]["assistantName"] == "Moss"
    };
    assert!(
        no_foreign_name(),
        "Other accounts must not supply the assistant name"
    );
    f.rt.block_on(
        f.root
            .batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"),
    )
    .unwrap();
    let unprotected = no_foreign_name();
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE app.preferences FORCE ROW LEVEL SECURITY")).unwrap();
    assert!(
        !unprotected,
        "The same name assertion must detect removed preference RLS"
    );
    println!("RED assistant name: the same assertion detects another account's name with preference RLS removed");
    assert!(no_foreign_name());
    println!(
        "GREEN assistant name: preference RLS restores account isolation including administrators"
    );
    kv_guard::witness(&captured);
    let view = json!({"view":"week","cursor":"2026-11-08","workWeek":true});
    assert_eq!(
        call(f.a, "PATCH", "/display-settings", view.clone())["status"],
        200
    );
    assert_eq!(
        call(f.a, "GET", "/display-settings", Value::Null)["body"]["view"],
        view
    );
    assert_eq!(
        call(f.b, "GET", "/display-settings", Value::Null)["body"]["view"],
        Value::Null
    );
    assert_eq!(
        call(f.admin, "GET", "/display-settings", Value::Null)["body"]["view"],
        Value::Null
    );
    let bad = json!({"view":"month","cursor":"2026-11-08","workWeek":false,"timeBlockMode":"auto"});
    assert_eq!(call(f.a, "PATCH", "/display-settings", bad)["status"], 400);
    assert_eq!(
        call(f.a, "GET", "/display-settings", Value::Null)["body"]["view"],
        view
    );
    assert_eq!(
        call(f.b, "GET", "/briefing-settings", Value::Null)["body"]["settings"]["prepTaskMode"],
        "suggest"
    );
    f.rt.block_on(f.root.execute("INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('calendar_event',$1,$2,$3,'view')",&[&f.event,&f.a,&f.b])).unwrap();
    assert_eq!(
        call(f.b, "GET", &format!("/events/{}", f.event), Value::Null)["status"],
        200
    );
    read_oracle::compare(&app, &f);
    // A view grant does not grant write authority, and never shares the day plan.
    f.isolation("app.calendar_events", f.event, f.b, true)
        .unwrap();
    f.isolation("app.day_plans", f.plan, f.b, false).unwrap();
    f.rt.block_on(f.root.execute(
        "UPDATE app.shares SET level='manage' WHERE resource_id=$1 AND grantee_user_id=$2",
        &[&f.event, &f.b],
    ))
    .unwrap();
    f.rt.block_on(async {
        let cx = safety_core::db::DataContext::open(&f.db, &f.access(f.b))
            .await
            .unwrap();
        assert_eq!(
            cx.db()
                .execute(
                    "UPDATE app.calendar_events SET title='Managed event' WHERE id=$1",
                    &[&f.event]
                )
                .await
                .unwrap(),
            1
        );
        cx.commit().await.unwrap();
    });
    f.rt.block_on(f.root.execute(
        "DELETE FROM app.shares WHERE resource_id=$1 AND grantee_user_id=$2",
        &[&f.event, &f.b],
    ))
    .unwrap();
    assert_eq!(
        call(f.b, "GET", &format!("/events/{}", f.event), Value::Null)["status"],
        404
    );
    read_oracle::compare(&app, &f);
    let path = format!("/day-plans/{}/draft", f.plan);
    let input = json!({"localDay":"2026-11-08","timeZone":"UTC","expectedRevision":1,"eveningIntent":{"notes":"saved"}});
    assert_eq!(call(f.a, "PATCH", &path, input.clone())["status"], 200);
    assert_eq!(call(f.a, "PATCH", &path, input)["status"], 409);
    // An error after the revision CAS must roll back the entire invocation.
    let bad = json!({"localDay":"2026-11-08","timeZone":"UTC","expectedRevision":2,"blocks":[]});
    assert_eq!(call(f.a, "PATCH", &path, bad)["status"], 400);
    let plan = call(
        f.a,
        "GET",
        "/day-plan?localDay=2026-11-08&timeZone=UTC",
        Value::Null,
    );
    assert_eq!(plan["body"]["plan"]["revision"], 2);
    assert_eq!(
        plan["body"]["plan"]["blocks"][0]["actualPlacement"]["durationMinutes"],
        60
    );
    let saved = call(
        f.a,
        "PATCH",
        &path,
        json!({"localDay":"2026-11-08","timeZone":"UTC","expectedRevision":2,"blocks":[{"id":f.block,"kind":"focus","title":"Kept placement"},{"kind":"break","title":"   ","pendingChange":{"kind":"add","startsAt":"2026-11-08T12:00:00Z","durationMinutes":15}}]}),
    );
    assert_eq!(saved["status"], 200);
    assert_eq!(saved["body"]["plan"]["blocks"].as_array().unwrap().len(), 2);
    assert_eq!(saved["body"]["plan"]["blocks"][1]["title"], Value::Null);
    assert_eq!(
        saved["body"]["plan"]["blocks"][0]["actualPlacement"]["durationMinutes"],
        60
    );
    let refused = call(
        f.a,
        "PATCH",
        &path,
        json!({"localDay":"2026-11-08","timeZone":"UTC","expectedRevision":3,"eveningIntent":{"priorityTaskIds":[f.event]}}),
    );
    assert_eq!(refused["status"], 503);
    assert_eq!(
        call(
            f.a,
            "GET",
            "/day-plan?localDay=2026-11-08&timeZone=UTC",
            Value::Null
        )["body"]["plan"]["revision"],
        3
    );
    let created = call(
        f.a,
        "POST",
        "/day-plans",
        json!({"localDay":"2026-11-09","timeZone":"UTC"}),
    );
    assert_eq!(created["status"], 200);
    assert_eq!(
        call(
            f.a,
            "POST",
            "/day-plans",
            json!({"localDay":"2026-11-09","timeZone":"UTC"})
        )["body"]["plan"]["id"],
        created["body"]["plan"]["id"]
    );
    f.rt.block_on(async {
        let rows = f
            .root
            .query(
                "SELECT path FROM moss_modules.migrations WHERE module_id='calendar'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(rows.len(), 15);
        assert!(f
            .root
            .query_opt(
                "SELECT 1 FROM app.schema_migrations WHERE version='0229a'",
                &[]
            )
            .await
            .unwrap()
            .is_some());
    });
    settings_oracle::verify(&app, &f, &captured);
    println!("PASS signed registry download + install; actual Rust Wasm events/plans/preferences; owner/foreign/admin; revision conflict; rollback; original fifteen ledgers");
    operation_oracle::verify(&app, &f);
    auto_plan_oracle::verify(&app, &f);
}
