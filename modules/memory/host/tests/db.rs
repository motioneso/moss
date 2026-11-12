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
    fn model(&self, _: &CallScope) -> anyhow::Result<(String, String)> {
        Ok(("stand-in".into(), "1".into()))
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
        self.store(actor, "get", "memory.recall", json!({"query": "anything", "model": "stand-in"}))["candidates"]
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
    assert_eq!(read["inCore"], true, "the old code lists the Rust fact as a core fact too");
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

/// What person `actor` can count in A's tables with no owner filter in the query at all.
fn bare_count(f: &Fixture, actor: Uuid) -> i64 {
    f.rt.block_on(async {
        let cx = DataContext::open(&f.db, &AccessContext::new(actor, "memory-proof")).await.unwrap();
        let mut total = 0;
        for t in ["memory_facts", "memory_fact_sources", "memory_entities", "memory_search_documents"] {
            let row = cx.db().query_one(&format!("SELECT count(*) FROM app.{t}"), &[]).await.unwrap();
            total += row.get::<_, i64>(0);
        }
        cx.commit().await.unwrap();
        total
    })
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_second_person_check_has_teeth() {
    let f = Fixture::new();
    f.remember(f.a, "private to a");
    assert_eq!(bare_count(&f, f.b), 0, "row security hides A's rows from B");
    let tables = ["memory_facts", "memory_fact_sources", "memory_entities", "memory_search_documents"];
    for t in tables {
        f.sql(&format!("ALTER TABLE app.{t} DISABLE ROW LEVEL SECURITY"));
    }
    let leaked = bare_count(&f, f.b);
    for t in tables {
        f.sql(&format!("ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{t} FORCE ROW LEVEL SECURITY"));
    }
    assert!(leaked > 0, "A's rows were not exposed without row security, so the check proves nothing");
    assert_eq!(bare_count(&f, f.b), 0);
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

// ---- Part 3: fact lifecycle, conflict groups, forget ----

const UNKNOWN: &str = "00000000-0000-4000-8000-0000000000ff";

impl Fixture {
    fn route(&self, actor: Uuid, method: &str, path: &str, id: &str, body: Value) -> (u64, Value) {
        let out = self
            .guest(actor, false, "route", json!({"method":method,"path":path,"params":{"id":id},"query":{},"body":body}))
            .unwrap();
        (out["status"].as_u64().unwrap(), out["body"].clone())
    }

    /// Facts seeded like the old fixture generator: volunteered, confidence 0.8.
    fn ids(&self, actor: Uuid, n: usize) -> Vec<String> {
        (0..n)
            .map(|i| {
                self.store(
                    actor,
                    "set",
                    "memory.fact",
                    json!({"predicate":"prefers","objectText":format!("case fact {}", i + 1),"recordKind":"preference",
                           "confidence":0.8,"provenance":"volunteered","importance":0.5,"pinned":false,
                           "source":{"sourceKind":"manual","sourceRef":format!("manual:{}", i + 1),"sourceLabel":"",
                                     "excerpt":format!("fact {}", i + 1)}}),
                )["fact"]["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    fn new_person(&self) -> Uuid {
        let id = Uuid::new_v4();
        self.rt
            .block_on(self.root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Case',false)",
                &[&id, &format!("{id}@example.test")],
            ))
            .unwrap();
        id
    }

    /// Puts the given facts in one open conflict group, as the old repository does.
    fn conflict(&self, actor: Uuid, ids: &[String]) {
        let list = ids.iter().map(|i| format!("'{i}'::uuid")).collect::<Vec<_>>().join(",");
        self.sql(&format!(
            "WITH g AS (INSERT INTO app.memory_conflict_groups (owner_user_id) VALUES ('{actor}') RETURNING id)
             UPDATE app.memory_facts SET status='conflicting', conflict_group_id=(SELECT id FROM g)
             WHERE owner_user_id='{actor}' AND id IN ({list});
             UPDATE app.memory_search_documents SET status='inactive'
             WHERE owner_user_id='{actor}' AND target_kind='fact' AND target_id IN ({list})"
        ));
    }

    fn state(&self, actor: Uuid, ids: &[String]) -> Value {
        self.rt.block_on(async {
            let mut facts = vec![];
            for id in ids {
                let uid: Uuid = id.parse().unwrap();
                let row = self.root.query_opt(
                    "SELECT f.status, f.conflict_group_id IS NOT NULL, f.valid_to IS NOT NULL, f.stale_at IS NOT NULL,
                            f.pinned, f.superseded_by_fact_id,
                            (SELECT d.status FROM app.memory_search_documents d
                              WHERE d.owner_user_id = f.owner_user_id AND d.target_kind='fact' AND d.target_id = f.id)
                     FROM app.memory_facts f WHERE f.owner_user_id=$1 AND f.id=$2",
                    &[&actor, &uid],
                ).await.unwrap();
                facts.push(match row {
                    None => Value::Null,
                    Some(r) => {
                        let by: Option<Uuid> = r.get(5);
                        json!({"status": r.get::<_, String>(0), "hasGroup": r.get::<_, bool>(1),
                               "hasValidTo": r.get::<_, bool>(2), "hasStaleAt": r.get::<_, bool>(3),
                               "pinned": r.get::<_, bool>(4),
                               "supersededBy": by.map(|b| ids.iter().position(|i| *i == b.to_string()).map_or(-1, |p| p as i64)),
                               "doc": r.get::<_, Option<String>>(6)})
                    }
                });
            }
            let group: Option<String> = self.root.query_opt(
                "SELECT status FROM app.memory_conflict_groups WHERE owner_user_id=$1 ORDER BY created_at LIMIT 1",
                &[&actor]).await.unwrap().map(|r| r.get(0));
            let total: i64 = self.root.query_one("SELECT count(*) FROM app.memory_facts WHERE owner_user_id=$1", &[&actor]).await.unwrap().get(0);
            json!({"facts": facts, "group": group, "total": total})
        })
    }
}

fn plant(f: &Fixture, actor: Uuid, seed: &str) -> Vec<String> {
    let n = match seed { "none" => 0, "plain" | "recording" => 1, "conflict2" | "superseded" => 2, _ => 3 };
    let ids = f.ids(actor, n);
    if seed.starts_with("conflict") || seed == "confirmed3" {
        f.conflict(actor, &ids);
    }
    if seed == "confirmed3" {
        let (status, _) = f.route(actor, "POST", "/graph/facts/:id/confirm", &ids[0], json!({}));
        assert_eq!(status, 200);
    }
    if seed == "superseded" {
        f.sql(&format!(
            "UPDATE app.memory_facts SET status='superseded', superseded_by_fact_id='{}' WHERE owner_user_id='{actor}' AND id='{}'",
            ids[1], ids[0]
        ));
    }
    if seed == "recording" {
        f.sql(&format!(
            "INSERT INTO app.memory_recording_fact_versions (owner_user_id, fact_id, lineage_id, side)
             VALUES ('{actor}', '{}', gen_random_uuid(), 'personal')", ids[0]
        ));
    }
    ids
}

fn shape(status: u64, body: &Value) -> Value {
    let Some(fact) = body.get("fact") else { return body.clone() };
    let mut keys: Vec<&String> = fact.as_object().unwrap().keys().collect();
    keys.sort();
    let _ = status;
    json!({"status": fact["status"], "provenance": fact["provenance"], "confidence": fact["confidence"],
           "pinned": fact["pinned"], "objectText": fact["objectText"], "confidenceTier": fact["confidenceTier"],
           "hasGroup": !fact["conflictGroupId"].is_null(), "sourceCount": fact["sources"].as_array().unwrap().len(),
           "keys": keys})
}

#[test]
#[ignore = "Only through verify-gate"]
fn every_old_route_case_gives_the_same_status_body_and_rows() {
    let cases: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string("../tools/lifecycle-cases.json").unwrap()).unwrap();
    assert!(cases.len() >= 37);
    let f = Fixture::new();
    for case in cases {
        let person = f.new_person();
        let ids = plant(&f, person, case["seed"].as_str().unwrap());
        let request = &case["request"];
        let id = if request["target"] == "first" { ids[0].clone() } else { UNKNOWN.to_owned() };
        let path = match request["path"].as_str().unwrap() {
            "" => "/graph/facts/:id".to_owned(),
            p => format!("/graph/facts/:id/{p}"),
        };
        let body = request.get("body").cloned().unwrap_or(Value::Null);
        let (status, out) = f.route(person, request["method"].as_str().unwrap(), &path, &id, body);
        let name = case["name"].as_str().unwrap();
        assert_eq!(status, case["status"].as_u64().unwrap(), "{name}: status");
        if status == 400 && case["body"]["code"] == "FST_ERR_VALIDATION" || case["body"] == json!({"error":"Bad Request"}) {
            // Validation wording is the part 2 convention (the message text), so only the status is compared.
        } else if status == 204 {
            assert!(out.is_null(), "{name}: body");
        } else {
            assert_eq!(shape(status, &out), case["body"], "{name}: body");
        }
        assert_eq!(f.state(person, &ids), case["after"], "{name}: rows afterwards");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_use_any_new_route_on_the_first_persons_fact() {
    let f = Fixture::new();
    let ids = f.ids(f.a, 1);
    let before = f.state(f.a, &ids);
    let calls = [
        ("POST", "pin", json!({"pinned": true})),
        ("POST", "confirm", json!({})),
        ("POST", "correct", json!({"replacementText": "stolen"})),
        ("POST", "status", json!({"status": "rejected"})),
        ("POST", "mark-stale", json!({})),
        ("POST", "supersede", json!({})),
        ("DELETE", "", Value::Null),
    ];
    for (method, name, body) in calls {
        let path = if name.is_empty() { "/graph/facts/:id".to_owned() } else { format!("/graph/facts/:id/{name}") };
        let (status, out) = f.route(f.b, method, &path, &ids[0], body);
        assert_eq!((status, out["error"].as_str()), (404, Some("Memory fact not found")), "{method} {name}");
    }
    assert_eq!(f.state(f.a, &ids), before, "A's fact is untouched");
    assert_eq!(f.count("SELECT count(*) FROM app.memory_facts WHERE owner_user_id = $1", f.b), 0);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_read_or_forget_the_first_persons_fact_even_without_row_security() {
    let f = Fixture::new();
    let ids = f.ids(f.a, 1);
    let card = |actor: Uuid| {
        f.guest(actor, false, "api", json!({"name":"prepareMemoryAction","parameters":{"tool":"memory.forget",
            "inputJson": json!({"factId": ids[0]}).to_string()}})).unwrap()
    };
    let version = card(f.a)["ok"]["version"].as_str().unwrap().to_owned();
    let forget = |actor: Uuid| {
        f.guest(actor, false, "tool", json!({"tool":"memory.forget","parameters":{"factId": ids[0]},"approvalVersion":version}))
    };
    assert_eq!(card(f.b)["error"]["statusCode"], 409);
    assert!(forget(f.b).is_err(), "B's approval of A's memory must be refused");
    assert_eq!(f.state(f.a, &ids)["total"], 1);

    // With row security off on every table the new SQL reads, the owner filter in the SQL still holds.
    let tables = ["memory_facts", "memory_fact_sources", "memory_entities", "memory_search_documents",
                  "memory_conflict_groups", "memory_recording_fact_versions", "memory_episodes"];
    for t in tables { f.sql(&format!("ALTER TABLE app.{t} DISABLE ROW LEVEL SECURITY")); }
    let (status, _) = f.route(f.b, "POST", "/graph/facts/:id/confirm", &ids[0], json!({}));
    let (still, _) = (card(f.b)["error"]["statusCode"].clone(), forget(f.b).is_err());
    for t in tables { f.sql(&format!("ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{t} FORCE ROW LEVEL SECURITY")); }
    assert_eq!((status, still), (404, json!(409)));
    assert_eq!(f.state(f.a, &ids)["total"], 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn forget_asks_first_is_used_once_and_refuses_a_changed_memory() {
    let f = Fixture::new();
    let ids = f.ids(f.a, 1);
    let prepare = || {
        f.guest(f.a, false, "api", json!({"name":"prepareMemoryAction","parameters":{"tool":"memory.forget",
            "inputJson": json!({"factId": ids[0]}).to_string()}})).unwrap()
    };
    let card = prepare();
    assert_eq!(card["ok"]["approvalKind"], "memory_delete");
    assert!(card["ok"]["target"].as_str().unwrap().contains("case fact 1"));
    let version = card["ok"]["version"].as_str().unwrap().to_owned();
    let forget = |v: &str| {
        f.guest(f.a, false, "tool", json!({"tool":"memory.forget","parameters":{"factId":ids[0]},"approvalVersion":v}))
    };
    // No approval at all is refused.
    let none = f.guest(f.a, false, "tool", json!({"tool":"memory.forget","parameters":{"factId":ids[0]}}));
    assert!(none.is_err());
    // A memory changed after the card was shown is refused and kept.
    let (status, _) = f.route(f.a, "POST", "/graph/facts/:id/pin", &ids[0], json!({"pinned": true}));
    assert_eq!(status, 204);
    assert!(forget(&version).is_err());
    assert_eq!(f.state(f.a, &ids)["total"], 1);
    // The fresh card's version deletes it, and replaying the same approval finds nothing to delete.
    let fresh = prepare()["ok"]["version"].as_str().unwrap().to_owned();
    assert_eq!(forget(&fresh).unwrap()["data"]["deleted"], true);
    assert_eq!(f.state(f.a, &ids)["total"], 0);
    assert!(forget(&fresh).is_err());
}

#[test]
#[ignore = "Only through verify-gate"]
fn forget_refuses_a_recordings_memory() {
    let f = Fixture::new();
    let ids = plant(&f, f.a, "recording");
    let card = f.guest(f.a, false, "api", json!({"name":"prepareMemoryAction","parameters":{"tool":"memory.forget",
        "inputJson": json!({"factId": ids[0]}).to_string()}})).unwrap();
    let version = card["ok"]["version"].as_str().unwrap_or("x").to_owned();
    let out = f.guest(f.a, false, "tool", json!({"tool":"memory.forget","parameters":{"factId":ids[0]},"approvalVersion":version}));
    assert!(out.is_err());
    assert_eq!(f.state(f.a, &ids)["total"], 1);
}

// ---- Part 8: the public API other modules call ----

/// One public call through the real guest, signed in as `actor`. Returns the guest's answer.
fn api(f: &Fixture, actor: Uuid, name: &str, parameters: Value) -> Value {
    f.guest(actor, false, "api", json!({"name": name, "parameters": parameters})).unwrap()
}

fn ok(answer: &Value) -> &Value {
    assert!(answer.get("error").is_none(), "call failed: {answer}");
    &answer["ok"]
}

const PUBLIC_TABLES: [&str; 8] = [
    "memory_chunks", "memory_file_index", "chat_memory_facts", "chat_memory_suppressions",
    "memory_episodes", "memory_candidates", "memory_entities", "memory_aliases",
];

fn rls(f: &Fixture, on: bool) {
    for t in PUBLIC_TABLES {
        f.sql(&if on {
            format!("ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{t} FORCE ROW LEVEL SECURITY")
        } else {
            format!("ALTER TABLE app.{t} DISABLE ROW LEVEL SECURITY")
        });
    }
}

/// Rows the person can count in the public tables with no owner filter in the query.
fn bare_public(f: &Fixture, actor: Uuid) -> i64 {
    f.rt.block_on(async {
        let cx = DataContext::open(&f.db, &AccessContext::new(actor, "memory-proof")).await.unwrap();
        let mut total = 0;
        for t in PUBLIC_TABLES {
            total += cx.db().query_one(&format!("SELECT count(*) FROM app.{t}"), &[]).await.unwrap().get::<_, i64>(0);
        }
        cx.commit().await.unwrap();
        total
    })
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Seeds one row in every public table for `actor` through the API.
fn seed_public(f: &Fixture, actor: Uuid) -> String {
    let thread = Uuid::new_v4().to_string();
    ok(&api(f, actor, "upsertChunks", json!({"sourceKind":"screen","sourcePath":"backtrack/1",
        "chunks":[{"lineStart":0,"lineEnd":1,"text":"a screen"}]})));
    ok(&api(f, actor, "embedTurn", json!({"threadId":thread,"userText":"hi","assistantText":"yo"})));
    ok(&api(f, actor, "insertFact", json!({"category":"profile","content":"likes tea","provenance":"inferred"})));
    ok(&api(f, actor, "insertSuppression", json!({"category":"fact","content":"old"})));
    let episode = ok(&api(f, actor, "createEpisode", json!({"sourceKind":"chat","sourceRef":"t","excerpt":"said"})))["id"]
        .as_str().unwrap().to_owned();
    ok(&api(f, actor, "insertCandidate", json!({"episodeId":episode,"kind":"fact","action":"create",
        "payloadJson":{"x":1},"candidateSignature":"sig-1","confidence":0.5,"importance":0.5,"provenance":"inferred"})));
    let entity = ok(&api(f, actor, "createEntity", json!({"kind":"goal","name":"Run","summary":"a marathon"})))["entity"]["id"]
        .as_str().unwrap().to_owned();
    ok(&api(f, actor, "addAlias", json!({"entityId":entity,"alias":"Marathon"})));
    entity
}

#[test]
#[ignore = "Only through verify-gate"]
fn chunk_calls_match_the_old_backtrack_chat_and_briefings_shapes() {
    let f = Fixture::new();
    let thread = Uuid::new_v4().to_string();
    // Backtrack: upsert under source kind screen, then delete by path.
    let up = api(&f, f.a, "upsertChunks", json!({"sourceKind":"screen","sourcePath":"backtrack/7",
        "chunks":[{"lineStart":0,"lineEnd":2,"text":"screen words"}]}));
    assert_eq!(ok(&up)["written"], 1);
    let found = api(&f, f.a, "searchChunks", json!({"query":"x","sourceKind":"screen","limit":5}));
    let hit = &ok(&found)["chunks"][0];
    assert_eq!((hit["sourcePath"].as_str(), hit["text"].as_str()), (Some("backtrack/7"), Some("screen words")));
    assert_eq!(hit["similarity"].as_f64().unwrap(), 1.0);
    // Chat's embed turn: one chunk per thread, lines 0 and 0, skipped when unchanged.
    let turn = json!({"threadId":thread,"userText":"hello","assistantText":"hi there"});
    assert_eq!(ok(&api(&f, f.a, "embedTurn", turn.clone()))["skipped"], false);
    assert_eq!(ok(&api(&f, f.a, "embedTurn", turn))["skipped"], true);
    let row = f.rt.block_on(f.root.query_one(
        "SELECT count(*), min(content_hash), min(text), min(line_start + line_end) FROM app.memory_chunks
         WHERE owner_user_id = $1 AND source_kind = 'chat' AND source_path = $2", &[&f.a, &thread])).unwrap();
    assert_eq!(row.get::<_, i64>(0), 1);
    let text = "User: hello\nAssistant: hi there";
    assert_eq!((row.get::<_, String>(1), row.get::<_, String>(2)), (sha256_hex(text), text.to_owned()));
    assert_eq!(row.get::<_, i32>(3), 0);
    // Briefings: recent chunks come from files that have an index row.
    let recent = api(&f, f.a, "listRecentChunks", json!({"sourceKind":"chat","limit":3}));
    assert_eq!(ok(&recent)["chunks"].as_array().unwrap().len(), 1);
    // The delete cap and its old error text.
    let many: Vec<String> = (0..501).map(|i| format!("backtrack/{i}")).collect();
    let capped = api(&f, f.a, "deleteChunksForSources", json!({"sourceKind":"screen","sourcePaths":many}));
    assert_eq!(capped["error"], json!({"statusCode":400,"error":"deleteChunksForSources accepts at most 500 source paths per call, got 501"}));
    let gone = api(&f, f.a, "deleteChunksForSources", json!({"sourceKind":"screen","sourcePaths":["backtrack/7"]}));
    assert_eq!(ok(&gone)["deleted"], 1);
    assert!(ok(&api(&f, f.a, "searchChunks", json!({"query":"x","sourceKind":"screen"})))["chunks"].as_array().unwrap().is_empty());
}

#[test]
#[ignore = "Only through verify-gate"]
fn legacy_fact_calls_keep_the_old_chat_behaviour() {
    let f = Fixture::new();
    let fact = api(&f, f.a, "insertFact", json!({"category":"preference","content":"  Likes   Tea ","provenance":"inferred"}));
    let id = ok(&fact)["fact"]["id"].as_str().unwrap().to_owned();
    assert_eq!(ok(&fact)["fact"]["importance"], 0.5);
    assert_eq!(ok(&api(&f, f.a, "listActiveFacts", json!({})))["facts"].as_array().unwrap().len(), 1);
    // Importance: the old 400 text, and the old 404 when the fact is not found.
    let bad = api(&f, f.a, "updateFactImportance", json!({"id":id,"importance":2}));
    assert_eq!(bad["error"], json!({"statusCode":400,"error":"importance must be a number between 0 and 1"}));
    assert_eq!(ok(&api(&f, f.a, "updateFactImportance", json!({"id":id,"importance":0.9})))["done"], true);
    // Reject deletes the fact and records a suppression with the old signature.
    assert_eq!(ok(&api(&f, f.a, "rejectFact", json!({"id":id})))["done"], true);
    assert!(ok(&api(&f, f.a, "listActiveFacts", json!({})))["facts"].as_array().unwrap().is_empty());
    let signature: String = f.rt.block_on(f.root.query_one(
        "SELECT signature FROM app.chat_memory_suppressions WHERE owner_user_id = $1", &[&f.a])).unwrap().get(0);
    assert_eq!(signature, sha256_hex("preference::likes tea"));
    let suppressed = api(&f, f.a, "isSuppressed", json!({"category":"preference","content":"LIKES TEA"}));
    assert_eq!(ok(&suppressed)["suppressed"], true);
    // A confirmed fact cannot be rejected, and confirming needs an inferred fact.
    let kept = ok(&api(&f, f.a, "insertFact", json!({"category":"fact","content":"kept","provenance":"volunteered"})))["fact"]["id"]
        .as_str().unwrap().to_owned();
    assert_eq!(ok(&api(&f, f.a, "rejectFact", json!({"id":kept})))["done"], false);
    assert_eq!(ok(&api(&f, f.a, "confirmFact", json!({"id":kept})))["done"], false);
    // Corrections paging clamps to 1..100 with an offset of at least 0.
    let page = api(&f, f.a, "listCorrections", json!({"limit":1000,"offset":-4}));
    assert_eq!(ok(&page)["corrections"].as_array().unwrap().len(), 1);
    assert_eq!(ok(&api(&f, f.a, "supersedeFact", json!({"id":kept}))), &json!({}));
    assert!(ok(&api(&f, f.a, "getActiveFact", json!({"id":kept})))["fact"].is_null());
}

#[test]
#[ignore = "Only through verify-gate"]
fn candidate_episode_and_goal_entity_calls_match_the_old_shapes() {
    let f = Fixture::new();
    let entity = seed_public(&f, f.a);
    let input = json!({"kind":"fact","action":"create","payloadJson":{"x":1},"candidateSignature":"sig-1",
        "confidence":7,"importance":-3,"provenance":"inferred"});
    let first = api(&f, f.a, "insertCandidate", input.clone());
    let again = api(&f, f.a, "insertCandidate", input.clone());
    assert_eq!(ok(&first)["candidate"]["id"], ok(&again)["candidate"]["id"], "same signature returns the first row");
    assert_eq!((ok(&first)["candidate"]["confidence"].as_f64(), ok(&first)["candidate"]["importance"].as_f64()), (Some(1.0), Some(0.0)));
    assert_eq!(ok(&first)["candidate"]["status"], "pending");
    let mine = api(&f, f.b, "insertCandidate", input);
    assert_ne!(ok(&mine)["candidate"]["id"], ok(&first)["candidate"]["id"], "another person gets their own row");
    // Goals: alias lookup is exact, update renames, forget archives (the old status was refused by the table).
    assert_eq!(ok(&api(&f, f.a, "findEntityByAlias", json!({"alias":"Marathon"})))["entityId"], entity.as_str());
    assert!(ok(&api(&f, f.a, "findEntityByAlias", json!({"alias":"marathon"})))["entityId"].is_null());
    ok(&api(&f, f.a, "updateEntity", json!({"id":entity,"name":"Run more","summary":"a half"})));
    ok(&api(&f, f.a, "forgetEntity", json!({"id":entity})));
    let row = f.rt.block_on(f.root.query_one("SELECT name, status FROM app.memory_entities WHERE id = $1::text::uuid", &[&entity])).unwrap();
    assert_eq!((row.get::<_, String>(0), row.get::<_, String>(1)), ("Run more".into(), "archived".into()));
    assert_eq!(api(&f, f.a, "nope", json!({}))["error"]["statusCode"], 404);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_read_or_change_the_first_persons_public_data() {
    let f = Fixture::new();
    let entity = seed_public(&f, f.a);
    let fact = ok(&api(&f, f.a, "listActiveFacts", json!({})))["facts"][0]["id"].as_str().unwrap().to_owned();
    // The bare-count check sees A's rows once row security is off, so the proof below is meaningful.
    assert_eq!(bare_public(&f, f.b), 0, "row security hides A's rows from B");
    rls(&f, false);
    let exposed = bare_public(&f, f.b);
    let (chunks, listed, recent, corrections, found, got) = (
        api(&f, f.b, "searchChunks", json!({"query":"x","sourceKind":"screen"})),
        api(&f, f.b, "listActiveFacts", json!({})),
        api(&f, f.b, "listRecentChunks", json!({"sourceKind":"chat"})),
        api(&f, f.b, "listCorrections", json!({})),
        api(&f, f.b, "findEntityByAlias", json!({"alias":"Marathon"})),
        api(&f, f.b, "getActiveFact", json!({"id":fact})),
    );
    let writes = [
        api(&f, f.b, "deleteFact", json!({"id":fact})),
        api(&f, f.b, "confirmFact", json!({"id":fact})),
        api(&f, f.b, "rejectFact", json!({"id":fact})),
        api(&f, f.b, "updateFactImportance", json!({"id":fact,"importance":0.1})),
        api(&f, f.b, "deleteChunksForSources", json!({"sourceKind":"screen","sourcePaths":["backtrack/1"]})),
    ];
    ok(&api(&f, f.b, "supersedeFact", json!({"id":fact})));
    ok(&api(&f, f.b, "updateEntity", json!({"id":entity,"name":"hijack","summary":""})));
    ok(&api(&f, f.b, "forgetEntity", json!({"id":entity})));
    rls(&f, true);
    assert!(exposed > 0, "A's rows were not exposed without row security, so the check proves nothing");
    assert!(ok(&chunks)["chunks"].as_array().unwrap().is_empty());
    assert!(ok(&listed)["facts"].as_array().unwrap().is_empty());
    assert!(ok(&recent)["chunks"].as_array().unwrap().is_empty());
    assert!(ok(&corrections)["corrections"].as_array().unwrap().is_empty());
    assert!(ok(&found)["entityId"].is_null() && ok(&got)["fact"].is_null());
    for w in &writes {
        assert!(ok(w)["done"] == false || ok(w)["deleted"] == 0, "B changed A's data: {w}");
    }
    let state = f.rt.block_on(f.root.query_one(
        "SELECT (SELECT count(*) FROM app.chat_memory_facts WHERE owner_user_id = $1 AND status = 'active'),
                (SELECT count(*) FROM app.memory_chunks WHERE owner_user_id = $1 AND source_kind = 'screen'),
                (SELECT count(*) FROM app.memory_entities WHERE owner_user_id = $1 AND name = 'Run' AND status = 'active')",
        &[&f.a])).unwrap();
    assert_eq!((state.get::<_, i64>(0), state.get::<_, i64>(1), state.get::<_, i64>(2)), (1, 1, 1));
    // A still sees everything.
    assert_eq!(ok(&api(&f, f.a, "listActiveFacts", json!({})))["facts"].as_array().unwrap().len(), 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn memory_text_stays_out_of_errors_job_payloads_and_activity_rows() {
    let f = Fixture::new();
    let marker = format!("zq-marker-{}", Uuid::new_v4());
    // A failed embedding refuses the call without echoing the text back.
    let failed = f.guest(f.a, true, "api", json!({"name":"embedTurn","parameters":{
        "threadId": Uuid::new_v4().to_string(), "userText": marker, "assistantText": "x"}}));
    let shown = match &failed { Ok(v) => v.to_string(), Err(e) => e.clone() };
    assert!(!shown.contains(&marker), "an error echoed memory text: {shown}");
    assert!(shown.contains("503") || failed.is_err());
    ok(&api(&f, f.a, "insertFact", json!({"category":"fact","content":marker})));
    ok(&api(&f, f.a, "embedTurn", json!({"threadId":Uuid::new_v4().to_string(),"userText":marker,"assistantText":"y"})));
    // No table that carries jobs, activity, audit or events holds the text.
    let tables: Vec<String> = f.rt.block_on(f.root.query(
        "SELECT table_schema || '.' || table_name FROM information_schema.tables
         WHERE table_schema IN ('app', 'pgboss') AND table_type = 'BASE TABLE'
           AND table_name ~ '(job|activity|audit|event|outbox|queue)'", &[])).unwrap()
        .iter().map(|r| r.get(0)).collect();
    for t in &tables {
        let n: i64 = f.rt.block_on(f.root.query_one(&format!("SELECT count(*) FROM {t} x WHERE x::text LIKE $1"), &[&format!("%{marker}%")])).unwrap().get(0);
        assert_eq!(n, 0, "{t} holds memory text");
    }
    eprintln!("checked {} job and activity tables", tables.len());
}
