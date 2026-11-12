//! Database proofs for the owner-started re-embed. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_memory_host::ports::{Embedder, MemoryPorts};
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const DIMENSIONS: usize = 768;
const SECRET: &str = "secret passage about the blue door";

fn axis(at: usize) -> Vec<f64> {
    (0..DIMENSIONS).map(|i| if i == at { 1.0 } else { 0.0 }).collect()
}
fn text(at: usize) -> String {
    format!("[{}]", axis(at).iter().map(f64::to_string).collect::<Vec<_>>().join(","))
}

/// A search model the test can switch. The new model puts every text on the second axis.
struct Switch {
    model: Mutex<String>,
    fail: Mutex<bool>,
}
impl Switch {
    fn at(&self) -> usize {
        usize::from(self.model.lock().unwrap().as_str() == "new-model")
    }
}
impl Embedder for Switch {
    fn query(&self, _: &CallScope, _: &str) -> anyhow::Result<Vec<f64>> {
        Ok(axis(self.at()))
    }
    fn document(&self, _: &CallScope, _: &str) -> anyhow::Result<(Vec<f64>, (String, String))> {
        anyhow::ensure!(!*self.fail.lock().unwrap(), "embedding service is down");
        Ok((axis(self.at()), (self.model.lock().unwrap().clone(), "1".into())))
    }
    fn model(&self, _: &CallScope) -> anyhow::Result<(String, String)> {
        Ok((self.model.lock().unwrap().clone(), "1".into()))
    }
}

/// Stands in for the queue. It records every request and never runs a job.
#[derive(Default)]
struct Queue(Mutex<Vec<(String, Value)>>);
impl Ports for Queue {
    fn invoke(&self, _: &CallScope, port: &str, r: &Request) -> anyhow::Result<Value> {
        self.0.lock().unwrap().push((format!("{port}:{}:{}", r.operation, r.resource), r.parameters.clone()));
        Ok(json!({"id": Uuid::new_v4(), "deferred": true}))
    }
}

/// Creates the module role, the run tables and their host-made policies, once per database,
/// the way an install does. The throwaway database holds only the core migrations.
async fn provision(root: &mut Client) {
    let manifest = moss_memory_host::package::manifest().unwrap();
    let role = moss_module_host::database::runtime_role(&manifest.id);
    let tx = root.transaction().await.unwrap();
    tx.batch_execute("SELECT pg_advisory_xact_lock(246246)").await.unwrap();
    let made: bool = tx
        .query_one("SELECT to_regclass('app.memory_reembed_runs') IS NOT NULL", &[])
        .await
        .unwrap()
        .get(0);
    if !made {
        tx.batch_execute(&format!(
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{role}') THEN
               CREATE ROLE {role} NOLOGIN; END IF; END $$;
             GRANT {role} TO jarvis_app_runtime WITH INHERIT FALSE, SET TRUE;
             GRANT USAGE ON SCHEMA app TO {role};
             GRANT EXECUTE ON FUNCTION app.current_actor_user_id() TO {role}"
        ))
        .await
        .unwrap();
        for file in [
            "0364_memory_reembed_runs.sql",
            "0365_memory_reembed_one_running.sql",
            "0366_memory_reembed_staged.sql",
        ] {
            let path = format!("{}/../sql/{file}", env!("CARGO_MANIFEST_DIR"));
            tx.batch_execute(&std::fs::read_to_string(path).unwrap()).await.unwrap();
        }
        for table in ["app.memory_reembed_runs", "app.memory_reembed_staged"] {
            moss_module_host::rls::emit(&tx, &manifest, table).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    db: Database,
    switch: Arc<Switch>,
    queue: Arc<Queue>,
    wasm: Vec<u8>,
    a: Uuid,
    b: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db) = rt.block_on(async {
            let (mut root, c) =
                tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            provision(&mut root).await;
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Re A',false),($2,$4,'Re B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App).await.unwrap();
            (root, db)
        });
        let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").unwrap()).unwrap();
        Self {
            rt,
            root,
            db,
            switch: Arc::new(Switch { model: Mutex::new("old-model".into()), fail: Mutex::new(false) }),
            queue: Arc::new(Queue::default()),
            wasm: moss_memory_host::package::component(&core).unwrap(),
            a,
            b,
        }
    }

    fn model(&self, name: &str) {
        *self.switch.model.lock().unwrap() = name.into();
    }

    fn guest(&self, actor: Uuid, kind: &str, payload: Value) -> Value {
        let ports: Arc<dyn Ports> =
            Arc::new(MemoryPorts::new(self.db.clone(), self.switch.clone(), self.queue.clone()).unwrap());
        let out = Host::new(Limits::default())
            .unwrap()
            .call(
                &self.wasm,
                Arc::new(moss_memory_host::package::manifest().unwrap()),
                AccessContext::new(actor, "reembed-proof"),
                ports,
                kind,
                &payload.to_string(),
            )
            .unwrap();
        serde_json::from_str(&out).unwrap()
    }

    fn route(&self, actor: Uuid, method: &str, path: &str) -> Value {
        self.guest(actor, "route", json!({"method":method,"path":path,"params":{},"query":{},"body":null}))
    }

    fn step(&self, actor: Uuid, run: &str) -> Value {
        let out = self.guest(actor, "job", json!({"queue":"memory.reembed-step","parameters":{"run-id":run}}));
        serde_json::from_str(out.as_str().expect("a step returns its counts as text")).unwrap()
    }

    fn start(&self, actor: Uuid) -> String {
        let out = self.route(actor, "POST", "/reembed/start");
        assert_eq!(out["status"], 200, "{out}");
        out["body"]["id"].as_str().unwrap().to_owned()
    }

    fn status(&self, actor: Uuid) -> Value {
        self.route(actor, "GET", "/reembed")["body"].clone()
    }

    fn sql(&self, statement: &str) {
        self.rt.block_on(self.root.batch_execute(statement)).unwrap();
    }

    fn one(&self, statement: &str) -> String {
        self.rt.block_on(self.root.query_one(statement, &[])).unwrap().get(0)
    }

    /// Plants `n` passages on the old model, each on the first axis.
    fn chunks(&self, owner: Uuid, n: usize) {
        for i in 0..n {
            self.sql(&format!(
                "INSERT INTO app.memory_chunks(owner_user_id, source_kind, source_path, line_start, line_end,
                                               content_hash, text, embedding, embed_model_name, embed_model_version)
                 VALUES ('{owner}', 'vault', 'n/{i}.md', 0, 1, 'h{i}', '{SECRET} {i}', '{}', 'old-model', '1')",
                text(0)
            ));
        }
    }

    fn old_model_rows(&self, owner: Uuid) -> String {
        self.one(&format!(
            "SELECT count(*)::text FROM app.memory_chunks
             WHERE owner_user_id='{owner}' AND embed_model_name='old-model' AND embedding::text='{}'",
            text(0)
        ))
    }

    fn staged(&self) -> String {
        self.one("SELECT count(*)::text FROM app.memory_reembed_staged")
    }

    /// Rows `app` can see for `actor`, through the runtime role and its row security.
    fn visible(&self, actor: Uuid, table: &str) -> i64 {
        self.rt.block_on(async {
            let cx = DataContext::open(&self.db, &AccessContext::new(actor, "reembed-proof")).await.unwrap();
            let role = moss_module_host::database::runtime_role(moss_memory_host::MODULE_ID);
            cx.db().batch_execute(&format!("SET LOCAL ROLE {role}")).await.unwrap();
            let n: i64 = cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0);
            n
        })
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn an_interrupted_run_keeps_the_old_vectors_usable_and_a_restart_finishes_it() {
    let f = Fixture::new();
    f.chunks(f.a, 20);
    f.model("new-model");
    assert_eq!(f.status(f.a)["otherModel"], 20);
    let run = f.start(f.a);
    let first = f.step(f.a, &run);
    assert_eq!(first["status"], "running");
    assert_eq!(first["staged"], 16);
    // Staged vectors exist, but nothing real has moved yet.
    assert_eq!(f.staged(), "16");
    assert_eq!(f.old_model_rows(f.a), "20");
    // The server "restarts" here. Each call builds fresh ports, so the next step resumes.
    let second = f.step(f.a, &run);
    assert_eq!(second["status"], "done");
    assert_eq!(f.staged(), "0");
    assert_eq!(f.old_model_rows(f.a), "0");
    assert_eq!(f.status(f.a)["otherModel"], 0);
    assert_eq!(f.status(f.a)["run"]["status"], "done");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_completed_run_swaps_every_passage_in_one_step_and_not_before() {
    let f = Fixture::new();
    f.chunks(f.a, 3);
    f.model("new-model");
    let run = f.start(f.a);
    assert_eq!(f.old_model_rows(f.a), "3");
    let done = f.step(f.a, &run);
    assert_eq!(done["status"], "done");
    let moved = f.one(&format!(
        "SELECT count(*)::text FROM app.memory_chunks WHERE owner_user_id='{}' AND embed_model_name='new-model'
         AND embedding::text='{}'",
        f.a,
        text(1)
    ));
    assert_eq!(moved, "3");
}

#[test]
#[ignore = "Only through verify-gate"]
fn cancel_stops_the_run_and_drops_what_it_staged() {
    let f = Fixture::new();
    f.chunks(f.a, 20);
    f.model("new-model");
    let run = f.start(f.a);
    f.step(f.a, &run);
    assert_eq!(f.staged(), "16");
    let out = f.route(f.a, "POST", "/reembed/cancel");
    assert_eq!(out["body"]["cancelled"], true);
    assert_eq!(f.staged(), "0");
    assert_eq!(f.old_model_rows(f.a), "20");
    assert_eq!(f.status(f.a)["run"]["status"], "cancelled");
    // A step that arrives after the cancel does nothing.
    assert_eq!(f.step(f.a, &run)["status"], "stopped");
    assert_eq!(f.staged(), "0");
    assert_eq!(f.old_model_rows(f.a), "20");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_failed_embedding_ends_the_run_and_leaves_the_old_vectors() {
    let f = Fixture::new();
    f.chunks(f.a, 4);
    f.model("new-model");
    let run = f.start(f.a);
    *f.switch.fail.lock().unwrap() = true;
    assert_eq!(f.step(f.a, &run)["status"], "failed");
    assert_eq!(f.status(f.a)["run"]["status"], "failed");
    assert_eq!(f.staged(), "0");
    assert_eq!(f.old_model_rows(f.a), "4");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_passage_edited_after_staging_keeps_its_old_vector() {
    let f = Fixture::new();
    f.chunks(f.a, 20);
    f.model("new-model");
    let run = f.start(f.a);
    f.step(f.a, &run);
    let id = f.one(&format!(
        "SELECT target_id::text FROM app.memory_reembed_staged WHERE run_id='{run}' LIMIT 1"
    ));
    f.sql(&format!("UPDATE app.memory_chunks SET text = 'edited later' WHERE id = '{id}'"));
    assert_eq!(f.step(f.a, &run)["status"], "done");
    let kept = f.one(&format!(
        "SELECT embed_model_name FROM app.memory_chunks WHERE id='{id}'"
    ));
    assert_eq!(kept, "old-model", "the swap must not apply a vector made from older text");
}

#[test]
#[ignore = "Only through verify-gate"]
fn search_never_compares_two_models() {
    let f = Fixture::new();
    // One fact on each model, both stored on the second axis, which the new query also uses.
    for (i, model) in [(0, "old-model"), (1, "new-model")] {
        f.sql(&format!(
            "INSERT INTO app.memory_entities(owner_user_id, kind, name, summary) VALUES ('{}', 'self', 'Me{i}', '')
             ON CONFLICT DO NOTHING",
            f.a
        ));
        f.sql(&format!(
            "INSERT INTO app.memory_facts(owner_user_id, subject_entity_id, predicate, object_text, record_kind,
                                          confidence, importance, provenance, pinned)
             VALUES ('{a}', (SELECT id FROM app.memory_entities WHERE owner_user_id='{a}' AND kind='self'),
                     'prefers', 'tea {i}', 'preference', 0.9, 0.5, 'volunteered', false)",
            a = f.a
        ));
        f.sql(&format!(
            "INSERT INTO app.memory_search_documents(owner_user_id, target_kind, target_id, search_text, embedding,
                                                     embed_model_name, embed_model_version)
             SELECT '{a}', 'fact', id, 'tea {i}', '{v}', '{model}', '1' FROM app.memory_facts
             WHERE owner_user_id='{a}' AND object_text='tea {i}'",
            a = f.a,
            v = text(1)
        ));
    }
    f.model("new-model");
    let out = f.guest(
        f.a,
        "route",
        json!({"method":"GET","path":"/graph/recall","params":{},"query":{"query":"tea"},"body":null}),
    );
    let found = out["body"]["candidates"].as_array().cloned().unwrap_or_default();
    let similarity = |name: &str| {
        found.iter().find(|c| c["fact"]["objectText"] == name).map(|c| c["similarity"].as_f64().unwrap_or(-1.0))
    };
    assert_eq!(similarity("tea 1"), Some(1.0), "same model compares");
    assert_eq!(similarity("tea 0"), Some(0.0), "another model never compares");
}

#[test]
#[ignore = "Only through verify-gate"]
fn facts_saved_without_a_vector_are_retried_on_the_tick() {
    let f = Fixture::new();
    f.sql(&format!(
        "INSERT INTO app.memory_search_documents(owner_user_id, target_kind, target_id, search_text)
         VALUES ('{}', 'fact', gen_random_uuid(), 'no vector yet')",
        f.a
    ));
    f.model("new-model");
    assert_eq!(f.status(f.a)["missing"], 1);
    f.guest(f.a, "job", json!({"queue":"memory.vault-ingest-tick","parameters":{}}));
    assert_eq!(f.status(f.a)["missing"], 0);
    assert_eq!(f.one("SELECT embed_model_name FROM app.memory_search_documents WHERE search_text='no vector yet'"), "new-model");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_start_is_refused_and_so_is_a_start_with_nothing_to_do() {
    let f = Fixture::new();
    f.chunks(f.a, 2);
    assert_eq!(f.route(f.a, "POST", "/reembed/start")["status"], 409, "same model, nothing to do");
    f.model("new-model");
    f.start(f.a);
    assert_eq!(f.route(f.a, "POST", "/reembed/start")["status"], 409, "already running");
}

#[test]
#[ignore = "Only through verify-gate"]
fn jobs_carry_only_the_run_id_and_no_passage_text_is_stored_in_the_run() {
    let f = Fixture::new();
    f.chunks(f.a, 20);
    f.model("new-model");
    let run = f.start(f.a);
    f.step(f.a, &run);
    let sent = f.queue.0.lock().unwrap().clone();
    let steps: Vec<_> = sent.iter().filter(|(k, _)| k.contains("memory.reembed-step")).collect();
    assert!(steps.len() >= 2, "start and a running step each queue the next step");
    for (_, params) in &steps {
        assert_eq!(params["params"], json!({"run-id": run}));
    }
    let everything = serde_json::to_string(&sent).unwrap();
    assert!(!everything.contains(SECRET));
    let runs = f.one("SELECT row_to_json(r)::text FROM app.memory_reembed_runs r LIMIT 1");
    assert!(!runs.contains(SECRET));
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_sees_and_touches_nothing_of_the_first_persons_run() {
    let f = Fixture::new();
    f.chunks(f.a, 20);
    f.model("new-model");
    let run = f.start(f.a);
    f.step(f.a, &run);

    let seen = f.status(f.b);
    assert_eq!(seen["otherModel"], 0);
    assert!(seen["run"].is_null());
    assert_eq!(f.step(f.b, &run)["status"], "stopped");
    assert_eq!(f.route(f.b, "POST", "/reembed/cancel")["body"]["cancelled"], false);
    assert_eq!(f.status(f.a)["run"]["status"], "running", "B must not cancel A's run");
    assert_eq!(f.visible(f.b, "app.memory_reembed_runs"), 0);
    assert_eq!(f.visible(f.b, "app.memory_reembed_staged"), 0);
    assert_eq!(f.visible(f.a, "app.memory_reembed_staged"), 16);

    // With row security removed, B does see A's staged rows, so the protection is what hides them.
    for table in ["app.memory_reembed_runs", "app.memory_reembed_staged"] {
        f.sql(&format!("ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY; ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"));
    }
    let leaked = (f.visible(f.b, "app.memory_reembed_runs"), f.visible(f.b, "app.memory_reembed_staged"));
    for table in ["app.memory_reembed_runs", "app.memory_reembed_staged"] {
        f.sql(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"));
    }
    assert!(leaked.0 > 0 && leaked.1 > 0, "without row security B would see {leaked:?}");
    assert_eq!(f.visible(f.b, "app.memory_reembed_staged"), 0);
}
