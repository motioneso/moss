//! Real generated People guest, unchanged legacy tables, real queue and command
//! records. Only the optional signal provider is a documented stand-in.
mod common;
#[path = "../../parity/src/canon.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod parity_canon;
use access_context::AccessContext;
use moss_module_host::{
    after_commit_jobs::AfterCommitJobs,
    context::ContextPorts,
    jobs::{module_key, specs, JobPorts},
    local::LocalPorts,
    manifest::{Ledger, Manifest},
    runtime::{CallScope, Host, Limits, Ports, Request},
    transactional_database::TransactionalDatabasePorts,
};
use moss_people::{
    jobs::{COMMANDS, INDEX, MEMORY, PROVIDERS},
    repository::{EVENTS, TABLES},
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::Secret,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use uuid::Uuid;

#[test]
fn shipping_people_manifest_is_valid_and_has_no_provider_map_write() {
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../../modules/people/moss.module.json")).unwrap();
    manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
    let kv = manifest.capability("kv").unwrap();
    assert!(kv.operations.contains("get") && kv.resources.contains("person-providers"));
    assert!(!kv.operations.contains("set") && !kv.operations.contains("delete"));
}

struct Provider {
    next: Arc<dyn Ports>,
    signals: Value,
    actor: Uuid,
    inputs: Mutex<Vec<Value>>,
    sync: Mutex<Vec<String>>,
    runtime: tokio::runtime::Runtime,
    bootstrap: tokio_postgres::Client,
}
impl Ports for Provider {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        if port == "api" {
            assert_eq!(scope.access().actor_user_id(), self.actor);
            assert_eq!(request.resource, "source.email");
            assert_eq!(request.parameters["name"], "collectPersonSignals");
            let mut input = request.parameters["parameters"].clone();
            input["actorUserId"] = json!(scope.access().actor_user_id());
            self.inputs.lock().unwrap().push(input.clone());
            return Ok(
                json!({"signals":if input["sourceRefHash"]=="empty-source" {json!([])} else {self.signals.clone()}}),
            );
        }
        if port == "jobs" && request.resource == MEMORY && request.operation == "enqueue-options" {
            // A separate real connection must see the committed People writes before
            // memory work is published. This fails for in-transaction publication.
            let count: i64 = self.runtime.block_on(async {
                self.bootstrap.query_one("SELECT count(*) FROM app.person_context_indexing_state WHERE owner_user_id=$1", &[&self.actor]).await.unwrap().get(0)
            });
            assert!(count > 0, "Memory sync must follow the People DB commit");
            self.sync.lock().unwrap().push(
                request.parameters["params"]["command-id"]
                    .as_str()
                    .unwrap()
                    .into(),
            );
        }
        self.next.invoke(scope, port, request)
    }
}
struct Fault {
    next: Arc<dyn Ports>,
    armed: AtomicBool,
}
impl Ports for Fault {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let value = self.next.invoke(scope, port, request)?;
        if port == "db"
            && request.resource == EVENTS
            && request.parameters["kind"] == "insert"
            && self.armed.swap(false, Ordering::SeqCst)
        {
            anyhow::bail!("Synthetic failure after actual indexing writes");
        }
        Ok(value)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.next.finish_call(scope, success)
    }
}

fn rows(rt: &tokio::runtime::Runtime, db: &tokio_postgres::Client, actor: Uuid) -> Value {
    let mut value = json!({});
    for table in TABLES {
        value[table] = json!(rt.block_on(async {
            db.query(
                &format!("SELECT to_jsonb(p) FROM {table} p WHERE owner_user_id=$1"),
                &[&actor],
            )
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<_, Value>(0))
            .collect::<Vec<_>>()
        }));
    }
    value
}
fn compare_rows(
    actual: &Value,
    expected: &Value,
    a: &mut parity_canon::Canon,
    e: &mut parity_canon::Canon,
) {
    for table in TABLES {
        assert_eq!(
            a.rows(actual[table].as_array().unwrap()),
            e.rows(expected[table].as_array().unwrap()),
            "Worker parity in {table}"
        );
    }
}

#[test]
#[ignore = "Only through verify-gate and tools/people-gate.sh"]
fn compiled_index_jobs_match_legacy_rows_and_publish_only_references_after_commit() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let component = std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap();
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("JS50_PEOPLE_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let oracle = &oracle["jobs"];
    let actor: Uuid = oracle["actor"].as_str().unwrap().parse().unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let connect = || {
        rt.block_on(async {
            let (db, connection) = tokio_postgres::connect(
                &std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
                tokio_postgres::NoTls,
            )
            .await
            .unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            db
        })
    };
    let bootstrap = connect();
    rt.block_on(bootstrap.batch_execute(moss_platform_jobs::MIGRATION))
        .unwrap();
    let app = rt
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let worker = rt
        .block_on(Database::connect(
            &std::env::var("JS43_WORKER_URL").unwrap(),
            4,
            RuntimeRole::Worker,
        ))
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let local = Arc::new(LocalPorts::new(temp.path()).unwrap());
    let queue = Arc::new(
        JobPorts::new(
            Secret::new(std::env::var("JS43_APP_URL").unwrap()),
            app,
            local,
        )
        .unwrap(),
    );
    let provider = Arc::new(Provider {
        next: queue,
        signals: oracle["signals"].clone(),
        actor,
        inputs: Mutex::new(vec![]),
        sync: Mutex::new(vec![]),
        runtime: tokio::runtime::Runtime::new().unwrap(),
        bootstrap: connect(),
    });
    let ports = Arc::new(Fault {
        next: Arc::new(
            TransactionalDatabasePorts::new(
                worker,
                Arc::new(ContextPorts::new(Arc::new(AfterCommitJobs::new(
                    provider.clone(),
                )))),
            )
            .unwrap(),
        ),
        armed: AtomicBool::new(false),
    });
    // Exercise the released grant set too: the provider fixture below has broader
    // capabilities and cannot establish that a packaged worker can start.
    let shipping: Arc<Manifest> = Arc::new(
        serde_json::from_str(include_str!("../../../modules/people/moss.module.json")).unwrap(),
    );
    let host = Host::new(Limits::default()).unwrap();
    let missing_id = Uuid::new_v4();
    host.call(
        &component,
        shipping.clone(),
        AccessContext::new(actor, "people-shipping-enqueue"),
        ports.clone(),
        "api",
        &json!({"name":"enqueueIndex","parameters":{"commandId":missing_id,"source":"manual","sourceRefHash":"shipping-no-provider","reason":"manual_refresh"}}).to_string(),
    ).unwrap();
    let before_shipping = rows(&rt, &bootstrap, actor);
    host.call(
        &component,
        shipping,
        AccessContext::new(actor, "people-shipping-worker"),
        ports.clone(),
        "job",
        &json!({"queue":INDEX,"parameters":{"command-id":missing_id}}).to_string(),
    )
    .expect("The shipped People grants must allow missing-provider indexing to finish");
    assert_eq!(rows(&rt, &bootstrap, actor), before_shipping);
    let mut manifest = common::manifest("0.1.0");
    manifest.id = "people".into();
    manifest.database.ledger = Ledger::CoreLegacy;
    manifest.database.owned_tables = TABLES.map(str::to_owned).to_vec();
    manifest
        .requires
        .insert("source.email".into(), ">=0.1.0".parse().unwrap());
    manifest.capabilities=serde_json::from_value(json!([
        {"port":"db","operations":["query"],"resources":TABLES},
        {"port":"context","operations":["read"],"resources":["call"]},
        {"port":"vault","operations":["notes.read"],"resources":[]},
        {"port":"kv","operations":["get","set","records.get","records.put"],"resources":[COMMANDS,PROVIDERS]},
        {"port":"jobs","operations":["enqueue-options","enqueue-after-commit"],"resources":[INDEX,MEMORY]},
        {"port":"api","operations":["call"],"resources":["source.email"]}
    ])).unwrap();
    for name in [INDEX, MEMORY] {
        manifest.jobs.insert(
            name.into(),
            [(
                "command-id".into(),
                moss_module_host::manifest::ParameterKind::Id,
            )]
            .into(),
        );
    }
    manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
    let manifest: Arc<Manifest> = Arc::new(manifest);
    let host = Host::new(Limits::default()).unwrap();
    let run = |user, kind: &str, p: Value| {
        host.call(
            &component,
            manifest.clone(),
            AccessContext::new(user, "people-job-parity"),
            ports.clone(),
            kind,
            &p.to_string(),
        )
    };
    let kv = |user, op: &str, resource: &str, p: Value| -> anyhow::Result<Value> {
        Ok(serde_json::from_str(&host.call(
            &common::wasm(),
            manifest.clone(),
            AccessContext::new(user, "people-job-record"),
            ports.clone(),
            "route",
            &json!({"operation":op,"resource":resource,"parameters":p}).to_string(),
        )?)?)
    };
    kv(actor, "set", PROVIDERS, json!({"email":"source.email"})).unwrap();
    let jobs = rt
        .block_on(moss_platform_jobs::Queue::connect(
            &std::env::var("JS43_WORKER_URL").unwrap(),
            moss_platform_jobs::Role::Worker,
            specs(&manifest),
        ))
        .unwrap();
    let known: HashSet<_> = [actor.to_string()].into();
    let mut expected = parity_canon::Canon::new(
        oracle["startedAt"].as_str().unwrap().parse().unwrap(),
        &known,
    );
    let mut actual = parity_canon::Canon::new(chrono::Utc::now(), &known);
    for (number, case) in oracle["cases"].as_array().unwrap().iter().enumerate() {
        provider.inputs.lock().unwrap().clear();
        provider.sync.lock().unwrap().clear();
        let command = &case["command"];
        let id: Uuid = command["commandId"].as_str().unwrap().parse().unwrap();
        let request = json!({"name":"enqueueIndex","parameters":command});
        let started = chrono::Utc::now();
        run(actor, "api", request.clone()).expect("The compiled guest must enqueue indexing");
        run(actor, "api", request).unwrap();
        let finished = chrono::Utc::now();
        rt.block_on(async {
            let queued=bootstrap.query("SELECT payload,run_at FROM moss_queue.jobs WHERE actor_user_id=$1 AND idempotency_key=$2",&[&actor,&id]).await.unwrap();
            assert_eq!(queued.len(),1,"An enqueue retry must preserve command identity");
            assert_eq!(queued[0].get::<_,Value>(0)["params"],json!({"command-id":id}));
            let scheduled: chrono::DateTime<chrono::Utc> = queued[0].get(1);
            assert!(scheduled >= started + chrono::Duration::seconds(899)
                && scheduled <= finished + chrono::Duration::minutes(15),
                "Indexing retains the fifteen-minute delay");
            if number==0 { assert!(jobs.claim().await.unwrap().is_none(),"No early claim of delayed indexing"); }
            bootstrap.execute("UPDATE moss_queue.jobs SET run_at=now()-interval '1 second' WHERE actor_user_id=$1 AND idempotency_key=$2",&[&actor,&id]).await.unwrap();
        });
        let mut claimed = rt.block_on(jobs.claim()).unwrap().unwrap();
        assert_eq!(claimed.actor.user_id(), actor);
        let job = json!({"queue":INDEX,"parameters":claimed.metadata.params().unwrap()});
        let before = rows(&rt, &bootstrap, actor);
        if number == 1 {
            ports.armed.store(true, Ordering::SeqCst);
            assert!(run(actor, "job", job.clone()).is_err());
            assert_eq!(
                rows(&rt, &bootstrap, actor),
                before,
                "Failed indexing must roll back all projections"
            );
            assert!(
                provider.sync.lock().unwrap().is_empty(),
                "A failed invocation must publish no memory work"
            );
            provider.inputs.lock().unwrap().clear();
            rt.block_on(jobs.finish(&claimed, false)).unwrap();
            rt.block_on(async {
                bootstrap
                    .execute(
                        "UPDATE moss_queue.jobs SET run_at=now()-interval '1 second' WHERE id=$1",
                        &[&claimed.id],
                    )
                    .await
                    .unwrap();
            });
            let retry = rt.block_on(jobs.claim()).unwrap().unwrap();
            assert_eq!(retry.id, claimed.id, "Retry keeps the same durable job");
            assert_eq!(
                retry.metadata.params().unwrap(),
                claimed.metadata.params().unwrap()
            );
            claimed = retry;
        }
        run(actor, "job", job.clone()).unwrap();
        rt.block_on(jobs.finish(&claimed, true)).unwrap();
        let got = rows(&rt, &bootstrap, actor);
        compare_rows(&got, &case["rows"], &mut actual, &mut expected);
        assert_eq!(
            json!(*provider.inputs.lock().unwrap()),
            case["providerInputs"],
            "Source version and authenticated provider actor must survive"
        );
        let sync = provider.sync.lock().unwrap().clone();
        let mut sync_values = vec![];
        for reference in &sync {
            let record = kv(actor, "records.get", COMMANDS, json!({"id":reference})).unwrap();
            let mut payload = record["command"].clone();
            payload.as_object_mut().unwrap().remove("commandId");
            payload["actorUserId"] = json!(actor);
            sync_values.push(json!({"queue":MEMORY,"payload":payload}));
        }
        let mut expected_sync = case["queued"].clone();
        for entry in expected_sync.as_array_mut().unwrap() {
            entry["payload"]
                .as_object_mut()
                .unwrap()
                .remove("idempotencyKey");
        }
        assert_eq!(
            actual.value(&json!(sync_values)),
            expected.value(&expected_sync),
            "Memory stub follow-ups match legacy intent"
        );
        for _ in &sync {
            let memory = rt.block_on(jobs.claim()).unwrap().unwrap();
            assert_eq!(
                memory.metadata.job_kind(),
                format!("{}.{}", module_key("people"), MEMORY)
            );
            run(
                actor,
                "job",
                json!({"queue":MEMORY,"parameters":memory.metadata.params().unwrap()}),
            )
            .unwrap();
            rt.block_on(jobs.finish(&memory, true)).unwrap();
        }
        assert_eq!(
            rows(&rt, &bootstrap, actor),
            got,
            "Memory sync remains a no-write stub"
        );
        for is_admin in [false, true] {
            let other = Uuid::new_v4();
            rt.block_on(bootstrap.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Job privacy',$3)",&[&other,&format!("people-jobs-{other}@example.test"),&is_admin])).unwrap();
            assert!(kv(other, "records.get", COMMANDS, json!({"id":id}))
                .unwrap()
                .is_null());
            assert!(
                run(other, "job", job.clone()).is_err(),
                "Another account cannot execute the owner's command"
            );
            rt.block_on(bootstrap.execute("DELETE FROM app.users WHERE id=$1", &[&other]))
                .unwrap();
        }
    }
    println!("PASS compiled worker/legacy row parity; opaque source versions; real delayed queue/retries; metadata-only references; worker RLS; rollback; memory publication after commit; missing provider and no-write memory stub");
}
