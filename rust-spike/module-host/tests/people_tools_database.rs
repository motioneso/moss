//! Tool execution seam only: the real compiled guest and the real TypeScript
//! execute functions. Host approval policy and installed chat remain separate proof.
mod common;
#[path = "../../parity/src/canon.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod parity_canon;
use access_context::AccessContext;
use moss_module_host::{
    context::ContextPorts,
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
#[ignore = "Only through verify-gate and tools/people-gate.sh"]
fn compiled_people_tools_match_the_legacy_execute_functions() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let component = std::fs::read(std::env::var("JS50_PEOPLE_COMPONENT").unwrap()).unwrap();
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("JS50_PEOPLE_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let tools = &oracle["tools"];
    let actor = Uuid::parse_str(tools["actor"].as_str().unwrap()).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let db = rt
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
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
    manifest.capabilities = serde_json::from_value(json!([
        {"port":"db","operations":["query"],"resources":TABLES},
        {"port":"context","operations":["read"],"resources":["call"]},
        {"port":"vault","operations":["notes.read","notes.list","notes.compare-write"],"resources":["people-notes"]}
    ])).unwrap();
    let manifest = Arc::new(manifest);
    let host = Host::new(Limits::default()).unwrap();
    let run = |user, request: &Value| {
        host.call(
            &component,
            manifest.clone(),
            AccessContext::new(user, "people-tool-parity"),
            ports.clone(),
            "tool",
            &request.to_string(),
        )
    };
    let known: HashSet<_> = tools["knownIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let mut expected = parity_canon::Canon::new(chrono::Utc::now(), &known);
    let mut actual = parity_canon::Canon::new(chrono::Utc::now(), &known);
    for case in tools["cases"].as_array().unwrap() {
        if case["error"].is_string() {
            assert!(
                run(actor, &case["request"]).is_err(),
                "Explicit merge/split candidate action must be refused"
            );
        } else {
            let reply: Value = serde_json::from_str(
                &run(actor, &case["request"]).expect("Tool must execute in the compiled guest"),
            )
            .unwrap();
            assert_eq!(
                actual.value(&reply),
                expected.value(&case["expected"]),
                "Tool response differs from TypeScript: {}",
                case["request"]["tool"]
            );
        }
    }
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
    let explicit = Uuid::parse_str(tools["explicit"].as_str().unwrap()).unwrap();
    let status: String = rt.block_on(async {
        bootstrap
            .query_one(
                "SELECT status::text FROM app.person_context_match_candidates WHERE id=$1",
                &[&explicit],
            )
            .await
            .unwrap()
            .get(0)
    });
    assert_eq!(
        status, "pending",
        "Refused explicit action must not accept its candidate"
    );
    for is_admin in [false, true] {
        let reader = Uuid::new_v4();
        rt.block_on(async { bootstrap.execute(
            "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Tool privacy',$3)",
            &[&reader, &format!("people-tools-{reader}@example.test"), &is_admin],
        ).await.unwrap(); });
        for request in [
            json!({"tool":"people.getContext","parameters":{"personId":tools["primary"]}}),
            json!({"tool":"people.rejectMatch","parameters":{"candidateId":tools["accepted"]}}),
            json!({"tool":"people.merge","parameters":{"primaryPersonId":tools["primary"],"secondaryPersonId":tools["secondary"]}}),
            json!({"tool":"people.splitIdentity","parameters":{"identityId":tools["identity"],"targetPersonId":tools["primary"]}}),
        ] {
            assert!(run(reader, &request).is_err());
        }
        let reply: Value = serde_json::from_str(
            &run(reader, &json!({"tool":"people.listRecent","parameters":{}})).unwrap(),
        )
        .unwrap();
        assert_eq!(reply["data"]["items"], json!([]));
        rt.block_on(async {
            bootstrap
                .execute("DELETE FROM app.users WHERE id=$1", &[&reader])
                .await
                .unwrap();
        });
    }
    assert!(run(
        actor,
        &json!({"tool":"people.resolve","parameters":{"query":"Tool Alpha","actorUserId":actor}})
    )
    .is_err());
    println!("PASS all seven compiled People tool handlers against real TypeScript execute functions; explicit-action refusal and owner/other/admin isolation; no installed chat or approval-policy proof");
}
