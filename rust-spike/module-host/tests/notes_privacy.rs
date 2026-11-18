//! Runs the language-neutral Notes cases through the shared parity probe, and the real
//! Wasm/transactional-db path. This fixture guest is not the pending Notes implementation.
mod common;
#[allow(dead_code)]
#[path = "../../parity/src/dbs.rs"]
mod parity_db;
use access_context::AccessContext;
use moss_module_host::{
    legacy,
    manifest::{Capability, Ledger},
    runtime::{DenyPorts, Host, Limits, Ports},
    transactional_database::TransactionalDatabasePorts,
};
use moss_module_sdk::query::{Filter, Query};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{collections::BTreeMap, panic::catch_unwind, path::Path, sync::Arc};
use tokio_postgres::NoTls;
use uuid::Uuid;

const A: &str = "00000000-0000-4000-8000-000000000001";
const B: &str = "00000000-0000-4000-8000-000000000002";
const ADMIN: &str = "00000000-0000-4000-8000-000000000003";
fn fill(sql: &str) -> String {
    sql.replace("{{userA}}", A).replace("{{userB}}", B)
}
fn cases() -> Vec<Value> {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules/notes/tests");
    let mut paths: Vec<_> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .flat_map(|path| {
            serde_json::from_slice::<Vec<Value>>(&std::fs::read(path).unwrap()).unwrap()
        })
        .collect()
}
fn actor(name: &str) -> Option<&'static str> {
    match name {
        "A" => Some(A),
        "B" => Some(B),
        "admin" => Some(ADMIN),
        "anon" => None,
        _ => panic!("unknown actor"),
    }
}
fn assert_probe(actual: &Value, expected: &Value) {
    // The existing parity runner also compares a subset, including error codes rather
    // than database-generated error detail which can differ between versions.
    for (key, value) in expected.as_object().unwrap() {
        if key == "error" {
            assert_eq!(actual["error"]["code"], value["code"]);
        } else {
            assert_eq!(&actual[key], value, "actual parity probe: {actual}");
        }
    }
}
async fn rows(db: &tokio_postgres::Client) -> BTreeMap<String, Value> {
    let mut output = BTreeMap::new();
    for table in legacy::tables("notes") {
        let row = db.query_one(&format!("SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY owner_user_id),'[]'::jsonb) FROM {table} r"), &[]).await.unwrap();
        output.insert(table.clone(), row.get(0));
    }
    output
}

#[test]
#[ignore = "Only through verify-gate and modules/notes/tools/gate.sh"]
fn six_frozen_notes_tables_refuse_other_accounts_and_admins() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let bootstrap = rt.block_on(async {
        let (db, c) = tokio_postgres::connect(&std::env::var("JS47_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
        tokio::spawn(async move { let _ = c.await; });
        db.batch_execute(&format!("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES ('{A}','notes-sql-a@example.test','A',false),('{B}','notes-sql-b@example.test','B',false),('{ADMIN}','notes-sql-admin@example.test','Admin',true)")).await.unwrap();
        db
    });
    let cases = cases();
    assert_eq!(cases.len(), 6);
    for seed in cases[0]["seed"].as_array().unwrap() {
        rt.block_on(bootstrap.batch_execute(&fill(seed.as_str().unwrap())))
            .unwrap();
    }
    let baseline = rt.block_on(rows(&bootstrap));
    assert_eq!(baseline.len(), 6);
    for table in legacy::tables("notes") {
        let flags = rt.block_on(bootstrap.query_one("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::text::regclass", &[table])).unwrap();
        assert!(flags.get::<_, bool>(0) && flags.get::<_, bool>(1));
        assert_eq!(baseline[table].as_array().unwrap().len(), 2);
    }
    for file in [
        "0336_notes_managed_source_lifecycle.sql",
        "0337_notes_recording_contributions.sql",
        "0340_notes_recording_cleanup.sql",
    ] {
        let path = format!("sql/{file}");
        let frozen = legacy::entry("notes", &path).unwrap();
        let raw = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/notes")
                .join(&path),
        )
        .unwrap();
        assert_eq!(moss_module_host::trust::digest(&raw), frozen.raw);
        let row = rt
            .block_on(bootstrap.query_one(
                "SELECT checksum FROM app.schema_migrations WHERE version=$1",
                &[&legacy::version(&path).unwrap()],
            ))
            .unwrap();
        assert_eq!(row.get::<_, String>(0), frozen.checksum);
    }
    for case in &cases {
        // Each file puts its subject first in the SQL. The table name is from the frozen
        // inventory, never external input; only this disposable server loses RLS.
        let sql = case["steps"][0]["sql"].as_str().unwrap();
        let table = legacy::tables("notes")
            .iter()
            .find(|t| sql.contains(t.as_str()))
            .unwrap();
        rt.block_on(
            bootstrap.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")),
        )
        .unwrap();
        let mut red = 0;
        let mut failures = Vec::new();
        for step in case["steps"].as_array().unwrap() {
            let name = step["as"].as_str().unwrap();
            if name == "A"
                || step["expect"].get("error").is_some()
                || step["id"].as_str().unwrap().ends_with(" delete")
            {
                continue;
            }
            let url: url::Url = std::env::var(if step["role"] == "app" {
                "JS47_APP_URL"
            } else {
                "JS47_WORKER_URL"
            })
            .unwrap()
            .parse()
            .unwrap();
            let db = url.path().trim_start_matches('/');
            let actual = rt.block_on(parity_db::probe(
                &url,
                db,
                actor(name),
                &fill(step["sql"].as_str().unwrap()),
            ));
            let exposed = if step["id"].as_str().unwrap().ends_with(" read") {
                json!([{"n":1}])
            } else {
                json!([{"n":"1"}])
            };
            assert_eq!(
                actual["rows"], exposed,
                "negative control must read or update an actual row"
            );
            if catch_unwind(|| assert_probe(&actual, &step["expect"])).is_err() {
                red += 1;
            } else {
                failures.push(step["id"].clone());
            }
        }
        // Always restore, including when an assertion unexpectedly passed with RLS removed.
        rt.block_on(
            bootstrap.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")),
        )
        .unwrap();
        assert!(
            failures.is_empty(),
            "controls passed without RLS: {failures:?}"
        );
        assert_eq!(red, 12);
        for step in case["steps"].as_array().unwrap() {
            let url: url::Url = std::env::var(if step["role"] == "app" {
                "JS47_APP_URL"
            } else {
                "JS47_WORKER_URL"
            })
            .unwrap()
            .parse()
            .unwrap();
            let actual = rt.block_on(parity_db::probe(
                &url,
                url.path().trim_start_matches('/'),
                actor(step["as"].as_str().unwrap()),
                &fill(step["sql"].as_str().unwrap()),
            ));
            assert_probe(&actual, &step["expect"]);
        }
        println!("{table}: {red} read/update assertions failed without RLS; all 28 SQL probes passed after restoration");
    }
    // Exercise the actual Wasm ABI and transactional SDK host, including deliberately
    // broad owner filters. The fixture forwards JSON; it is not a Notes guest handler.
    let host = Host::new(Limits::default()).unwrap();
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace("moss:module/kv@1.0.0", "moss:module/db@1.0.0"),
    )
    .unwrap();
    let mut manifest = common::manifest("0.1.0");
    manifest.id = "notes".into();
    manifest.database.ledger = Ledger::CoreLegacy;
    manifest.database.owned_tables = legacy::tables("notes").to_vec();
    manifest.capabilities = vec![Capability {
        port: "db".into(),
        operations: ["query".into()].into(),
        resources: legacy::tables("notes").iter().cloned().collect(),
        allow_private: false,
    }];
    let manifest = Arc::new(manifest);
    for (name, role) in [
        ("JS47_APP_URL", RuntimeRole::App),
        ("JS47_WORKER_URL", RuntimeRole::Worker),
    ] {
        let database = rt
            .block_on(Database::connect(&std::env::var(name).unwrap(), 4, role))
            .unwrap();
        let ports: Arc<dyn Ports> =
            Arc::new(TransactionalDatabasePorts::new(database, Arc::new(DenyPorts)).unwrap());
        for (table, before) in &baseline {
            for who in [A, B, ADMIN] {
                let filter = Filter::eq("owner_user_id", A);
                let column = if before[0].get("generation").is_some() {
                    "generation"
                } else if before[0].get("revision").is_some() {
                    "revision"
                } else {
                    "payload"
                };
                let value = before[0][column].clone();
                let mut queries = vec![
                    Query::select(filter.clone()),
                    Query::update(filter.clone(), [(column.into(), value)].into()),
                ];
                if who != A {
                    queries.push(Query::delete(filter));
                }
                for query in queries {
                    let result = host
                        .call(
                            &wasm,
                            manifest.clone(),
                            AccessContext::new(Uuid::parse_str(who).unwrap(), "notes-parity"),
                            ports.clone(),
                            "route",
                            &json!({"operation":"query","resource":table,"parameters":query})
                                .to_string(),
                        )
                        .unwrap_or_else(|error| {
                            panic!("{name} {who} {table} typed query: {error}")
                        });
                    let actual: Vec<Value> = serde_json::from_str(&result).unwrap();
                    assert_eq!(actual.len(), usize::from(who == A), "{name} {who} {table}");
                }
            }
        }
        println!(
            "{name}: real Wasm typed-query reads, updates and deletes retain Notes owner isolation"
        );
    }
    assert_eq!(
        rt.block_on(rows(&bootstrap)),
        baseline,
        "probes must preserve all six tables' rows"
    );
    println!("Frozen SQL hashes, existing core-ledger checksums, and both owners' original rows unchanged");
}
