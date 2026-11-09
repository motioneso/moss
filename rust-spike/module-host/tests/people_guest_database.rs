//! Real Rust guest -> canonical ABI -> shared transactional ports -> legacy tables.
//! Run only in the disposable People gate, with the component freshly built.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    context::ContextPorts,
    manifest::{Capability, Ledger},
    runtime::{DenyPorts, Host, Limits},
    transactional_database::TransactionalDatabasePorts,
};
use moss_people::repository::TABLES;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

#[test]
#[ignore = "Only through verify-gate and tools/people-gate.sh"]
fn compiled_people_read_apis_match_typescript_on_real_database() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let component = std::fs::read(
        std::env::var("JS50_PEOPLE_COMPONENT").expect("Build the People component first"),
    )
    .unwrap();
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("JS50_PEOPLE_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let actor = Uuid::parse_str(oracle["actor"].as_str().unwrap()).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let db = rt
        .block_on(safety_core::db::Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            safety_core::db::RuntimeRole::App,
        ))
        .unwrap();
    let ports = Arc::new(
        TransactionalDatabasePorts::new(db, Arc::new(ContextPorts::new(Arc::new(DenyPorts))))
            .unwrap(),
    );
    let mut manifest = common::manifest("0.1.0");
    manifest.id = "people".into();
    manifest.database.ledger = Ledger::CoreLegacy;
    manifest.database.owned_tables = TABLES.map(str::to_owned).to_vec();
    manifest.capabilities = vec![
        Capability {
            port: "db".into(),
            operations: ["query".into()].into(),
            resources: TABLES.map(str::to_owned).into(),
            allow_private: false,
        },
        Capability {
            port: "context".into(),
            operations: ["read".into()].into(),
            resources: ["call".into()].into(),
            allow_private: false,
        },
        Capability {
            port: "vault".into(),
            operations: [
                "notes.read".into(),
                "notes.list".into(),
                "notes.compare-write".into(),
            ]
            .into(),
            resources: ["people-notes".into()].into(),
            allow_private: false,
        },
    ];
    common::people_job_imports(&mut manifest);
    let manifest = Arc::new(manifest);
    let host = Host::new(Limits::default()).unwrap();
    let run = |actor, payload: &Value| {
        host.call(
            &component,
            manifest.clone(),
            AccessContext::new(actor, "compiled-people-database"),
            ports.clone(),
            "api",
            &payload.to_string(),
        )
    };
    for case in oracle["guestCases"].as_array().unwrap() {
        let actual: Value = serde_json::from_str(&run(actor, &case["request"]).unwrap()).unwrap();
        assert_eq!(
            actual, case["expected"],
            "Compiled People API parity: {}",
            case["request"]["name"]
        );
    }
    let paging_actor = Uuid::parse_str(oracle["paging"]["actor"].as_str().unwrap()).unwrap();
    let paging_cases = oracle["paging"]["cases"].as_array().unwrap();
    assert_eq!(paging_cases.len(), 15, "Keep every paging boundary case");
    for case in paging_cases {
        let kind = case["kind"].as_str().unwrap();
        let reply = host
            .call(
                &component,
                manifest.clone(),
                AccessContext::new(paging_actor, "compiled-people-paging"),
                ports.clone(),
                kind,
                &case["request"].to_string(),
            )
            .unwrap_or_else(|error| panic!("Paging {}: {error:#}", case["request"]));
        let actual: Value = serde_json::from_str(&reply).unwrap();
        // Email lookup deliberately has no legacy ORDER BY; compare the complete
        // multiset, preserving duplicates, rather than database scan order.
        let normalize = |mut value: Value| {
            if case["request"]["name"] == "listEmailIdentityValues" {
                value
                    .as_array_mut()
                    .unwrap()
                    .sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
            value
        };
        assert_eq!(
            normalize(actual),
            normalize(case["expected"].clone()),
            "Paging parity: {} ({} rows)",
            case["request"],
            case["count"]
        );
    }
    println!("PASS People paging: 15 legacy reads at 999/1000/1001/1005/1006/unlimited, exact-page termination, 1005 aliases and emails including a duplicate; default host limits unchanged");
    // A background job authenticates through the worker pool, not the app pool.
    let worker_db = rt
        .block_on(safety_core::db::Database::connect(
            &std::env::var("JS43_WORKER_URL").unwrap(),
            2,
            safety_core::db::RuntimeRole::Worker,
        ))
        .unwrap();
    let worker_ports = Arc::new(
        TransactionalDatabasePorts::new(
            worker_db,
            Arc::new(ContextPorts::new(Arc::new(DenyPorts))),
        )
        .unwrap(),
    );
    let worker = host
        .call(
            &component,
            manifest.clone(),
            AccessContext::new(actor, "compiled-people-worker"),
            worker_ports,
            "api",
            &json!({"name":"getPerson","parameters":{"personId":oracle["personId"]}}).to_string(),
        )
        .expect("A legacy People query must work as the real worker role");
    let worker: Value = serde_json::from_str(&worker).unwrap();
    assert_eq!(worker, oracle["guestCases"][0]["expected"]);
    // An unowned random actor has no rows. Use a real administrator fixture too;
    // database privilege is configuration power, never a private-data bypass.
    let other = Uuid::new_v4();
    let admin = Uuid::new_v4();
    let bootstrap=rt.block_on(async {
        let (bootstrap,connection)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {let _=connection.await;});
        for (id,is_admin) in [(other,false),(admin,true)] {
            bootstrap.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Compiled guest privacy',$3)",&[&id,&format!("people-guest-{id}@example.test"),&is_admin]).await.unwrap();
        }
        bootstrap
    });
    for reader in [other, admin] {
        assert!(run(
            reader,
            &json!({"name":"getPerson","parameters":{"personId":oracle["personId"]}})
        )
        .is_err());
        assert_eq!(
            run(
                reader,
                &json!({"name":"listEmailIdentityValues","parameters":{}})
            )
            .unwrap(),
            "[]"
        );
        let resolved: Value = serde_json::from_str(
            &run(
                reader,
                &json!({"name":"resolve","parameters":{"query":"Alice_%"}}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(resolved, json!({"person":null}));
        assert_eq!(
            run(reader, &json!({"name":"findPeopleByNames","parameters":{"names":["Alice_%","Al_%","First Alias"]}})).unwrap(),
            "[]"
        );
    }
    rt.block_on(async {
        bootstrap
            .execute(
                "DELETE FROM app.users WHERE id=ANY($1)",
                &[&vec![other, admin]],
            )
            .await
            .unwrap();
    });
    println!("PASS real compiled Rust People guest: exact TypeScript API responses from legacy PostgreSQL through canonical ABI; other-user and admin read isolation; no native driver, no UI proof");
}
