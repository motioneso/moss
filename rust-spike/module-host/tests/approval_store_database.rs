//! The approvals port against the real database with row-level security, through the real
//! guest and service ports. Run only through the approvals gate, which also removes each
//! protection once in a disposable copy and requires the matching test to fail.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    approval_port::{PostgresApprovals, MIGRATION},
    local::LocalPorts,
    manifest::{Capability, Manifest},
    runtime::{CallScope, Host, Limits, Request},
    services::ServicePorts,
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::SecretCipher,
};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured embeddings")
    }
}

fn approvals_manifest(id: &str) -> Manifest {
    let mut m = common::manifest("1.0.0");
    m.id = id.into();
    m.capabilities = vec![Capability {
        port: "approvals".into(),
        operations: [
            "create",
            "get",
            "confirm",
            "find-pending",
            "find-confirmed",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        resources: ["day-plan-change"].into_iter().map(String::from).collect(),
        allow_private: false,
    }];
    m
}

/// The audited binding a module stores as the approval's input summary: actor, plan,
/// operation, revision and the ordered change set, exactly as the TypeScript port writes it.
fn binding(actor: Uuid, operation_id: &str) -> Value {
    json!({
        "tool": "calendar.applyDayPlanChanges",
        "actorUserId": actor.to_string(),
        "planId": "plan-1",
        "operationId": operation_id,
        "planRevision": 3,
        "changes": [
            {"blockId": "block-1", "kind": "move", "calendarEventRef": "event-9",
             "startsAt": "2026-11-22T09:00:00Z", "durationMinutes": 60},
            {"blockId": "block-2", "kind": "remove", "calendarEventRef": "event-4",
             "startsAt": null, "durationMinutes": null},
            {"blockId": "block-3", "kind": "add", "calendarEventRef": null,
             "startsAt": "2026-11-22T15:00:00Z", "durationMinutes": 45}
        ]
    })
}

struct Proof {
    a: Uuid,
    b: Uuid,
    host: Host,
    wasm: Vec<u8>,
    module_a: Manifest,
    module_b: Manifest,
    services: Arc<ServicePorts>,
    bootstrap: tokio_postgres::Client,
    runtime: tokio::runtime::Runtime,
}

impl Drop for Proof {
    fn drop(&mut self) {
        let users = [self.a, self.b];
        let _ = self.runtime.block_on(async {
            for id in users {
                let _ = self
                    .bootstrap
                    .execute("DELETE FROM app.users WHERE id=$1", &[&id])
                    .await;
            }
        });
    }
}

fn proof() -> Proof {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    let bootstrap = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(
            &std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        // The gate database has the app schema; the host applies its own migration, the same
        // SQL module installation applies, so the proof runs the real table and policies.
        db.batch_execute(MIGRATION).await.unwrap();
        for id in [a, b] {
            db.execute(
                "INSERT INTO app.users(id,email,name) VALUES($1,$2,'Approvals port proof')",
                &[&id, &format!("approvals-{id}@example.test")],
            )
            .await
            .unwrap();
        }
        db
    });
    let database = runtime
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let data = tempfile::tempdir().unwrap();
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap()
        .with_approvals(Arc::new(PostgresApprovals::new(database).unwrap())),
    );
    Proof {
        a,
        b,
        host: Host::new(Limits::default()).unwrap(),
        wasm: wat::parse_str(
            include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/approvals@"),
        )
        .unwrap(),
        module_a: approvals_manifest("sample.counter"),
        module_b: approvals_manifest("sample.reader"),
        services,
        bootstrap,
        runtime,
    }
}

impl Proof {
    fn call(
        &self,
        who: Uuid,
        module: &Manifest,
        operation: &str,
        parameters: Value,
    ) -> anyhow::Result<Value> {
        let reply = self.host.call(
            &self.wasm,
            Arc::new(module.clone()),
            AccessContext::new(who, "approval-store-proof"),
            self.services.clone(),
            "route",
            &json!({"operation":operation,"resource":"day-plan-change","parameters":parameters})
                .to_string(),
        )?;
        Ok(serde_json::from_str(&reply)?)
    }

    /// The stored row, read past row security only to prove what the port left behind.
    fn stored(&self, id: &str) -> (Uuid, String) {
        self.runtime
            .block_on(async {
                let row = self
                    .bootstrap
                    .query_one(
                        "SELECT owner_user_id, status FROM moss_modules.approvals WHERE id=$1",
                        &[&Uuid::parse_str(id).unwrap()],
                    )
                    .await
                    .unwrap();
                (row.get::<_, Uuid>(0), row.get::<_, String>(1))
            })
            .unwrap()
    }
}

#[test]
#[ignore = "Only through the approvals gate"]
fn another_accounts_record_is_not_found_and_changes_nothing() {
    let proof = proof();
    let summary = binding(proof.a, "operation-1");
    // A proposes a change; the record is pending and owned by A.
    let created = proof
        .call(proof.a, &proof.module_a, "create", json!({"inputSummary": summary}))
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["status"], "pending");
    assert_eq!(created["ownerUserId"], proof.a.to_string());
    assert_eq!(created["inputSummary"], summary);

    // Another account reads the same id: not found, its confirm is refused, and its search
    // sees nothing. The record is indistinguishable from a missing one.
    assert!(proof
        .call(proof.b, &proof.module_a, "get", json!({"id": id}))
        .is_err());
    assert!(proof
        .call(proof.b, &proof.module_a, "confirm", json!({"id": id}))
        .is_err());
    assert_eq!(
        proof
            .call(
                proof.b,
                &proof.module_a,
                "find-pending",
                json!({"operationId": "operation-1"})
            )
            .unwrap(),
        json!({"approval": null})
    );

    // Nothing changed: the record is still A's pending approval, bound as written.
    let still = proof
        .call(proof.a, &proof.module_a, "get", json!({"id": id}))
        .unwrap();
    assert_eq!(still["status"], "pending");
    assert_eq!(still["inputSummary"], summary);
    let (owner, status) = proof.stored(&id);
    assert_eq!(owner, proof.a, "the host pinned the caller as the owner");
    assert_eq!(status, "pending", "the other account's confirm changed nothing");

    // A finds her own pending record through the operation bound in the summary.
    let found = proof
        .call(
            proof.a,
            &proof.module_a,
            "find-pending",
            json!({"operationId": "operation-1"}),
        )
        .unwrap();
    assert_eq!(found["approval"]["id"], id);
    assert_eq!(found["approval"]["status"], "pending");
    assert_eq!(
        proof
            .call(
                proof.a,
                &proof.module_a,
                "find-pending",
                json!({"operationId": "operation-other"})
            )
            .unwrap(),
        json!({"approval": null}),
        "a different operation has no approval"
    );
    println!("approvals port: other account blind, owner pinned, pending record found by operation");
}

#[test]
#[ignore = "Only through the approvals gate"]
fn a_second_confirm_is_refused_and_executes_nothing() {
    let proof = proof();
    let created = proof
        .call(
            proof.a,
            &proof.module_a,
            "create",
            json!({"inputSummary": binding(proof.a, "operation-2")}),
        )
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();

    // The first confirm flips pending to confirmed exactly once.
    let confirmed = proof
        .call(proof.a, &proof.module_a, "confirm", json!({"id": id}))
        .unwrap();
    assert_eq!(confirmed["status"], "confirmed");
    assert_eq!(confirmed["id"], id);
    assert_eq!(confirmed["ownerUserId"], proof.a.to_string());

    // A replayed confirm is refused and executes nothing: the record keeps the first result.
    assert!(proof
        .call(proof.a, &proof.module_a, "confirm", json!({"id": id}))
        .is_err());
    let stored = proof
        .call(proof.a, &proof.module_a, "get", json!({"id": id}))
        .unwrap();
    assert_eq!(stored["status"], "confirmed");
    let (_, status) = proof.stored(&id);
    assert_eq!(status, "confirmed", "a replayed confirm never executes twice");

    // The confirmed record is found for its operation; the pending search no longer matches.
    let found = proof
        .call(
            proof.a,
            &proof.module_a,
            "find-confirmed",
            json!({"operationId": "operation-2"}),
        )
        .unwrap();
    assert_eq!(found["approval"]["id"], id);
    assert_eq!(
        proof
            .call(
                proof.a,
                &proof.module_a,
                "find-pending",
                json!({"operationId": "operation-2"})
            )
            .unwrap(),
        json!({"approval": null})
    );
    println!("approvals port: one confirm flips once, replays refused, confirmed found by operation");
}

#[test]
#[ignore = "Only through the approvals gate"]
fn a_modules_record_cannot_be_read_by_another_module() {
    let proof = proof();
    let created = proof
        .call(
            proof.a,
            &proof.module_a,
            "create",
            json!({"inputSummary": binding(proof.a, "operation-3")}),
        )
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();

    // The same account through another module: not found for every operation, and the other
    // module's search does not see the record either.
    assert!(proof
        .call(proof.a, &proof.module_b, "get", json!({"id": id}))
        .is_err());
    assert!(proof
        .call(proof.a, &proof.module_b, "confirm", json!({"id": id}))
        .is_err());
    assert_eq!(
        proof
            .call(
                proof.a,
                &proof.module_b,
                "find-pending",
                json!({"operationId": "operation-3"})
            )
            .unwrap(),
        json!({"approval": null})
    );

    // The owning module still sees its own record, unchanged.
    assert_eq!(
        proof
            .call(proof.a, &proof.module_a, "get", json!({"id": id}))
            .unwrap()["status"],
        "pending"
    );
    let (_, status) = proof.stored(&id);
    assert_eq!(status, "pending", "another module's confirm changed nothing");

    // The other module can still propose its own approval under the same declared family.
    let own = proof
        .call(
            proof.a,
            &proof.module_b,
            "create",
            json!({"inputSummary": binding(proof.a, "operation-3b")}),
        )
        .unwrap();
    assert!(own["id"].as_str().is_some());
    assert_eq!(own["status"], "pending");
    let found = proof
        .call(
            proof.a,
            &proof.module_b,
            "find-pending",
            json!({"operationId": "operation-3b"}),
        )
        .unwrap();
    assert_eq!(found["approval"]["id"], own["id"], "each module sees only its own");
    println!("approvals port: one module cannot read or spend another module's approval");
}
