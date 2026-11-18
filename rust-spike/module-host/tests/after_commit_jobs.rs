mod common;
use access_context::AccessContext;
use moss_module_host::{
    after_commit_jobs::AfterCommitJobs,
    runtime::{CallScope, Host, Limits, Ports, Request},
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Default)]
struct Sink {
    events: Mutex<Vec<String>>,
}
impl Ports for Sink {
    fn invoke(&self, _: &CallScope, _: &str, request: &Request) -> anyhow::Result<Value> {
        assert_eq!(request.operation, "enqueue-options");
        self.events.lock().unwrap().push("published".into());
        Ok(json!({"id":Uuid::new_v4()}))
    }
    fn finish_call(&self, _: &CallScope, success: bool) -> anyhow::Result<()> {
        self.events
            .lock()
            .unwrap()
            .push(format!("finished:{success}"));
        Ok(())
    }
}
#[test]
fn publication_follows_successful_finalization_and_traps_discard_work() {
    let host = Host::new(Limits::default()).unwrap();
    let sink = Arc::new(Sink::default());
    let ports = Arc::new(AfterCommitJobs::new(sink.clone()));
    let mut manifest = common::manifest("0.1.0");
    manifest.capabilities = serde_json::from_value(json!([
        {"port":"jobs","operations":["enqueue-after-commit","enqueue-options"],"resources":["sync-person-memory"]}
    ])).unwrap();
    manifest.jobs.insert(
        "sync-person-memory".into(),
        [(
            "command-id".into(),
            moss_module_host::manifest::ParameterKind::Id,
        )]
        .into(),
    );
    let source =
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/jobs@");
    let good = wat::parse_str(&source).unwrap();
    let trap = wat::parse_str(source.replace("call $kv", "call $kv unreachable")).unwrap();
    let request = json!({"operation":"enqueue-after-commit","resource":"sync-person-memory","parameters":{
        "params":{"command-id":Uuid::new_v4()},"idempotencyKey":Uuid::new_v4(),"availableAt":"2026-11-08T12:00:00.000Z"
    }}).to_string();
    let run = |wasm: &[u8], m| {
        host.call(
            wasm,
            Arc::new(m),
            AccessContext::new(Uuid::new_v4(), "deferred"),
            ports.clone(),
            "route",
            &request,
        )
    };
    assert!(run(&trap, manifest.clone()).is_err());
    assert_eq!(*sink.events.lock().unwrap(), vec!["finished:false"]);
    run(&good, manifest.clone()).unwrap();
    assert_eq!(
        *sink.events.lock().unwrap(),
        vec!["finished:false", "finished:true", "published"]
    );
    // Do not discover a missing downstream capability only after the DB commits.
    manifest.capabilities[0]
        .operations
        .remove("enqueue-options");
    assert!(run(&good, manifest).is_err());
    assert_eq!(
        sink.events.lock().unwrap().last().unwrap(),
        "finished:false"
    );
}
