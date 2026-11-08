//! A handwritten Wasm trampoline invokes a native People test driver. Repository
//! queries use real shared ports, a single call scope and PostgreSQL. This is NOT
//! proof of a compiled People guest, an installed package, UI or chat integration.
mod common;
#[path = "people_persistence/mutations.rs"]
mod mutations;
// Reuse the project's parity harness normalization, rather than inventing a looser
// comparator for this native persistence checkpoint. This is not the HTTP harness.
#[path = "../../parity/src/canon.rs"]
#[allow(dead_code)]
#[rustfmt::skip]
mod parity_canon;
use access_context::AccessContext;
use moss_module_host::{
    context::ContextPorts,
    manifest::{Capability, Ledger},
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    transactional_database::TransactionalDatabasePorts,
};
use moss_module_sdk::{Error as SdkError, Host as SdkHost};
use moss_people::repository::{PersonProjection, Repository, PEOPLE, TABLES};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::NoTls;
use uuid::Uuid;

struct ScopedHost<'a> {
    scope: &'a CallScope,
    ports: &'a dyn Ports,
}
impl SdkHost for ScopedHost<'_> {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> moss_module_sdk::Result<Value> {
        self.ports
            .invoke(
                self.scope,
                port,
                &Request {
                    operation: operation.into(),
                    resource: resource.into(),
                    parameters,
                },
            )
            .map_err(|e| SdkError::new(e.to_string()))
    }
}
struct NativeDriver {
    next: Arc<dyn Ports>,
}
impl Ports for NativeDriver {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        if port != "kv" {
            return self.next.invoke(scope, port, request);
        }
        let bridge = ScopedHost {
            scope,
            ports: self.next.as_ref(),
        };
        let repo = Repository::new(&bridge);
        let id = request.parameters["id"].as_str().unwrap_or("");
        Ok(match request.operation.as_str() {
            "mutations" => mutations::run(&bridge)?,
            "project" => {
                let person = repo.project_person(&PersonProjection {
                    id,
                    display_name: "Private Person",
                    relationship: Some("Friend"),
                    context: Some("Private summary"),
                    status: "active",
                    confidence: 0.75,
                })?;
                let inserted = repo.save_indexing_state(
                    "note",
                    "source-hash",
                    "synthetic.md",
                    json!({"pending_source_version":"v1","failure_count":1}),
                )?;
                let updated = repo.save_indexing_state(
                    "note",
                    "source-hash",
                    "synthetic.md",
                    json!({"last_source_version":"v2","failure_count":0}),
                )?;
                json!({"person":person,"inserted":inserted,"updated":updated})
            }
            "project-only" => repo.project_person(&PersonProjection {
                id,
                display_name: "Private Person",
                relationship: Some("Friend"),
                context: Some("Private summary"),
                status: "active",
                confidence: 0.75,
            })?,
            "get" => json!(repo.person(id)?),
            "list" => json!(repo.list_people(Some("active"), None, None)?),
            "list-options" => json!(repo.list_people(
                request.parameters["status"].as_str(),
                request.parameters["search"].as_str(),
                request.parameters["limit"].as_u64().map(|n| n as u32),
            )?),
            "links-options" => json!(repo.links(
                id,
                request.parameters["sourceKind"].as_str(),
                request.parameters["linkKind"].as_str(),
                request.parameters["limit"].as_u64().map(|n| n as u32),
            )?),
            "resolve" => json!(repo.resolve(request.parameters["query"].as_str().unwrap_or(""))?),
            "detail" => {
                json!({"identities":repo.identities(id)?,"links":repo.links(id,None,None,Some(20))?,"emails":repo.list_email_identity_values()?})
            }
            "rollback" => {
                repo.project_person(&PersonProjection {
                    id,
                    display_name: "Must roll back",
                    relationship: None,
                    context: None,
                    status: "active",
                    confidence: 0.5,
                })?;
                return Err(anyhow::anyhow!("Synthetic failure after projection"));
            }
            _ => anyhow::bail!("Unknown native test driver action"),
        })
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.next.finish_call(scope, success)
    }
}

#[test]
fn people_keeps_the_frozen_legacy_sql_and_table_inventory() {
    let file = moss_module_host::legacy::entry("people", "sql/0128_person_context.sql").unwrap();
    assert_eq!(
        file.raw,
        moss_module_host::trust::digest(include_bytes!(
            "../../../packages/people/sql/0128_person_context.sql"
        ))
    );
    assert_eq!(file.ledger, Ledger::CoreLegacy);
    let mut expected = TABLES.map(str::to_owned).to_vec();
    expected.sort();
    let mut actual = moss_module_host::legacy::tables("people").to_vec();
    actual.sort();
    assert_eq!(expected, actual);
}

#[test]
#[ignore = "Only through verify-gate and tools/people-gate.sh"]
fn native_people_repository_uses_real_transactional_ports() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let actor = Uuid::new_v4();
    let other = Uuid::new_v4();
    let admin = Uuid::new_v4();
    let (db,database)=rt.block_on(async {
        let (db,c)=tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();
        tokio::spawn(async move {let _=c.await;});
        for (id,is_admin) in [(actor,false),(other,false),(admin,true)] {
            db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'People fixture',$3)",&[&id,&format!("people-persistence-{id}@example.test"),&is_admin]).await.unwrap();
        }
        let database=safety_core::db::Database::connect(&std::env::var("JS43_APP_URL").unwrap(),4,safety_core::db::RuntimeRole::App).await.unwrap();
        (db,database)
    });
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
            port: "kv".into(),
            operations: [
                "project".into(),
                "project-only".into(),
                "get".into(),
                "list".into(),
                "list-options".into(),
                "links-options".into(),
                "detail".into(),
                "resolve".into(),
                "rollback".into(),
                "mutations".into(),
            ]
            .into(),
            resources: ["native-driver".into()].into(),
            allow_private: false,
        },
    ];
    let ports = Arc::new(NativeDriver {
        next: Arc::new(
            TransactionalDatabasePorts::new(
                database,
                Arc::new(ContextPorts::new(Arc::new(DenyPorts))),
            )
            .unwrap(),
        ),
    });
    let host = Host::new(Limits {
        deadline: std::time::Duration::from_secs(20),
        ..Limits::default()
    })
    .unwrap();
    // The sample's fixed four-page bump allocator cannot hold a paged 1006-row
    // response. Increase this test fixture's initial memory, never the host limits.
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace(
                "(memory (export \"memory\") 4 1024)",
                "(memory (export \"memory\") 32 1024)",
            )
            .replace("(memory 4 1024)", "(memory 32 1024)"),
    )
    .unwrap();
    let manifest = Arc::new(manifest);
    let run = |actor, operation: &str, parameters: Value| {
        host.call(
            &wasm,
            manifest.clone(),
            AccessContext::new(actor, "repeated-request-id"),
            ports.clone(),
            "route",
            &json!({"operation":operation,"resource":"native-driver","parameters":parameters})
                .to_string(),
        )
    };
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(
            std::env::var("JS50_PEOPLE_ORACLE")
                .expect("Use the complete People gate to generate the TypeScript oracle"),
        )
        .unwrap(),
    )
    .unwrap();
    let oracle_actor = Uuid::parse_str(oracle["actor"].as_str().unwrap()).unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let result: Value = serde_json::from_str(
            &run(
                oracle_actor,
                case["operation"].as_str().unwrap(),
                case["parameters"].clone(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            result, case["expected"],
            "TypeScript/Rust People persistence parity: {}",
            case["operation"]
        );
    }
    let rows:Vec<Value>=rt.block_on(async {db.query("SELECT to_jsonb(p) FROM app.person_context_people p WHERE owner_user_id=$1 ORDER BY id",&[&oracle_actor]).await.unwrap().iter().map(|r|r.get(0)).collect()});
    assert_eq!(
        parity_canon::json_numbers(&json!(rows)),
        parity_canon::json_numbers(&oracle["rows"]),
        "Native reads changed the persisted TypeScript projection"
    );
    let actual: Value =
        serde_json::from_str(&run(oracle_actor, "mutations", json!({})).unwrap()).unwrap();
    let known = std::collections::HashSet::from([oracle_actor.to_string()]);
    let start = chrono::Utc::now();
    let mut expected_canon = parity_canon::Canon::new(start, &known);
    let mut actual_canon = parity_canon::Canon::new(start, &known);
    let expected = expected_canon.value(&oracle["mutation"]["responses"]);
    let got = actual_canon.value(&actual["responses"]);
    assert!(
        parity_canon::diff(&expected, &got, 10).is_empty(),
        "People mutation responses: {:?}",
        parity_canon::diff(&expected, &got, 10)
    );
    for table in TABLES {
        let expected = expected_canon.rows(oracle["mutation"]["rows"][table].as_array().unwrap());
        let got = actual_canon.rows(actual["rows"][table].as_array().unwrap());
        assert_eq!(got, expected, "People persisted mutation parity: {table}");
    }
    let projection = serde_json::from_str::<Value>(
        &run(
            oracle_actor,
            "project-only",
            json!({"id":oracle["projectionId"]}),
        )
        .unwrap(),
    )
    .unwrap();
    let projection_row: Value = rt.block_on(async {
        db.query_one(
            "SELECT to_jsonb(p) FROM app.person_context_people p WHERE id=$1::text::uuid",
            &[&oracle["projectionId"].as_str().unwrap()],
        )
        .await
        .unwrap()
        .get(0)
    });
    let known = std::collections::HashSet::from([
        oracle_actor.to_string(),
        oracle["projectionId"].as_str().unwrap().to_owned(),
    ]);
    let start = chrono::Utc::now();
    for (actual, expected) in [
        (&projection, &oracle["projection"]),
        (&projection_row, &oracle["projectionRow"]),
    ] {
        let actual = parity_canon::Canon::new(start, &known).value(actual);
        let expected = parity_canon::Canon::new(start, &known).value(expected);
        assert!(
            parity_canon::diff(&expected, &actual, 10).is_empty(),
            "People persisted projection parity: {:?}",
            parity_canon::diff(&expected, &actual, 10)
        );
    }
    let race_id = Uuid::new_v4();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let calls: Vec<_> = (0..2)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    run(oracle_actor, "project-only", json!({"id":race_id}))
                })
            })
            .collect();
        for call in calls {
            assert!(
                call.join().unwrap().is_ok(),
                "Concurrent projection upserts must both succeed"
            );
        }
    });
    let id = Uuid::new_v4();
    let result: Value =
        serde_json::from_str(&run(actor, "project", json!({"id":id})).unwrap()).unwrap();
    assert_eq!(result["person"]["ownerUserId"], actor.to_string());
    assert_eq!(result["person"]["confidence"], "0.75");
    assert_eq!(result["updated"]["last_source_version"], "v2");
    assert!(result["updated"]["pending_source_version"].is_null());
    assert_eq!(
        result["inserted"]["created_at"],
        result["updated"]["created_at"]
    );
    for reader in [other, admin] {
        assert_eq!(run(reader, "list", json!({})).unwrap(), "[]");
        assert!(run(reader, "get", json!({"id":id})).is_err());
        // A forged canonical ID must not overwrite or return the owner's projection.
        assert!(run(reader, "project", json!({"id":id})).is_err());
    }
    let rolled_back = Uuid::new_v4();
    assert!(run(actor, "rollback", json!({"id":rolled_back})).is_err());
    assert!(run(actor, "get", json!({"id":rolled_back})).is_err());
    // Exercise paging beyond the old host's scan limit without claiming a screen.
    rt.block_on(async {
        db.execute(&format!("INSERT INTO {PEOPLE}(owner_user_id,display_name) SELECT $1,'Paged '||lpad(n::text,4,'0') FROM generate_series(1,1005) n"),&[&actor]).await.unwrap();
    });
    let list: Vec<Value> = serde_json::from_str(&run(actor, "list", json!({})).unwrap()).unwrap();
    assert_eq!(list.len(), 1006);
    assert_eq!(list.first().unwrap()["displayName"], "Paged 0001");
    let detail: Value =
        serde_json::from_str(&run(actor, "detail", json!({"id":id})).unwrap()).unwrap();
    assert_eq!(detail, json!({"identities":[],"links":[],"emails":[]}));
    rt.block_on(async {
        db.execute(
            "DELETE FROM app.users WHERE id=ANY($1)",
            &[&vec![actor, other, admin]],
        )
        .await
        .unwrap();
    });
    println!("PASS native TypeScript differential: mutation responses and persisted rows, review/merge/split, concurrent projection upserts, composite indexing, forged IDs, rollback and 1006-row paging; this driver is not compiled-guest or UI proof");
}
