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
