mod common;
use access_context::AccessContext;
use moss_module_host::{
    database::runtime_role,
    manifest::Capability,
    runtime::{DenyPorts, Host, Limits, Ports},
    transactional_database::TransactionalDatabasePorts,
};
use moss_module_sdk::query::{Filter, Query};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::NoTls;

const TABLE: &str = "app.sample_atomic_entries";
const LINKS: &str = "app.sample_atomic_links";
const PREFS: &str = "app.sample_atomic_preferences";
fn request(table: &str, query: Query) -> Value {
    json!({"operation":"query","resource":table,"parameters":query})
}
fn component(requests: &[Value], ending: &str) -> Vec<u8> {
    // A real component sends each request through the linked host import. Its final result
    // is independent of port replies, exercising a guest which catches a failed SQL call.
    let mut data = String::new();
    let mut calls = String::new();
    let mut offset = 1024;
    for request in requests {
        let bytes = serde_json::to_vec(request).unwrap();
        let escaped: String = bytes.iter().map(|b| format!("\\{b:02x}")).collect();
        data += &format!("(data (i32.const {offset}) \"{escaped}\")");
        calls += &format!(
            "i32.const {offset} i32.const {} i32.const 32 call $db\n",
            bytes.len()
        );
        offset += bytes.len() + 1;
    }
    let reply = if ending == "status" {
        r#"{"status":409,"body":{}}"#
    } else {
        "done"
    };
    let escaped: String = reply.bytes().map(|b| format!("\\{b:02x}")).collect();
    let tag = if ending == "error" { 1 } else { 0 };
    let finish = if ending == "trap" {
        "unreachable".into()
    } else {
        format!("i32.const 32 i32.const {tag} i32.store i32.const 36 i32.const 128 i32.store i32.const 40 i32.const {} i32.store i32.const 32",reply.len())
    };
    wat::parse_str(format!(r#"(component
      (type $t (func (param "request" string) (result (result string (error string)))))
      (import "moss:module/db@1.0.0" (instance $db (export "call" (func (type $t)))))
      (alias export $db "call" (func $call))
      (core module $mem (memory (export "memory") 4 1024)
        (global $heap (mut i32) (i32.const 65536))
        (func (export "realloc") (param i32 i32 i32 i32) (result i32) (local $old i32)
          global.get $heap local.tee $old local.get 3 i32.add global.set $heap local.get $old)
        (data (i32.const 128) "{escaped}") {data})
      (core instance $m (instantiate $mem))
      (alias core export $m "memory" (core memory $memory))
      (alias core export $m "realloc" (core func $realloc))
      (core func $lower (canon lower (func $call) (memory $memory) (realloc (func $realloc))))
      (core module $g (import "host" "memory" (memory 4 1024))
        (import "host" "db" (func $db (param i32 i32 i32)))
        (func (export "handle") (param i32 i32 i32 i32) (result i32) {calls} {finish}))
      (core instance $guest (instantiate $g (with "host" (instance (export "memory" (memory $memory)) (export "db" (func $lower))))))
      (alias core export $guest "handle" (core func $handle))
      (func (export "handle") (param "kind" string) (param "payload" string) (result (result string (error string)))
        (canon lift (core func $handle) (memory $memory) (realloc (func $realloc)))))"#)).unwrap()
}
#[test]
#[ignore = "Only through verify-gate and tools/transaction-gate.sh"]
fn real_transactions_preserve_composite_keys_privacy_and_atomicity() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let admin = uuid::Uuid::new_v4();
    let role = runtime_role("sample.atomic");
    let (bootstrap, database) = rt.block_on(async {
        let (db,c) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();
        tokio::spawn(async move {let _=c.await;});
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'atomic-a@example.test','A',false),($2,'atomic-b@example.test','B',false),($3,'atomic-admin@example.test','C',true)",&[&a,&b,&admin]).await.unwrap();
        db.batch_execute(&format!("CREATE ROLE {role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT {role} TO jarvis_app_runtime;
          CREATE TABLE {TABLE}(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES app.users(id),title text NOT NULL);
          CREATE TABLE {PREFS}(owner_user_id uuid PRIMARY KEY REFERENCES app.users(id),label text);
          CREATE TABLE {LINKS}(entry_id uuid REFERENCES {TABLE}(id),tag text,PRIMARY KEY(entry_id,tag));
          GRANT USAGE ON SCHEMA app TO {role}; GRANT EXECUTE ON FUNCTION app.current_actor_user_id() TO {role}; GRANT SELECT,INSERT,UPDATE,DELETE ON {TABLE},{PREFS},{LINKS} TO {role};
          ALTER TABLE {TABLE} ENABLE ROW LEVEL SECURITY; ALTER TABLE {TABLE} FORCE ROW LEVEL SECURITY;
          CREATE POLICY own ON {TABLE} USING(owner_user_id=app.current_actor_user_id()) WITH CHECK(owner_user_id=app.current_actor_user_id());
          ALTER TABLE {PREFS} ENABLE ROW LEVEL SECURITY; ALTER TABLE {PREFS} FORCE ROW LEVEL SECURITY;
          CREATE POLICY own ON {PREFS} USING(owner_user_id=app.current_actor_user_id()) WITH CHECK(owner_user_id=app.current_actor_user_id());
          ALTER TABLE {LINKS} ENABLE ROW LEVEL SECURITY; ALTER TABLE {LINKS} FORCE ROW LEVEL SECURITY;
          CREATE POLICY own ON {LINKS} USING(EXISTS(SELECT 1 FROM {TABLE} e WHERE e.id=entry_id)) WITH CHECK(EXISTS(SELECT 1 FROM {TABLE} e WHERE e.id=entry_id));")).await.unwrap();
        let app = Database::connect(&std::env::var("JS43_APP_URL").unwrap(),4,RuntimeRole::App).await.unwrap(); (db,app)
    });
    let mut manifest = common::manifest("1.0.0");
    manifest.id = "sample.atomic".into();
    manifest.database.owned_tables = vec![TABLE.into(), PREFS.into(), LINKS.into()];
    manifest.capabilities = vec![Capability {
        port: "db".into(),
        operations: ["query".into()].into(),
        resources: [TABLE.into(), PREFS.into(), LINKS.into()].into(),
        allow_private: false,
    }];
    let m = Arc::new(manifest);
    let ports: Arc<dyn Ports> =
        Arc::new(TransactionalDatabasePorts::new(database, Arc::new(DenyPorts)).unwrap());
    struct Trace(Arc<dyn Ports>);
    impl Ports for Trace {
        fn invoke(&self, scope: &moss_module_host::runtime::CallScope, port: &str, request: &moss_module_host::runtime::Request) -> anyhow::Result<Value> {
            let result=self.0.invoke(scope,port,request);
            if let Err(error)=&result { eprintln!("synthetic transaction fixture: {error:?}"); }
            result
        }
        fn finish_call(&self, scope: &moss_module_host::runtime::CallScope, success: bool) -> anyhow::Result<()> {self.0.finish_call(scope,success)}
    }
    let ports: Arc<dyn Ports> = Arc::new(Trace(ports));
    let host = Host::new(Limits::default()).unwrap();
    let run = |actor, requests: Vec<Value>, ending: &str| {
        host.call(
            &component(&requests, ending),
            m.clone(),
            AccessContext::new(actor, "same-id"),
            ports.clone(),
            "route",
            "{}",
        )
    };
    let id = uuid::Uuid::new_v4().to_string();
    run(
        a,
        vec![
            request(
                TABLE,
                Query::insert(
                    json!({"id":id,"title":"original"})
                        .as_object()
                        .unwrap()
                        .clone()
                        .into_iter()
                        .collect(),
                ),
            ),
            request(
                LINKS,
                Query::insert(
                    json!({"entry_id":id,"tag":"one"})
                        .as_object()
                        .unwrap()
                        .clone()
                        .into_iter()
                        .collect(),
                ),
            ),
            request(
                PREFS,
                Query::insert([("label".into(), json!("initial"))].into()),
            ),
        ],
        "ok",
    )
    .unwrap();
    let count = || {
        rt.block_on(bootstrap.query_one(&format!("SELECT count(*) FROM {TABLE}"), &[]))
            .unwrap()
            .get::<_, i64>(0)
    };
    assert_eq!(count(), 1);
    // A separate component returns the select response to observe RLS directly.
    let select = request(TABLE, Query::select(Filter::All));
    let query_wasm = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace("moss:module/kv@1.0.0", "moss:module/db@1.0.0"),
    )
    .unwrap();
    let select_as = |actor| -> Vec<Value> {
        serde_json::from_str(
            &host
                .call(
                    &query_wasm,
                    m.clone(),
                    AccessContext::new(actor, "same-id"),
                    ports.clone(),
                    "route",
                    &select.to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(select_as(a).len(), 1);
    assert!(select_as(b).is_empty());
    assert!(select_as(admin).is_empty());
    for other in [b, admin] {
        run(
            other,
            vec![
                request(
                    TABLE,
                    Query::update(
                        Filter::eq("id", id.as_str()),
                        [("title".into(), json!("stolen"))].into(),
                    ),
                ),
                request(TABLE, Query::delete(Filter::eq("id", id.as_str()))),
            ],
            "ok",
        )
        .unwrap();
    }
    assert_eq!(select_as(a)[0]["title"], "original");
    assert!(run(
        b,
        vec![request(
            LINKS,
            Query::insert(
                [
                    ("entry_id".into(), json!(id)),
                    ("tag".into(), json!("forged"))
                ]
                .into()
            )
        )],
        "ok"
    )
    .is_err());
    for ending in ["error", "trap", "status"] {
        let result = run(
            a,
            vec![request(
                TABLE,
                Query::insert([("title".into(), json!(ending))].into()),
            )],
            ending,
        );
        if ending != "status" {
            assert!(result.is_err());
        } else {
            result.unwrap();
        }
        assert_eq!(count(), 1, "rollback after {ending}");
    }
    // SQL failure caught by the guest still poisons the invocation, so earlier writes vanish.
    assert!(run(
        a,
        vec![
            request(
                TABLE,
                Query::insert([("title".into(), json!("must rollback"))].into())
            ),
            request(
                TABLE,
                Query::insert([("unknown_column".into(), json!("invalid"))].into())
            )
        ],
        "ok"
    )
    .is_err());
    assert_eq!(count(), 1);
    run(
        a,
        vec![
            request(
                PREFS,
                Query::update(Filter::Owned, [("label".into(), json!("changed"))].into()),
            ),
            request(
                LINKS,
                Query::delete(Filter::And {
                    filters: vec![
                        Filter::eq("entry_id", id.as_str()),
                        Filter::eq("tag", "one"),
                    ],
                }),
            ),
        ],
        "ok",
    )
    .unwrap();
    assert_eq!(
        rt.block_on(bootstrap.query_one(&format!("SELECT label FROM {PREFS}"), &[]))
            .unwrap()
            .get::<_, String>(0),
        "changed"
    );
    assert_eq!(
        rt.block_on(bootstrap.query_one(&format!("SELECT count(*) FROM {LINKS}"), &[]))
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    // Removal control: exactly the same cross-account read detects data after RLS is removed.
    rt.block_on(
        bootstrap.batch_execute(&format!("ALTER TABLE {TABLE} DISABLE ROW LEVEL SECURITY")),
    )
    .unwrap();
    assert_eq!(
        select_as(b).len(),
        1,
        "privacy assertion must detect missing protection"
    );
    rt.block_on(bootstrap.batch_execute(&format!("ALTER TABLE {TABLE} ENABLE ROW LEVEL SECURITY")))
        .unwrap();
    assert!(select_as(b).is_empty());
    println!("PASS real Wasmtime + PostgreSQL: composite keys, owner preferences, account/admin privacy, RLS removal control, rollback after error/trap/status/caught SQL error, repeated request IDs");
}
