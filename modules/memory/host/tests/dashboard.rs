//! Database proofs for the Memory screen store. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_memory_host::dashboard;
use moss_module_host::runtime::Request;
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use std::collections::HashSet;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

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
                tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Dash A',false),($2,$4,'Dash B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App).await.unwrap();
            (root, db)
        });
        Self { rt, root, db, a, b }
    }

    /// One call as `actor`. Like the real ports, a refusal is never committed.
    async fn call(&self, actor: Uuid, op: &str, resource: &str, parameters: Value) -> Value {
        let cx = DataContext::open(&self.db, &AccessContext::new(actor, "dashboard-proof")).await.unwrap();
        let request = Request { operation: op.into(), resource: resource.into(), parameters };
        let out = dashboard::run(&cx, &request).await.unwrap();
        if out.get("refused").is_none() {
            cx.commit().await.unwrap();
        }
        out
    }

    fn run(&self, actor: Uuid, op: &str, resource: &str, parameters: Value) -> Value {
        self.rt.block_on(self.call(actor, op, resource, parameters))
    }

    fn suggest(&self, actor: Uuid, signature: &str, object: &str, subject: &str) -> String {
        let payload = json!({"kind":"fact","fact":{"subject":subject,"predicate":"prefers","objectText":object,
                              "recordKind":"preference"}});
        self.run(
            actor,
            "set",
            "memory.candidate",
            json!({"action":"add","signature":signature,"payload":payload}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn accept(&self, actor: Uuid, id: &str) -> Value {
        self.run(actor, "set", "memory.candidate", json!({"action":"accept","id":id}))
    }

    fn count(&self, sql: &str, owner: Uuid) -> i64 {
        self.rt.block_on(self.root.query_one(sql, &[&owner])).unwrap().get(0)
    }

    fn sql(&self, statement: &str) {
        self.rt.block_on(self.root.batch_execute(statement)).unwrap();
    }

    fn fact(&self, actor: Uuid, text: &str, pinned: bool, importance: f64) {
        self.sql(&format!(
            "INSERT INTO app.memory_facts (owner_user_id, subject_entity_id, predicate, object_text, record_kind,
                                           confidence, importance, provenance, pinned)
             VALUES ('{actor}', (SELECT id FROM app.memory_entities WHERE owner_user_id='{actor}' AND kind='self'),
                     'prefers', '{text}', 'preference', 0.9, {importance}, 'volunteered', {pinned})"
        ));
    }

    fn self_entity(&self, actor: Uuid) {
        self.sql(&format!(
            "INSERT INTO app.memory_entities (owner_user_id, kind, name, summary)
             VALUES ('{actor}', 'self', 'Me', '') ON CONFLICT DO NOTHING"
        ));
    }
}

fn refusal(out: &Value) -> (u64, String) {
    let r = &out["refused"];
    (r["status"].as_u64().expect("expected a refusal"), r["message"].as_str().unwrap_or("").to_owned())
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_sees_and_decides_nothing_of_the_first_persons_suggestions() {
    let f = Fixture::new();
    let id = f.suggest(f.a, "iso-1", "drinks tea", "self");
    f.fact(f.a, "owner fact", false, 0.5);
    let seen = f.run(f.b, "get", "memory.candidates", json!({}));
    assert_eq!(seen["total"], 0);
    assert_eq!(seen["items"].as_array().unwrap().len(), 0);
    assert_eq!(f.run(f.b, "get", "memory.facts", json!({}))["items"].as_array().unwrap().len(), 0);
    for action in ["accept", "reject", "suppress"] {
        let out = f.run(f.b, "set", "memory.candidate", json!({"action":action,"id":id}));
        assert_eq!(refusal(&out).0, 404, "{action}");
    }
    let mine = f.run(f.a, "get", "memory.candidates", json!({}));
    assert_eq!(mine["total"], 1);
    assert_eq!(mine["items"][0]["status"], "pending");
    // The same signature for the other person is a separate suggestion.
    let other = f.suggest(f.b, "iso-1", "drinks coffee", "self");
    assert_ne!(other, id);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_decided_suggestion_cannot_be_decided_again_and_does_not_return() {
    let f = Fixture::new();
    let id = f.suggest(f.a, "once-1", "likes rain", "self");
    let done = f.run(f.a, "set", "memory.candidate", json!({"action":"reject","id":id}));
    assert_eq!(done["done"], true);
    for action in ["accept", "reject", "suppress"] {
        let out = f.run(f.a, "set", "memory.candidate", json!({"action":action,"id":id}));
        assert_eq!(refusal(&out).0, 404, "{action}");
    }
    assert_eq!(f.count("SELECT count(*) FROM app.memory_facts WHERE owner_user_id=$1", f.a), 0);
    // Suggesting the same thing again keeps the dismissed status.
    let again = f.run(
        f.a,
        "set",
        "memory.candidate",
        json!({"action":"add","signature":"once-1","payload":{"kind":"fact","fact":{"objectText":"likes rain"}}}),
    );
    assert_eq!(again["status"], "rejected");
    assert_eq!(f.run(f.a, "get", "memory.candidates", json!({}))["total"], 0);
    let history = f.run(f.a, "get", "memory.candidates", json!({"view":"history"}));
    assert_eq!(history["total"], 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn paging_walks_every_suggestion_and_fact_once_in_a_stable_order() {
    let f = Fixture::new();
    f.self_entity(f.a);
    for i in 0..7 {
        f.suggest(f.a, &format!("page-{i}"), &format!("thing {i}"), "self");
    }
    let mut seen = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = f.run(f.a, "get", "memory.candidates", json!({"limit":3,"cursor":cursor}));
        assert_eq!(page["total"], 7);
        seen.extend(page["items"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_owned()));
        if page["hasMore"] != true {
            break;
        }
        cursor = page["nextCursor"].clone();
    }
    assert_eq!(seen.len(), 7);
    assert_eq!(seen.iter().collect::<HashSet<_>>().len(), 7);

    // Mixed pins and importances, so every sort key is exercised.
    for (i, (pinned, importance)) in
        [(false, 0.5), (true, 0.2), (false, 0.9), (true, 0.9), (false, 0.5), (true, 0.2), (false, 0.1)].iter().enumerate()
    {
        f.fact(f.a, &format!("fact {i}"), *pinned, *importance);
    }
    let mut ids = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = f.run(f.a, "get", "memory.facts", json!({"limit":3,"cursor":cursor}));
        ids.extend(page["items"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_owned()));
        if page["hasMore"] != true {
            break;
        }
        cursor = page["nextCursor"].clone();
    }
    assert_eq!(ids.len(), 7);
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 7);
    let all = f.run(f.a, "get", "memory.facts", json!({"limit":50}));
    let whole: Vec<String> = all["items"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids, whole, "paged order equals the one-page order");
    assert_eq!(all["items"][0]["pinned"], true);

    let bad = f.run(f.a, "get", "memory.facts", json!({"cursor":"nonsense"}));
    assert_eq!(refusal(&bad), (400, "Invalid cursor".to_owned()));
}

#[test]
#[ignore = "Only through verify-gate"]
fn two_accepts_at_once_save_exactly_one_memory() {
    let f = Fixture::new();
    let id = f.suggest(f.a, "race-1", "walks at dawn", "self");
    let (x, y) = f.rt.block_on(async {
        tokio::join!(
            f.call(f.a, "set", "memory.candidate", json!({"action":"accept","id":id})),
            f.call(f.a, "set", "memory.candidate", json!({"action":"accept","id":id}))
        )
    });
    let refused = [&x, &y].iter().filter(|o| o.get("refused").is_some()).count();
    assert_eq!(refused, 1, "{x} {y}");
    assert_eq!(f.count("SELECT count(*) FROM app.memory_facts WHERE owner_user_id=$1", f.a), 1);
    assert_eq!(f.count("SELECT count(*) FROM app.memory_candidates WHERE owner_user_id=$1 AND status='promoted'", f.a), 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn an_ambiguous_name_refuses_the_accept_and_writes_nothing() {
    let f = Fixture::new();
    f.sql(&format!(
        "INSERT INTO app.memory_entities (owner_user_id, kind, name, summary)
         VALUES ('{a}','person','Sam','one'),('{a}','person','sam','two')",
        a = f.a
    ));
    let id = f.suggest(f.a, "amb-1", "plays chess", "Sam");
    let out = f.accept(f.a, &id);
    assert_eq!(refusal(&out).0, 409);
    assert_eq!(f.count("SELECT count(*) FROM app.memory_facts WHERE owner_user_id=$1", f.a), 0);
    assert_eq!(f.count("SELECT count(*) FROM app.memory_candidates WHERE owner_user_id=$1 AND status='pending'", f.a), 1);
    assert_eq!(f.count("SELECT count(*) FROM app.memory_entities WHERE owner_user_id=$1", f.a), 2);
}

#[test]
#[ignore = "Only through verify-gate"]
fn accepting_creates_a_confirmed_fact_and_a_new_name_becomes_a_topic() {
    let f = Fixture::new();
    let id = f.suggest(f.a, "ok-1", "grows tomatoes", "Gardening");
    let out = f.accept(f.a, &id);
    assert_eq!(out["fact"]["provenance"], "confirmed");
    assert_eq!(f.count("SELECT count(*) FROM app.memory_entities WHERE owner_user_id=$1 AND kind='topic' AND name='Gardening'", f.a), 1);
    assert_eq!(f.count("SELECT count(*) FROM app.memory_search_documents WHERE owner_user_id=$1 AND status='active'", f.a), 2);
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_self_entity_cannot_change_and_one_with_facts_cannot_go() {
    let f = Fixture::new();
    let id = f.suggest(f.a, "ent-1", "likes jazz", "Music");
    f.accept(f.a, &id);
    let me: String = f.rt.block_on(f.root.query_one(
        "SELECT id::text FROM app.memory_entities WHERE owner_user_id=$1 AND kind='self'", &[&f.a])).unwrap().get(0);
    let topic: String = f.rt.block_on(f.root.query_one(
        "SELECT id::text FROM app.memory_entities WHERE owner_user_id=$1 AND name='Music'", &[&f.a])).unwrap().get(0);
    for resource in ["memory.entity-patch", "memory.entity-delete"] {
        let out = f.run(f.a, "set", resource, json!({"entityId":me}));
        assert_eq!(refusal(&out).0, 403, "{resource}");
        let out = f.run(f.a, "set", resource, json!({"entityId":Uuid::new_v4().to_string()}));
        assert_eq!(refusal(&out).0, 404, "{resource}");
        let out = f.run(f.b, "set", resource, json!({"entityId":topic}));
        assert_eq!(refusal(&out).0, 404, "{resource} by another person");
    }
    let out = f.run(f.a, "set", "memory.entity-delete", json!({"entityId":topic}));
    assert_eq!(refusal(&out).0, 409);
    let out = f.run(f.a, "set", "memory.entity-patch", json!({"entityId":topic,"status":"archived"}));
    assert_eq!(refusal(&out).0, 409);
    let out = f.run(f.a, "set", "memory.entity-patch", json!({"entityId":topic,"name":"Jazz"}));
    assert_eq!(out["patched"], true);
}

#[test]
#[ignore = "Only through verify-gate"]
fn ending_a_fact_turns_its_search_entry_off_and_clearing_turns_it_on() {
    let f = Fixture::new();
    let id = f.suggest(f.a, "patch-1", "reads at night", "self");
    let fact = f.accept(f.a, &id)["fact"]["id"].as_str().unwrap().to_owned();
    let doc = || -> String {
        f.rt.block_on(f.root.query_one(
            "SELECT status FROM app.memory_search_documents WHERE owner_user_id=$1 AND target_kind='fact'",
            &[&f.a])).unwrap().get(0)
    };
    assert_eq!(doc(), "active");
    f.run(f.a, "set", "memory.fact-patch", json!({"factId":fact,"validTo":"2020-01-01T00:00:00Z"}));
    assert_eq!(doc(), "inactive");
    f.run(f.a, "set", "memory.fact-patch", json!({"factId":fact,"validTo":null}));
    assert_eq!(doc(), "active");
    let out = f.run(f.b, "set", "memory.fact-patch", json!({"factId":fact,"pinned":true}));
    assert_eq!(refusal(&out).0, 404);
    assert_eq!(f.count("SELECT count(*) FROM app.memory_facts WHERE owner_user_id=$1 AND pinned", f.a), 0);
}

/// Counts rows outside the memory tables that mention `marker`.
fn leaks(f: &Fixture, marker: &str) -> i64 {
    f.rt.block_on(async {
        let tables = f
            .root
            .query(
                "SELECT table_name FROM information_schema.tables
                 WHERE table_schema='app' AND table_type='BASE TABLE' AND table_name NOT LIKE 'memory\\_%'",
                &[],
            )
            .await
            .unwrap();
        let mut total = 0;
        for t in tables {
            let name: String = t.get(0);
            let sql = format!("SELECT count(*) FROM app.\"{name}\" x WHERE x::text LIKE $1");
            total += f.root.query_one(&sql, &[&format!("%{marker}%")]).await.unwrap().get::<_, i64>(0);
        }
        total
    })
}

#[test]
#[ignore = "Only through verify-gate"]
fn memory_text_stays_in_memory_tables_and_out_of_refusals() {
    let f = Fixture::new();
    let marker = format!("zq{}", Uuid::new_v4().simple());
    let id = f.suggest(f.a, "leak-1", &format!("secret {marker}"), "self");
    f.accept(f.a, &id);
    let again = f.accept(f.a, &id);
    f.suggest(f.a, "leak-2", &format!("other {marker}"), &format!("Dup {marker}"));
    assert!(!again.to_string().contains(&marker));
    assert_eq!(leaks(&f, &marker), 0);
    // The scan has teeth: the same marker is found once memory tables are included.
    let inside: i64 = f.count(
        &format!("SELECT count(*) FROM app.memory_facts x WHERE x.owner_user_id=$1 AND x::text LIKE '%{marker}%'"),
        f.a,
    );
    assert!(inside >= 1);
}
