//! Differential route envelopes, not installed HTTP or live UI evidence.
mod common;
#[path = "../../parity/src/canon.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod parity_canon;
use access_context::AccessContext;
use moss_module_host::{
    context::ContextPorts,
    dispatch,
    manifest::Ledger,
    runtime::{DenyPorts, Host, Limits},
    transactional_database::TransactionalDatabasePorts,
};
use moss_people::repository::TABLES;
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};
use uuid::Uuid;

#[test]
#[ignore = "Only through verify-gate and modules/people/tools/routes-gate.sh"]
fn compiled_people_routes_match_legacy_http_handlers_and_rows() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let component = std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap();
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("JS58_PEOPLE_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let database = rt
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let ports = Arc::new(
        TransactionalDatabasePorts::new(database, Arc::new(ContextPorts::new(Arc::new(DenyPorts))))
            .unwrap(),
    );
    let mut manifest = common::manifest("0.1.0");
    manifest.id = "people".into();
    manifest.database.ledger = Ledger::CoreLegacy;
    manifest.database.owned_tables = TABLES.map(str::to_owned).to_vec();
    manifest.capabilities = serde_json::from_value(json!([
        {"port":"db","operations":["query"],"resources":TABLES},
        {"port":"context","operations":["read","uuid"],"resources":["call","new"]},
        {"port":"vault","operations":["notes.read","notes.list","notes.compare-write"],"resources":["people-notes"]}
    ])).unwrap();
    let routes = [
        ("GET", "/people"),
        ("GET", "/people/resolve"),
        ("GET", "/people/match-candidates"),
        ("GET", "/people/:id"),
        ("GET", "/people/:id/links"),
        ("PATCH", "/people/:id"),
        ("POST", "/people/:id/archive"),
        ("POST", "/people/:id/merge"),
        ("POST", "/people/:id/split-identity"),
        ("POST", "/people/match-candidates/:id/accept"),
        ("POST", "/people/match-candidates/:id/reject"),
        ("POST", "/people/match-candidates/:id/suppress"),
        ("POST", "/people/notes/refresh"),
        ("POST", "/people"),
    ];
    manifest.routes = routes
        .iter()
        .map(|(method, path)| {
            serde_json::from_value(json!({"method":method,"path":path,"signIn":true})).unwrap()
        })
        .collect();
    let manifest = Arc::new(manifest);
    let host = Host::new(Limits::default()).unwrap();
    let known: HashSet<_> = oracle["knownIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let mut expected = parity_canon::Canon::new(
        oracle["startedAt"].as_str().unwrap().parse().unwrap(),
        &known,
    );
    let mut actual = parity_canon::Canon::new(chrono::Utc::now(), &known);
    let bootstrap = rt.block_on(async {
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
    });
    let owner = Uuid::parse_str(oracle["actor"].as_str().unwrap()).unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let method = case["method"].as_str().unwrap();
        let path = case["path"].as_str().unwrap();
        let mut request = dispatch::resolve(&manifest.routes, method, path).unwrap();
        request.body = case["body"].clone();
        let reply = host
            .call(
                &component,
                manifest.clone(),
                AccessContext::new(
                    Uuid::parse_str(case["actor"].as_str().unwrap()).unwrap(),
                    "people-route-parity",
                ),
                ports.clone(),
                "route",
                &serde_json::to_string(&request).unwrap(),
            )
            .expect("Compiled route must return a response envelope");
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(
            actual.value(&reply),
            expected.value(&case["expected"]),
            "Route response differs: {method} {path}"
        );
        for table in TABLES {
            let rows: Vec<Value> = rt.block_on(async {
                bootstrap
                    .query(
                        &format!("SELECT to_jsonb(p) FROM {table} p WHERE owner_user_id=$1"),
                        &[&owner],
                    )
                    .await
                    .unwrap()
                    .iter()
                    .map(|r| r.get(0))
                    .collect()
            });
            assert_eq!(
                actual.rows(&rows),
                expected.rows(case["rows"][table].as_array().unwrap()),
                "Rows differ after {method} {path}: {table}"
            );
        }
    }
    println!("{} legacy route responses and all seven table snapshots matched, including other-user/admin attempts",oracle["cases"].as_array().unwrap().len());
}
