use async_trait::async_trait;
use chrono::{Duration, Utc};
use moss_platform_contracts::{Actor, Error, Metadata, QueueSpec};
use moss_platform_jobs::{JobHandler, Queue, Role};
use serde_json::json;
use tokio_postgres::NoTls;
use uuid::Uuid;

fn id(n: u128) -> Uuid {
    Uuid::from_u128(0x00000000000040008000000000000000 + n)
}
fn actor(n: u128) -> Actor {
    Actor::from_authenticated_session(id(n), Uuid::new_v4())
}
fn spec() -> QueueSpec {
    serde_json::from_value(json!({"name":"tasks.defer","moduleId":"tasks","jobKinds":["defer"],"paramsSchema":{"type":"object","fields":{"taskId":{"type":"uuid"},"requestedStatus":{"type":"enum","values":["todo","done"]}}},"retryLimit":1,"retryDelaySeconds":0,"retryBackoff":true,"leaseSeconds":60})).unwrap()
}
fn payload(n: u128) -> serde_json::Value {
    json!({"actorUserId":id(n),"moduleId":"tasks","jobKind":"defer","manifestHash":format!("sha256:{}","a".repeat(64)),"params":{"taskId":id(100),"requestedStatus":"done"}})
}
#[tokio::test]
#[ignore = "only via scripts/run-gate.sh and tools/gate.sh"]
async fn postgres_queue_lifecycle() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let app = std::env::var("JS39_APP_URL").unwrap();
    let worker = std::env::var("JS39_WORKER_URL").unwrap();
    let migration = std::env::var("JS39_MIGRATION_URL").unwrap();
    let (db, conn) = tokio_postgres::connect(&migration, NoTls).await.unwrap();
    tokio::spawn(async move { conn.await.unwrap() });
    db.batch_execute(moss_platform_jobs::MIGRATION)
        .await
        .unwrap();
    // FORCE RLS also applies to the migration owner. Inspect resulting rows with
    // the gate's bootstrap oracle, never with a runtime connection.
    let (db, conn) = tokio_postgres::connect(&std::env::var("JS39_BOOTSTRAP_URL").unwrap(), NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { conn.await.unwrap() });
    let producer = Queue::connect(&app, Role::Producer, vec![spec()])
        .await
        .unwrap();
    let worker_a = Queue::connect(&worker, Role::Worker, vec![spec()])
        .await
        .unwrap();
    let worker_b = Queue::connect(&worker, Role::Worker, vec![spec()])
        .await
        .unwrap();
    assert!(Queue::connect(&migration, Role::Worker, vec![spec()])
        .await
        .is_err());
    assert!(Queue::connect(&app, Role::Worker, vec![spec()])
        .await
        .is_err());
    let now = Utc::now() - Duration::seconds(1);
    let key = Uuid::new_v4();
    let first = producer
        .enqueue(actor(1), "tasks.defer", payload(1), key, now)
        .await
        .unwrap()
        .unwrap();
    assert!(producer
        .enqueue(actor(1), "tasks.defer", payload(1), key, now)
        .await
        .unwrap()
        .is_none());
    assert!(producer
        .enqueue(actor(2), "tasks.defer", payload(2), key, now)
        .await
        .unwrap()
        .is_some());
    assert!(producer
        .enqueue(actor(2), "tasks.defer", payload(1), Uuid::new_v4(), now)
        .await
        .is_err());
    let mut bad = payload(1);
    bad["params"]["content"] = json!("SENTINEL-secret");
    assert!(producer
        .enqueue(actor(1), "tasks.defer", bad, Uuid::new_v4(), now)
        .await
        .is_err());
    let (a, b) = tokio::join!(worker_a.claim(), worker_b.claim());
    let a = a.unwrap().unwrap();
    let b = b.unwrap().unwrap();
    assert_ne!(a.id, b.id);
    worker_a.renew(&a).await.unwrap();
    worker_a.finish(&a, true).await.unwrap();
    worker_b.finish(&b, false).await.unwrap();
    assert_eq!(worker_a.finish(&a, true).await, Err(Error::StaleLease));
    let retry = worker_a.claim().await.unwrap().unwrap();
    assert_eq!(retry.id, b.id);
    worker_a.finish(&retry, false).await.unwrap();
    assert!(worker_a.claim().await.unwrap().is_none());
    let row = db
        .query_one(
            "SELECT state,attempts FROM moss_queue.jobs WHERE id=$1",
            &[&b.id],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "failed");
    assert_eq!(row.get::<_, i32>(1), 2);
    producer
        .enqueue(actor(1), "tasks.defer", payload(1), Uuid::new_v4(), now)
        .await
        .unwrap();
    let stale = worker_a.claim().await.unwrap().unwrap();
    db.execute(
        "UPDATE moss_queue.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        &[&stale.id],
    )
    .await
    .unwrap();
    assert_eq!(worker_a.finish(&stale, true).await, Err(Error::StaleLease));
    let recovered = worker_b.claim().await.unwrap().unwrap();
    assert_eq!(stale.id, recovered.id);
    assert_eq!(worker_a.renew(&stale).await, Err(Error::StaleLease));
    worker_b.finish(&recovered, true).await.unwrap();
    let future = producer
        .enqueue(
            actor(1),
            "tasks.defer",
            payload(1),
            Uuid::new_v4(),
            Utc::now() + Duration::days(1),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(worker_a.claim().await.unwrap().is_none());
    db.execute(
        "UPDATE moss_queue.jobs SET run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        &[&future],
    )
    .await
    .unwrap();
    struct Handler;
    #[async_trait]
    impl JobHandler for Handler {
        async fn execute_in_data_context(
            &self,
            actor: Actor,
            metadata: &Metadata,
        ) -> Result<(), Error> {
            assert_eq!(actor.user_id(), metadata.actor_user_id());
            assert_eq!(metadata.job_kind(), "defer");
            Ok(())
        }
    }
    assert!(worker_a.run_one(&Handler).await.unwrap());
    let schedule = Uuid::new_v4();
    producer
        .schedule(
            actor(1),
            schedule,
            "tasks.defer",
            payload(1),
            "* * * * *",
            "UTC",
            Utc::now() - Duration::minutes(2),
        )
        .await
        .unwrap();
    let invalid_payload_schedule = Uuid::new_v4();
    let invalid_cron_schedule = Uuid::new_v4();
    for invalid in [invalid_payload_schedule, invalid_cron_schedule] {
        producer
            .schedule(
                actor(1),
                invalid,
                "tasks.defer",
                payload(1),
                "* * * * *",
                "UTC",
                Utc::now() - Duration::days(1),
            )
            .await
            .unwrap();
    }
    db.execute(
        "UPDATE moss_queue.schedules SET payload='{}'::jsonb WHERE id=$1",
        &[&invalid_payload_schedule],
    )
    .await
    .unwrap();
    db.execute(
        "UPDATE moss_queue.schedules SET cron='not cron' WHERE id=$1",
        &[&invalid_cron_schedule],
    )
    .await
    .unwrap();
    let (a, b) = tokio::join!(worker_a.tick(), worker_b.tick());
    assert_eq!(
        a.unwrap() + b.unwrap(),
        1,
        "downtime must coalesce, not replay every missed occurrence"
    );
    assert_eq!(worker_a.tick().await.unwrap(), 0);
    let quarantined = db
        .query_one(
            "SELECT count(*) FROM moss_queue.schedules WHERE disabled_reason IS NOT NULL",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        quarantined.get::<_, i64>(0),
        2,
        "bad schedules must not block healthy schedules"
    );
    assert!(!producer.unschedule(actor(2), schedule).await.unwrap());
    assert!(producer.unschedule(actor(1), schedule).await.unwrap());
    assert!(!producer.unschedule(actor(1), schedule).await.unwrap());
    let row = db
        .query_one(
            "SELECT count(*) FROM moss_queue.jobs WHERE actor_user_id=$1",
            &[&id(1)],
        )
        .await
        .unwrap();
    assert!(row.get::<_, i64>(0) >= 4);
    let (scoped, conn) = tokio_postgres::connect(&app, NoTls).await.unwrap();
    tokio::spawn(async move { conn.await.unwrap() });
    scoped.batch_execute("BEGIN").await.unwrap();
    scoped
        .query_one(
            "SELECT set_config('app.actor_user_id',$1,true)",
            &[&id(2).to_string()],
        )
        .await
        .unwrap();
    assert!(scoped
        .query_opt("SELECT id FROM moss_queue.jobs WHERE id=$1", &[&first])
        .await
        .unwrap()
        .is_none());
    scoped.batch_execute("ROLLBACK").await.unwrap();
    let row = db
        .query_one(
            "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE '%SENTINEL%'",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, i64>(0), 0);
    let mut long_spec = spec();
    long_spec.name = "tasks.long".into();
    long_spec.lease_seconds = 1;
    let long_producer = Queue::connect(&app, Role::Producer, vec![long_spec.clone()])
        .await
        .unwrap();
    let long_worker = Queue::connect(&worker, Role::Worker, vec![long_spec.clone()])
        .await
        .unwrap();
    let competitor = Queue::connect(&worker, Role::Worker, vec![long_spec])
        .await
        .unwrap();
    long_producer
        .enqueue(actor(1), "tasks.long", payload(1), Uuid::new_v4(), now)
        .await
        .unwrap();
    struct SlowHandler;
    #[async_trait]
    impl JobHandler for SlowHandler {
        async fn execute_in_data_context(&self, _: Actor, _: &Metadata) -> Result<(), Error> {
            tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
            Ok(())
        }
    }
    let (ran, ()) = tokio::join!(long_worker.run_one(&SlowHandler), async {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        assert!(
            competitor.claim().await.unwrap().is_none(),
            "live handler lost its lease"
        );
    });
    assert!(ran.unwrap());
    println!("QUEUE PASS: duplicate keys, actor boundary, SKIP LOCKED, retries, stale fencing, delayed jobs, worker context, recurring schedules, sentinel absence, automatic heartbeat, invalid schedule quarantine, missed-run coalescing, actor-scoped cancellation");
}
