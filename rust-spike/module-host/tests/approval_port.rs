//! The `approvals` port through the real guest and the real service ports, with a recording
//! store in place of the database. The database proof is `approval_store_database`.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    approval_port::{Approvals, Record},
    local::LocalPorts,
    manifest::{Capability, Manifest},
    runtime::{CallScope, Host, Limits, Request},
    services::ServicePorts,
};
use safety_core::secret::SecretCipher;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured embeddings")
    }
}

#[derive(Default)]
struct Store {
    calls: Mutex<Vec<(uuid::Uuid, String, String, String, Value)>>,
}
impl Store {
    fn note(&self, access: &AccessContext, module: &str, resource: &str, op: &str, extra: Value) {
        self.calls.lock().unwrap().push((
            access.actor_user_id(),
            module.into(),
            resource.into(),
            op.into(),
            extra,
        ));
    }
    fn record(id: &str, status: &str) -> Record {
        Record {
            id: id.into(),
            owner_user_id: "owner-1".into(),
            status: status.into(),
            input_summary: json!({"tool":"calendar.applyDayPlanChanges","operationId":"operation-1"}),
        }
    }
}
impl Approvals for Store {
    fn create(&self, access: &AccessContext, module: &str, resource: &str, summary: &Value) -> Result<Record> {
        self.note(access, module, resource, "create", summary.clone());
        Ok(Record {
            id: "approval-1".into(),
            // The host pins the owner; the stored binding is returned as written.
            owner_user_id: access.actor_user_id().to_string(),
            status: "pending".into(),
            input_summary: summary.clone(),
        })
    }
    fn get(&self, access: &AccessContext, module: &str, resource: &str, _: &str) -> Result<Record> {
        self.note(access, module, resource, "get", json!({}));
        Ok(Self::record("approval-1", "pending"))
    }
    fn confirm(&self, access: &AccessContext, module: &str, resource: &str, _: &str) -> Result<Record> {
        self.note(access, module, resource, "confirm", json!({}));
        Ok(Self::record("approval-1", "confirmed"))
    }
    fn find(
        &self,
        access: &AccessContext,
        module: &str,
        resource: &str,
        status: &str,
        operation_id: &str,
    ) -> Result<Option<Record>> {
        self.note(
            access,
            module,
            resource,
            "find",
            json!({"status": status, "operationId": operation_id}),
        );
        Ok(Some(Self::record("approval-1", status)))
    }
}

fn manifest(resources: &[&str]) -> Manifest {
    let mut m = common::manifest("1.0.0");
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
        resources: resources.iter().map(|r| r.to_string()).collect(),
        allow_private: false,
    }];
    m
}

fn run(
    store: &Arc<Store>,
    m: &Manifest,
    actor: uuid::Uuid,
    operation: &str,
    resource: &str,
    parameters: Value,
) -> Result<Value> {
    let data = tempfile::tempdir()?;
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path())?),
        )?
        .with_approvals(store.clone()),
    );
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/approvals@"),
    )?;
    let reply = Host::new(Limits::default())?.call(
        &wasm,
        Arc::new(m.clone()),
        AccessContext::new(actor, "approvals-port"),
        services,
        "route",
        &json!({"operation":operation,"resource":resource,"parameters":parameters}).to_string(),
    )?;
    Ok(serde_json::from_str(&reply)?)
}

fn summary() -> Value {
    json!({"tool":"calendar.applyDayPlanChanges","actorUserId":"actor",
           "planId":"plan-1","operationId":"operation-1","planRevision":3,"changes":[]})
}

#[test]
fn a_module_without_the_permission_is_refused() {
    let store = Arc::new(Store::default());
    let mut m = manifest(&["day-plan-change"]);
    m.capabilities.clear();
    assert!(run(
        &store,
        &m,
        uuid::Uuid::new_v4(),
        "create",
        "day-plan-change",
        json!({"inputSummary": summary()})
    )
    .is_err());
    assert!(store.calls.lock().unwrap().is_empty());
}

#[test]
fn a_resource_or_operation_the_permission_does_not_list_is_refused() {
    let store = Arc::new(Store::default());
    let m = manifest(&["day-plan-change"]);
    let who = uuid::Uuid::new_v4();
    assert!(run(
        &store,
        &m,
        who,
        "create",
        "day-plan-change",
        json!({"inputSummary": summary()})
    )
    .is_ok());
    // Another declared family never reaches the store.
    assert!(run(
        &store,
        &m,
        who,
        "create",
        "event-delete",
        json!({"inputSummary": summary()})
    )
    .is_err());
    // An operation the permission does not list never reaches the store.
    assert!(run(
        &store,
        &m,
        who,
        "reject",
        "day-plan-change",
        json!({"id": "approval-1"})
    )
    .is_err());
    assert_eq!(store.calls.lock().unwrap().len(), 1);
}

#[test]
fn a_manifest_declares_only_known_operations_and_families() {
    let mut unknown_operation = manifest(&["day-plan-change"]);
    unknown_operation.capabilities[0].operations.insert("reject".into());
    assert!(unknown_operation
        .validate(&"0.1.0".parse().unwrap())
        .is_err());
    let unnamed_family = manifest(&[]);
    assert!(unnamed_family.validate(&"0.1.0".parse().unwrap()).is_err());
    assert!(manifest(&["day-plan-change", "event-delete"])
        .validate(&"0.1.0".parse().unwrap())
        .is_ok());
}

#[test]
fn the_owner_module_and_family_come_from_the_call_never_the_request() {
    let store = Arc::new(Store::default());
    let m = manifest(&["day-plan-change"]);
    let (caller, other) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let out = run(
        &store,
        &m,
        caller,
        "create",
        "day-plan-change",
        json!({"inputSummary": summary()}),
    )
    .unwrap();
    assert_eq!(
        out,
        json!({
            "id": "approval-1",
            "ownerUserId": caller.to_string(),
            "status": "pending",
            "inputSummary": summary(),
        })
    );
    // No request field can name a user or module: every other spelling is refused.
    for field in ["ownerUserId", "actorUserId", "owner_user_id", "userId", "moduleId", "module"] {
        let mut body = json!({"inputSummary": summary()});
        body[field] = json!(other.to_string());
        assert!(
            run(&store, &m, caller, "create", "day-plan-change", body).is_err(),
            "{field}"
        );
    }
    let calls = store.calls.lock().unwrap();
    assert_eq!(calls.len(), 1, "only the clean call reached the store");
    assert_eq!(calls[0].0, caller, "the host pinned the caller as the owner");
    assert_eq!(calls[0].1, "sample.counter", "the host pinned the calling module");
    assert_eq!(calls[0].2, "day-plan-change", "the host pinned the declared family");
}

#[test]
fn every_operation_accepts_only_its_documented_fields() {
    let store = Arc::new(Store::default());
    let m = manifest(&["day-plan-change"]);
    let who = uuid::Uuid::new_v4();
    // Missing fields.
    assert!(run(&store, &m, who, "create", "day-plan-change", json!({})).is_err());
    assert!(run(
        &store,
        &m,
        who,
        "get",
        "day-plan-change",
        json!({"id": "not a uuid"})
    )
    .is_err());
    assert!(run(&store, &m, who, "confirm", "day-plan-change", json!({})).is_err());
    assert!(run(&store, &m, who, "find-pending", "day-plan-change", json!({})).is_err());
    // Unknown fields.
    for body in [
        json!({"inputSummary": summary(), "id": "00000000-0000-4000-8000-000000000009"}),
        json!({"id": "00000000-0000-4000-8000-000000000009", "status": "confirmed"}),
        json!({"operationId": "operation-1", "id": "00000000-0000-4000-8000-000000000009"}),
    ] {
        for op in ["create", "get", "confirm", "find-pending", "find-confirmed"] {
            assert!(
                run(&store, &m, who, op, "day-plan-change", body.clone()).is_err(),
                "{op}"
            );
        }
    }
    // A summary that is not an object never reaches the store.
    assert!(run(
        &store,
        &m,
        who,
        "create",
        "day-plan-change",
        json!({"inputSummary": ["not", "an", "object"]})
    )
    .is_err());
    assert!(store.calls.lock().unwrap().is_empty());
}

#[test]
fn a_binding_may_restate_the_actor_but_never_select_it() {
    let store = Arc::new(Store::default());
    let m = manifest(&["day-plan-change"]);
    let who = uuid::Uuid::new_v4();
    // The audited binding restates the actor the host already pinned; the host never trusts
    // it, so the create carrying it reaches the store.
    assert!(run(
        &store,
        &m,
        who,
        "create",
        "day-plan-change",
        json!({"inputSummary": summary()})
    )
    .is_ok());
    // Identity and connection fields anywhere else in the binding stay refused.
    for key in ["role", "connection", "databaseUrl", "sql", "actor"] {
        let mut body = json!({"inputSummary": summary()});
        body["inputSummary"][key] = json!("planted");
        assert!(
            run(&store, &m, who, "create", "day-plan-change", body).is_err(),
            "{key}"
        );
    }
    // A nested actor key deeper inside the binding is refused too: only the binding's own
    // top-level restatement is data.
    let mut nested = json!({"inputSummary": summary()});
    nested["inputSummary"]["changes"] = json!([
        {"blockId": "block-1", "kind": "move", "actorUserId": "planted"}
    ]);
    assert!(run(&store, &m, who, "create", "day-plan-change", nested).is_err());
    // The other operations keep the full refusal.
    for op in ["get", "confirm", "find-pending", "find-confirmed"] {
        assert!(
            run(&store, &m, who, op, "day-plan-change", json!({"actorUserId": who.to_string()})).is_err(),
            "{op}"
        );
    }
    assert_eq!(store.calls.lock().unwrap().len(), 1);
}

#[test]
fn find_pins_the_status_to_the_operation_and_returns_the_record() {
    let found = Arc::new(Store::default());
    let m = manifest(&["day-plan-change"]);
    let who = uuid::Uuid::new_v4();
    assert_eq!(
        run(&found, &m, who, "find-confirmed", "day-plan-change", json!({"operationId": "operation-1"})).unwrap(),
        json!({"approval": {
            "id": "approval-1",
            "ownerUserId": "owner-1",
            "status": "confirmed",
            "inputSummary": {"tool":"calendar.applyDayPlanChanges","operationId":"operation-1"},
        }})
    );
    let calls = found.calls.lock().unwrap();
    assert_eq!(calls[0].4["status"], "confirmed", "find-confirmed searches only confirmed");
    assert_eq!(calls[0].4["operationId"], "operation-1");
}

#[test]
fn a_store_the_shell_did_not_supply_refuses_every_call() {
    let store = Arc::new(Store::default());
    let m = manifest(&["day-plan-change"]);
    let data = tempfile::tempdir().unwrap();
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/approvals@"),
    )
    .unwrap();
    let reply = Host::new(Limits::default())
        .unwrap()
        .call(
            &wasm,
            Arc::new(m),
            AccessContext::new(uuid::Uuid::new_v4(), "approvals-port"),
            services,
            "route",
            &json!({"operation":"create","resource":"day-plan-change","parameters":{"inputSummary": summary()}})
                .to_string(),
        )
        .is_err();
    assert!(reply, "the default store fails closed");
    assert!(store.calls.lock().unwrap().is_empty());
}
