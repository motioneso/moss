//! Database proofs for the Memory adapter. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_memory_host::ports::{Embedder, MemoryPorts};
use moss_memory_host::store;
use moss_module_host::runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request};
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use std::process::Command;
use std::sync::Arc;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const DIMENSIONS: usize = 768;

fn unit() -> Vec<f64> {
    (0..DIMENSIONS).map(|i| if i == 0 { 1.0 } else { 0.0 }).collect()
}
fn literal() -> String {
    format!("[{}]", unit().iter().map(f64::to_string).collect::<Vec<_>>().join(","))
}

/// Gives every text the same vector, or fails document embedding when told to.
struct Same {
    fail_documents: bool,
}
impl Embedder for Same {
    fn query(&self, _: &CallScope, _: &str) -> anyhow::Result<Vec<f64>> {
        Ok(unit())
    }
    fn document(&self, _: &CallScope, _: &str) -> anyhow::Result<(Vec<f64>, (String, String))> {
        anyhow::ensure!(!self.fail_documents, "embedding service is down");
        Ok((unit(), ("stand-in".into(), "1".into())))
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    db: Database,
    a: Uuid,
    b: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db) = rt.block_on(async {
            let (root, c) =
                tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Mem A',false),($2,$4,'Mem B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            (root, db)
        });
        Self { rt, root, db, a, b }
    }

    /// One committed store call as `actor`.
    fn store(&self, actor: Uuid, op: &str, resource: &str, parameters: Value) -> Value {
        self.rt.block_on(async {
            let cx = DataContext::open(&self.db, &AccessContext::new(actor, "memory-proof"))
                .await
                .unwrap();
            let request = Request { operation: op.into(), resource: resource.into(), parameters };
            let vector = literal();
            let out = store::run(&cx, &request, Some(&vector)).await.unwrap();
            cx.commit().await.unwrap();
            out
        })
    }

    fn recalled(&self, actor: Uuid) -> Vec<Value> {
        self.store(actor, "get", "memory.recall", json!({"query": "anything"}))["candidates"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn sql(&self, statement: &str) {
        self.rt.block_on(self.root.batch_execute(statement)).unwrap();
    }

    fn count(&self, statement: &str, owner: Uuid) -> i64 {
        self.rt.block_on(self.root.query_one(statement, &[&owner])).unwrap().get(0)
    }

    fn remember(&self, actor: Uuid, text: &str) -> Value {
        self.store(
            actor,
            "set",
            "memory.fact",
            json!({"predicate":"prefers","objectText":text,"recordKind":"preference","confidence":0.9,
                   "provenance":"volunteered","importance":0.5,"pinned":false,
                   "source":{"sourceKind":"chat","sourceRef":"t","sourceLabel":"","excerpt":"said so"}}),
        )["fact"]
            .clone()
    }

    /// The real guest and ports, signed in as `actor`.
    fn guest(&self, actor: Uuid, fail_documents: bool, kind: &str, payload: Value) -> Result<Value, String> {
        let ports: Arc<dyn Ports> = Arc::new(
            MemoryPorts::new(self.db.clone(), Arc::new(Same { fail_documents }), Arc::new(DenyPorts)).unwrap(),
        );
        let core = std::fs::read(std::env::var("MEMORY_CORE_WASM").unwrap()).unwrap();
        let wasm = moss_memory_host::package::component(&core).unwrap();
        let manifest = moss_memory_host::package::manifest().unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(&wasm, Arc::new(manifest), AccessContext::new(actor, "memory-proof"), ports, kind, &payload.to_string())
            .map_err(|e| e.to_string())?;
        Ok(serde_json::from_str(&out).unwrap())
    }
}

/// Runs the old TypeScript repository against the same database.
fn old_code(args: &[String]) -> Value {
    let out = Command::new("pnpm")
        .args(["exec", "tsx", "modules/memory/tools/roundtrip.ts"])
        .args(args)
        .current_dir("../../..")
        .env("JARVIS_GATE_RUN", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "old code failed: {}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    serde_json::from_str(text.lines().last().unwrap()).unwrap()
}

#[test]
#[ignore = "Only through verify-gate"]
fn rows_written_by_the_old_code_read_in_rust_and_the_reverse() {
    let f = Fixture::new();
    let wrote = old_code(&["write".into(), f.a.to_string()]);
    let ts_fact = wrote["factId"].as_str().unwrap();

    let found = f.recalled(f.a);
    let hit = found.iter().find(|c| c["fact"]["id"] == ts_fact).expect("Rust did not see the old row");
    assert_eq!(hit["fact"]["objectText"], "written by the old code");
    assert_eq!(hit["fact"]["pinned"], true);
    assert_eq!(hit["fact"]["sources"][0]["sourceRef"], "ts-thread");
    assert_eq!(hit["similarity"].as_f64().unwrap(), 1.0);
    let core = f.store(f.a, "get", "memory.core", json!({"limit": 20}));
    assert!(core["facts"].as_array().unwrap().iter().any(|x| x["id"] == ts_fact));

    let rust_fact = f.remember(f.a, "written by rust");
    let id = rust_fact["id"].as_str().unwrap().to_owned();
    let text = f.rt.block_on(async {
        let cx = DataContext::open(&f.db, &AccessContext::new(f.a, "memory-proof")).await.unwrap();
        let text = store::pending_text(&cx, &id).await.unwrap().unwrap();
        let done = store::store_vector(&cx, &id, &text, &literal(), &("stand-in".into(), "1".into()))
            .await
            .unwrap();
        cx.commit().await.unwrap();
        assert!(done);
        text
    });
    assert!(text.contains("written by rust"));
    let read = old_code(&["read".into(), f.a.to_string(), id]);
    assert_eq!(read["recalled"], true);
    assert_eq!(read["objectText"], "written by rust");
    assert_eq!(read["sourceCount"], 1);
    assert_eq!(read["inCore"], false);
    assert!((read["similarity"].as_f64().unwrap() - 1.0).abs() < 1e-9);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_see_or_change_the_first_persons_memory() {
    let f = Fixture::new();
    let fact = f.remember(f.a, "private to a");
    let id = fact["id"].as_str().unwrap().to_owned();
    assert!(f.recalled(f.a).iter().any(|c| c["fact"]["id"] == id.as_str()));

    assert!(f.recalled(f.b).is_empty());
    assert!(f.store(f.b, "get", "memory.core", json!({}))["facts"].as_array().unwrap().is_empty());
    let (seen, changed) = f.rt.block_on(async {
        let cx = DataContext::open(&f.db, &AccessContext::new(f.b, "memory-proof")).await.unwrap();
        let seen = store::pending_text(&cx, &id).await.unwrap();
        let changed = store::store_vector(&cx, &id, "private to a", &literal(), &("x".into(), "1".into()))
            .await
            .unwrap();
        cx.commit().await.unwrap();
        (seen, changed)
    });
    assert_eq!((seen, changed), (None, false));
    // Naming A's subject entity as B's fact subject must not attach B's fact to A's data.
    let bs = f.remember(f.b, "private to b");
    assert_eq!(f.recalled(f.b).len(), 1);
    assert_eq!(bs["ownerUserId"], f.b.to_string());
    assert_eq!(f.count("SELECT count(*) FROM app.memory_facts WHERE owner_user_id = $1", f.a), 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_second_person_check_has_teeth() {
    let f = Fixture::new();
    f.remember(f.a, "private to a");
    let tables = ["memory_facts", "memory_fact_sources", "memory_entities", "memory_search_documents"];
    for t in tables {
        f.sql(&format!("ALTER TABLE app.{t} DISABLE ROW LEVEL SECURITY"));
    }
    let leaked = f.recalled(f.b);
    for t in tables {
        f.sql(&format!("ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{t} FORCE ROW LEVEL SECURITY"));
    }
    assert!(!leaked.is_empty(), "A's fact was not exposed without row security, so the check proves nothing");
    assert!(f.recalled(f.b).is_empty());
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_failed_embedding_never_loses_the_fact() {
    let f = Fixture::new();
    let fact = json!({"predicate":"prefers","objectText":"kept when search is down",
        "source":{"sourceKind":"chat","sourceRef":"t","excerpt":"said so"}});
    let out = f
        .guest(f.a, true, "route", json!({"method":"POST","path":"/graph/facts","params":{},"query":{},"body":fact}))
        .unwrap();
    assert_eq!(out["status"], 200);
    assert_eq!(out["body"]["searchPending"], true);
    let id = out["body"]["fact"]["id"].as_str().unwrap();
    assert_eq!(f.count("SELECT count(*) FROM app.memory_facts WHERE owner_user_id = $1", f.a), 1);
    assert_eq!(
        f.count("SELECT count(*) FROM app.memory_search_documents WHERE owner_user_id = $1 AND embedding IS NULL AND target_kind = 'fact'", f.a),
        1
    );
    // The fact is still found by its words while its vector is missing.
    let recall = f
        .guest(f.a, true, "tool", json!({"tool":"memory.recall","parameters":{"query":"kept when search is down"}}))
        .unwrap();
    assert_eq!(recall["data"]["items"][0]["id"], id);
    let said = f
        .guest(f.a, true, "tool", json!({"tool":"memory.remember","parameters":{"predicate":"prefers","objectText":"again","source":{"sourceKind":"chat","sourceRef":"t","excerpt":"x"}}}))
        .unwrap();
    assert_eq!(said["data"]["searchPending"], true);
}

#[test]
#[ignore = "Only through verify-gate"]
fn remember_then_recall_through_the_real_guest() {
    let f = Fixture::new();
    let said = f
        .guest(f.a, false, "tool", json!({"tool":"memory.remember","parameters":{"predicate":"has_goal","objectText":"learn the cello","source":{"sourceKind":"chat","sourceRef":"t","excerpt":"I want to learn the cello"}}}))
        .unwrap();
    let id = said["data"]["factId"].as_str().unwrap();
    assert!(said["data"].get("searchPending").is_none());
    assert_eq!(f.count("SELECT count(*) FROM app.memory_search_documents WHERE owner_user_id = $1 AND embedding IS NOT NULL AND target_kind = 'fact'", f.a), 1);
    let recall = f
        .guest(f.a, false, "tool", json!({"tool":"memory.recall","parameters":{"query":"cello"}}))
        .unwrap();
    assert_eq!(recall["data"]["items"][0]["id"], id);
    assert_eq!(recall["data"]["items"][0]["recordKind"], "goal");
    let other = f
        .guest(f.b, false, "tool", json!({"tool":"memory.recall","parameters":{"query":"cello"}}))
        .unwrap();
    assert_eq!(other["data"]["items"], json!([]));
    let core = f
        .guest(f.a, false, "route", json!({"method":"GET","path":"/graph/core","params":{},"query":{},"body":null}))
        .unwrap();
    assert_eq!(core["status"], 200);
}
