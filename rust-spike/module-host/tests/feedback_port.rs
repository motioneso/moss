//! The `feedback` port through the real guest and the real service ports, with a recording store
//! in place of the database. The database proof is `feedback_port_database`.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    feedback_port::{Feedback, Record},
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
    calls: Mutex<Vec<(uuid::Uuid, String, String, Value)>>,
}
impl Feedback for Store {
    fn record(&self, access: &AccessContext, kind: &str, input: &Record) -> Result<String> {
        self.calls.lock().unwrap().push((
            access.actor_user_id(),
            "record".into(),
            kind.into(),
            input.metadata.clone(),
        ));
        Ok("rating-1".into())
    }
    fn undo(&self, access: &AccessContext, kind: &str, _: &str) -> Result<()> {
        self.calls.lock().unwrap().push((
            access.actor_user_id(),
            "undo".into(),
            kind.into(),
            json!({}),
        ));
        Ok(())
    }
    fn active(&self, access: &AccessContext, kind: &str, _: &str, _: &str) -> Result<Vec<String>> {
        self.calls.lock().unwrap().push((
            access.actor_user_id(),
            "active".into(),
            kind.into(),
            json!({}),
        ));
        Ok(vec!["ref-1".into()])
    }
}

fn manifest(resources: &[&str]) -> Manifest {
    let mut m = common::manifest("1.0.0");
    m.capabilities = vec![Capability {
        port: "feedback".into(),
        operations: ["record".into(), "undo".into(), "active".into()].into(),
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
        .with_feedback(store.clone()),
    );
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/feedback@"),
    )?;
    let reply = Host::new(Limits::default())?.call(
        &wasm,
        Arc::new(m.clone()),
        AccessContext::new(actor, "feedback-port"),
        services,
        "route",
        &json!({"operation":operation,"resource":resource,"parameters":parameters}).to_string(),
    )?;
    Ok(serde_json::from_str(&reply)?)
}

fn record(item: &str) -> Value {
    json!({"targetRef":item,"surface":"briefing","kind":"dismiss","sourceKind":"briefings",
           "sourceLabel":"Briefings","metadata":{}})
}

#[test]
fn a_module_without_the_permission_is_refused() {
    let store = Arc::new(Store::default());
    let mut m = manifest(&["briefing_item"]);
    m.capabilities.clear();
    assert!(run(
        &store,
        &m,
        uuid::Uuid::new_v4(),
        "record",
        "briefing_item",
        record("a")
    )
    .is_err());
    assert!(store.calls.lock().unwrap().is_empty());
}

#[test]
fn a_target_kind_the_permission_does_not_list_is_refused() {
    let store = Arc::new(Store::default());
    let m = manifest(&["briefing_run"]);
    let who = uuid::Uuid::new_v4();
    // Listed kind works; every other kind never reaches the store.
    assert!(run(&store, &m, who, "record", "briefing_run", record("a")).is_ok());
    for kind in ["briefing_item", "proactive_card", "chat_message"] {
        assert!(
            run(&store, &m, who, "record", kind, record("a")).is_err(),
            "{kind}"
        );
    }
    assert_eq!(store.calls.lock().unwrap().len(), 1);
}

#[test]
fn a_manifest_cannot_declare_a_host_owned_target_kind() {
    for kind in ["proactive_card", "chat_message", "anything_else"] {
        assert!(
            manifest(&[kind])
                .validate(&"0.1.0".parse().unwrap())
                .is_err(),
            "{kind}"
        );
    }
    assert!(manifest(&["briefing_run", "briefing_item"])
        .validate(&"0.1.0".parse().unwrap())
        .is_ok());
}

#[test]
fn the_owner_is_the_caller_and_no_field_can_name_another_user() {
    let store = Arc::new(Store::default());
    let m = manifest(&["briefing_item"]);
    let (caller, other) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    run(&store, &m, caller, "record", "briefing_item", record("a")).unwrap();
    assert_eq!(store.calls.lock().unwrap()[0].0, caller);
    for field in ["ownerUserId", "actorUserId", "owner_user_id", "userId"] {
        let mut body = record("a");
        body[field] = json!(other.to_string());
        assert!(
            run(&store, &m, caller, "record", "briefing_item", body).is_err(),
            "{field}"
        );
    }
    assert_eq!(store.calls.lock().unwrap().len(), 1);
}

#[test]
fn metadata_keeps_ids_and_labels_and_drops_item_text() {
    let store = Arc::new(Store::default());
    let m = manifest(&["briefing_item"]);
    let mut body = record("a");
    body["metadata"] = json!({
        "runId":"run-1","itemLabel":"Tasks",
        "title":"PLANTED item text","text":"PLANTED body","summary":"PLANTED",
        "nested":{"itemId":"x"},"longLabel":"x".repeat(200)
    });
    run(
        &store,
        &m,
        uuid::Uuid::new_v4(),
        "record",
        "briefing_item",
        body,
    )
    .unwrap();
    let stored = store.calls.lock().unwrap()[0].3.clone();
    assert_eq!(stored, json!({"runId":"run-1","itemLabel":"Tasks"}));
    assert!(!stored.to_string().contains("PLANTED"));
}

#[test]
fn undo_and_active_run_as_the_caller_for_the_named_kind() {
    let store = Arc::new(Store::default());
    let m = manifest(&["briefing_item"]);
    let who = uuid::Uuid::new_v4();
    run(&store, &m, who, "undo", "briefing_item", json!({"id":"x"})).unwrap();
    let out = run(
        &store,
        &m,
        who,
        "active",
        "briefing_item",
        json!({"surface":"briefing","kind":"dismiss"}),
    )
    .unwrap();
    assert_eq!(out, json!({"refs":["ref-1"]}));
    let calls = store.calls.lock().unwrap();
    assert!(calls.iter().all(|c| c.0 == who && c.2 == "briefing_item"));
}
