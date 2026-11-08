mod common;
use access_context::AccessContext;
use moss_module_host::{
    jobs::{module_key, specs, JobPorts},
    manifest::{Capability, ParameterKind},
    runtime::{DenyPorts, Host, Limits},
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::Secret,
};
use serde_json::{json, Value};
use std::sync::Arc;

#[test]
#[ignore = "Only through verify-gate and tools/enqueue-options-gate.ts"]
fn delayed_enqueue_preserves_queue_time_key_and_actor() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let (db, app) = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(
            &std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.batch_execute(moss_platform_jobs::MIGRATION)
            .await
            .unwrap();
        let app = Database::connect(&app_url, 4, RuntimeRole::App)
            .await
            .unwrap();
        (db, app)
    });
    let ports = Arc::new(JobPorts::new(Secret::new(app_url), app, Arc::new(DenyPorts)).unwrap());
    let mut manifest = common::manifest("0.1.0");
    manifest.id = "sample.enqueue-options".into();
    manifest.capabilities = vec![Capability {
        port: "jobs".into(),
        operations: ["enqueue".into(), "enqueue-options".into()].into(),
        resources: ["person-index".into(), "sync-person-memory".into()].into(),
        allow_private: false,
    }];
    for name in ["person-index", "sync-person-memory"] {
        manifest.jobs.insert(
            name.into(),
            [("command-id".into(), ParameterKind::Id)].into(),
        );
    }
    manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
    let manifest = Arc::new(manifest);
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/jobs@"),
    )
    .unwrap();
    let host = Host::new(Limits::default()).unwrap();
    let owner = uuid::Uuid::new_v4();
    let other = uuid::Uuid::new_v4();
    let key = uuid::Uuid::new_v4();
    let command = uuid::Uuid::new_v4();
    let at = (chrono::Utc::now() + chrono::Duration::minutes(15))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let params = json!({"command-id":command});
    let enqueue = |actor, queue: &str, operation: &str, parameters: Value| -> Value {
        serde_json::from_str(
            &host
                .call(
                    &wasm,
                    manifest.clone(),
                    AccessContext::new(actor, "enqueue-options-test"),
                    ports.clone(),
                    "route",
                    &json!({"operation":operation,"resource":queue,"parameters":parameters})
                        .to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    };
    let options = json!({"params":params,"idempotencyKey":key,"availableAt":at});
    let first = enqueue(owner, "person-index", "enqueue-options", options.clone());
    let first_id: uuid::Uuid = first["id"].as_str().unwrap().parse().unwrap();
    assert!(
        enqueue(owner, "person-index", "enqueue-options", options.clone())["id"].is_null(),
        "Retry must not create a second job"
    );
    assert!(
        enqueue(other, "person-index", "enqueue-options", options.clone())["id"].is_string(),
        "Another actor has an independent key"
    );
    assert!(
        enqueue(owner, "sync-person-memory", "enqueue-options", options)["id"].is_string(),
        "Another queue has an independent key"
    );
    runtime.block_on(async {
        let row = db.query_one("SELECT actor_user_id,queue,idempotency_key,payload,extract(epoch from run_at)::float8 FROM moss_queue.jobs WHERE id=$1", &[&first_id]).await.unwrap();
        assert_eq!(row.get::<_, uuid::Uuid>(0), owner);
        assert_eq!(row.get::<_, String>(1), format!("{}.person-index", module_key(&manifest.id)));
        assert_eq!(row.get::<_, uuid::Uuid>(2), key);
        let payload: Value = row.get(3);
        assert_eq!(payload["actorUserId"], owner.to_string());
        assert_eq!(payload["moduleId"], module_key(&manifest.id));
        assert_eq!(payload["params"], params);
        let expected = chrono::DateTime::parse_from_rfc3339(&at).unwrap().timestamp_millis();
        assert_eq!((row.get::<_, f64>(4) * 1000.0).round() as i64, expected);
        let worker = moss_platform_jobs::Queue::connect(&std::env::var("JS43_WORKER_URL").unwrap(), moss_platform_jobs::Role::Worker, specs(&manifest)).await.unwrap();
        assert!(worker.claim().await.unwrap().is_none(), "Future work must not be claimed early");
    });
    // Old enqueue still creates independent, immediately available jobs.
    let old_a = enqueue(owner, "person-index", "enqueue", params.clone());
    let old_b = enqueue(owner, "person-index", "enqueue", params);
    assert!(old_a["id"].is_string() && old_b["id"].is_string());
    assert_ne!(old_a["id"], old_b["id"]);
    runtime.block_on(async {
        let worker = moss_platform_jobs::Queue::connect(
            &std::env::var("JS43_WORKER_URL").unwrap(),
            moss_platform_jobs::Role::Worker,
            specs(&manifest),
        )
        .await
        .unwrap();
        let claimed = worker
            .claim()
            .await
            .unwrap()
            .expect("Legacy immediate work remains runnable");
        assert_eq!(claimed.actor.user_id(), owner);
        worker.finish(&claimed, true).await.unwrap();
    });
    println!("PASS real Wasm → JobPorts → PostgreSQL queue: delayed time retained, retries deduplicated, keys scoped to actor and queue, no early claim, legacy immediate enqueue unchanged");
}
