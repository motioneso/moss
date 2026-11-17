//! Real installed-package proofs. Run only through scripts/run-gate.sh.
#[path = "support/registry.rs"]
mod registry;
#[path = "support/replay.rs"]
mod replay;
mod support;
use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::{Limits, Host},
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;

const MARK: &str = "PLANTED-MARKER-7d2e41";

/// Goals declares no model port. This stub only satisfies the host's configuration.
struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("Goals does not call a model")
    }
    fn embed(&self, _: &moss_module_host::runtime::CallScope, _: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
        anyhow::bail!("Goals does not embed")
    }
}

fn component() -> Vec<u8> {
    std::fs::read(
        std::env::var("GOALS_COMPONENT_WASM")
            .expect("Run modules/goals/tools/check.sh to build the component"),
    )
    .unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// Reads as the app role with the actor set, so row security applies as it does at run time.
fn rows_as(
    f: &support::Fixture,
    actor: uuid::Uuid,
    sql: &str,
) -> Vec<tokio_postgres::Row> {
    f.rt.block_on(async {
        let (mut client, conn) =
            tokio_postgres::connect(&std::env::var("JS48_APP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let tx = client.transaction().await.unwrap();
        tx.execute("SELECT set_config('app.actor_user_id', $1, true)", &[&actor.to_string()]).await.unwrap();
        let rows = tx.query(sql, &[]).await.unwrap();
        tx.commit().await.unwrap();
        rows
    })
}

struct World {
    f: support::Fixture,
    app: Application,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}
impl World {
    fn new() -> Self {
        let f = support::Fixture::new();
        f.rt.block_on(async {
            let ready = f.root.query_one("SELECT to_regclass('moss_queue.jobs') IS NOT NULL", &[]).await.unwrap().get::<_, bool>(0);
            if !ready {
                f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
                f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
            }
        });
        f.rt.block_on(f.root.execute("DELETE FROM moss_modules.catalog", &[])).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let reg = tempfile::tempdir().unwrap();
        let bytes = moss_goals_host::package::pack(&root(), &component()).unwrap();
        let (key, publisher, artifact) = registry::publish(reg.path(), &bytes);
        let app = Application::open_extended_with(
            dir.path(),
            f.db.clone(),
            f.access(f.a),
            Configuration {
                migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
                producer: Secret::new(std::env::var("JS48_APP_URL").unwrap()),
                cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                intelligence: Arc::new(NoModel),
                version: "0.1.0".parse().unwrap(),
                browser_dir: None,
                compiled_cache: None,
                fuel_ceiling: Some(250_000_000),
            },
            |next| Ok(next),
        )
        .unwrap();
        let source = app
            .installer
            .refresh(&f.access(f.a), Source::Folder(reg.path().into()), &key, &publisher, "goals-test-registry")
            .unwrap();
        app.installer.install(&f.access(f.a), &source, &artifact, true).unwrap();
        Self { f, app, _dirs: (dir, reg) }
    }
    fn call(&self, actor: uuid::Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .dispatch_extended(self.f.access(actor), method, &format!("/api/m/goals{path}"), &body.to_string())
                .unwrap(),
        )
        .unwrap()
    }
    fn add_user(&self) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        self.f.rt.block_on(self.f.root.execute(
            "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Goal Parity',false)",
            &[&id, &format!("{id}@example.test")],
        )).unwrap();
        id
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn goals_routes_work_and_a_second_person_is_refused() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let created = w.call(a, "POST", "/goals", json!({"title":MARK,"desiredOutcome":"Ship it","priority":4}));
    assert_eq!(created["status"], 201, "{created}");
    let id = created["body"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["body"]["status"], "active");

    let evidence = w.call(a, "POST", &format!("/goals/{id}/evidence"),
        json!({"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":MARK}));
    assert_eq!(evidence["status"], 201, "{evidence}");

    let list = w.call(a, "GET", "/goals", json!(null));
    assert_eq!(list["body"].as_array().unwrap().len(), 1);

    // The second person sees nothing, through the routes or the database.
    assert_eq!(w.call(b, "GET", "/goals", json!(null))["body"], json!([]));
    assert_eq!(w.call(b, "GET", &format!("/goals/{id}"), json!(null))["status"], 404);
    assert!(rows_as(&w.f, b, "SELECT id FROM app.moss_goals").is_empty());
    assert_eq!(rows_as(&w.f, a, "SELECT id FROM app.moss_goals").len(), 1);
    println!("PASS rls: the second person reads no goals");

    // With the owner rule removed, the second person can read them. The rule is put back.
    w.f.rt.block_on(w.f.root.execute("DROP POLICY moss_goals_rw ON app.moss_goals", &[])).unwrap();
    w.f.rt.block_on(w.f.root.execute(
        "CREATE POLICY moss_goals_rw ON app.moss_goals FOR ALL TO jarvis_app_runtime USING (true) WITH CHECK (true)",
        &[],
    )).unwrap();
    let leaked = rows_as(&w.f, b, "SELECT id FROM app.moss_goals");
    w.f.rt.block_on(w.f.root.execute("DROP POLICY moss_goals_rw ON app.moss_goals", &[])).unwrap();
    w.f.rt.block_on(w.f.root.execute(
        "CREATE POLICY moss_goals_rw ON app.moss_goals FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id())",
        &[],
    )).unwrap();
    assert_eq!(leaked.len(), 1, "without the policy the second person must see the goal");
    assert!(rows_as(&w.f, b, "SELECT id FROM app.moss_goals").is_empty());
    println!("PASS rls: removing the policy lets the second person in, restoring it shuts them out");

    // Closing refuses further evidence.
    let closed = w.call(a, "PATCH", &format!("/goals/{id}"), json!({"status":"completed"}));
    assert_eq!(closed["body"]["status"], "completed");
    let refused = w.call(a, "POST", &format!("/goals/{id}/evidence"),
        json!({"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":"Late"}));
    assert_eq!(refused["status"], 409, "{refused}");
    println!("PASS closed goal: evidence on a completed goal is refused");

    // The marker reaches no job payload, no other person's answer and no error body.
    let jobs: i64 = w.f.rt.block_on(w.f.root.query_one(
        "SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1", &[&format!("%{MARK}%")],
    )).unwrap().get(0);
    assert_eq!(jobs, 0);
    assert!(!w.call(b, "GET", "/goals", json!(null)).to_string().contains(MARK));
    println!("PASS privacy: the marker is in no job payload and no second-person answer");
    let _ = Host::new(Limits::default()).unwrap();
    let _ = AccessContext::new(a, "goals-proof");
}

#[test]
#[ignore = "Only through verify-gate"]
fn rust_answers_match_the_old_routes_step_for_step() {
    let w = World::new();
    let old_actor = w.add_user();
    let new_actor = w.add_user();
    let missing = "99999999-9999-4999-8999-999999999999";
    // Steps that need no id from a create.
    let steps: Vec<Value> = vec![
        json!({"method":"GET","url":"/api/goals"}),
        json!({"method":"POST","url":"/api/goals","body":{"title":"Parity goal","desiredOutcome":"Same answer","priority":4,"reviewCadence":"daily","targetAt":"2030-01-01T00:00:00.000Z"}}),
        json!({"method":"POST","url":"/api/goals","body":{"desiredOutcome":"x"}}),
        json!({"method":"POST","url":"/api/goals","body":{"title":"","desiredOutcome":"x"}}),
        json!({"method":"POST","url":"/api/goals","body":{"title":"t","desiredOutcome":"x","priority":9}}),
        json!({"method":"POST","url":"/api/goals","body":{"title":"t","desiredOutcome":"x","reviewCadence":"yearly"}}),
        json!({"method":"GET","url":"/api/goals"}),
        json!({"method":"GET","url":format!("/api/goals/{missing}")}),
    ];
    let old = replay::old_routes(old_actor, &steps, &json!({}));
    let mut new = vec![];
    for step in &steps {
        let method = step["method"].as_str().unwrap();
        let url = step["url"].as_str().unwrap().replace("/api/goals", "/goals");
        let body = if step.get("body").is_some() { step["body"].clone() } else { json!(null) };
        let answer = w.call(new_actor, method, &url, body);
        new.push(json!({"status":answer["status"],"body":answer["body"]}));
    }
    let (mut old, mut new) = (old, new);
    old.iter_mut().for_each(replay::mask);
    new.iter_mut().for_each(replay::mask);
    assert_eq!(new, old);
    println!("PASS parity: {} steps match the old routes", steps.len());

    // Steps that use the created goal's id, run on each side with its own id.
    let created_old = replay::old_routes(old_actor, &[json!({"method":"POST","url":"/api/goals","body":{"title":"Id goal","desiredOutcome":"x"}})], &json!({}));
    let old_id = created_old[0]["body"]["id"].as_str().unwrap().to_owned();
    let created_new = w.call(new_actor, "POST", "/goals", json!({"title":"Id goal","desiredOutcome":"x"}));
    let new_id = created_new["body"]["id"].as_str().unwrap().to_owned();
    let id_steps: Vec<Value> = vec![
        json!({"method":"GET","url":"/api/goals/{id}"}),
        json!({"method":"PATCH","url":"/api/goals/{id}","body":{"title":"Renamed","blockerSummary":"Blocked"}}),
        json!({"method":"PATCH","url":"/api/goals/{id}","body":{"targetAt":null,"blockerSummary":null}}),
        json!({"method":"POST","url":"/api/goals/{id}/evidence","body":{"evidenceKind":"progress","sourceKind":"manual","sourceLabel":"Note","summary":"Moved"}}),
        json!({"method":"POST","url":"/api/goals/{id}/evidence","body":{"evidenceKind":"nope","sourceKind":"manual","sourceLabel":"Note","summary":"Moved"}}),
        json!({"method":"GET","url":"/api/goals/{id}"}),
    ];
    let mut old = replay::old_routes(old_actor, &id_steps, &json!({"id":old_id}));
    let mut new = vec![];
    for step in &id_steps {
        let method = step["method"].as_str().unwrap();
        let url = step["url"].as_str().unwrap().replace("/api/goals", "/goals").replace("{id}", &new_id);
        let answer = w.call(new_actor, method, &url, step["body"].clone());
        new.push(json!({"status":answer["status"],"body":answer["body"]}));
    }
    old.iter_mut().for_each(replay::mask);
    new.iter_mut().for_each(replay::mask);
    assert_eq!(new, old);
    println!("PASS parity: {} id steps match the old routes", id_steps.len());
}
