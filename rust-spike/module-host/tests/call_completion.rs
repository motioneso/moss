mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Completion(Mutex<Vec<(uuid::Uuid, bool)>>);
impl Ports for Completion {
    fn invoke(&self, _: &CallScope, _: &str, _: &Request) -> Result<Value> {
        anyhow::bail!("simulate a refused host operation")
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.0.lock().unwrap().push((scope.call_id(), success));
        Ok(())
    }
}
#[test]
fn each_invocation_finishes_once_and_failure_rolls_back() {
    let host = Host::new(Limits::default()).unwrap();
    let ports = Arc::new(Completion::default());
    let actor = AccessContext::new(uuid::Uuid::new_v4(), "same-request-id");
    let manifest = Arc::new(common::manifest("1.0.0"));
    host.call(
        &common::wasm(),
        manifest.clone(),
        actor.clone(),
        ports.clone(),
        "health",
        "{}",
    )
    .unwrap();
    assert!(host
        .call(
            &common::wasm(),
            manifest,
            actor,
            ports.clone(),
            "route",
            r#"{"operation":"get","resource":"counter","parameters":{}}"#
        )
        .is_err());
    let finished = ports.0.lock().unwrap();
    assert_eq!(finished.len(), 2);
    assert!(finished[0].1);
    assert!(!finished[1].1);
    assert_ne!(finished[0].0, finished[1].0);
}

#[test]
fn traps_and_unsuccessful_routes_finalize_false() {
    struct Reply;
    impl Ports for Reply {
        fn invoke(&self, _: &CallScope, _: &str, _: &Request) -> Result<Value> {
            Ok(serde_json::json!({"status":409,"body":{"error":"conflict"}}))
        }
    }
    struct Record {
        next: Reply,
        calls: Mutex<Vec<bool>>,
    }
    impl Ports for Record {
        fn invoke(&self, s: &CallScope, p: &str, r: &Request) -> Result<Value> {
            self.next.invoke(s, p, r)
        }
        fn finish_call(&self, _: &CallScope, success: bool) -> Result<()> {
            self.calls.lock().unwrap().push(success);
            Ok(())
        }
    }
    let host = Host::new(Limits::default()).unwrap();
    let ports = Arc::new(Record {
        next: Reply,
        calls: Mutex::new(vec![]),
    });
    let access = AccessContext::new(uuid::Uuid::new_v4(), "completion");
    let m = Arc::new(common::manifest("1.0.0"));
    let response = host
        .call(
            &common::wasm(),
            m.clone(),
            access.clone(),
            ports.clone(),
            "route",
            r#"{"operation":"get","resource":"counter","parameters":{}}"#,
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response).unwrap()["status"],
        409
    );
    let source = include_str!("../sample/module.wat").replace("i32.const 32))", "unreachable))");
    let trap = wat::parse_str(source).unwrap();
    assert!(host
        .call(&trap, m, access, ports.clone(), "health", "{}")
        .is_err());
    assert_eq!(*ports.calls.lock().unwrap(), vec![false, false]);
}
#[test]
fn completion_error_is_returned_without_double_completion() {
    struct Refuse(Mutex<usize>);
    impl Ports for Refuse {
        fn invoke(&self, _: &CallScope, _: &str, _: &Request) -> Result<Value> {
            unreachable!()
        }
        fn finish_call(&self, _: &CallScope, _: bool) -> Result<()> {
            *self.0.lock().unwrap() += 1;
            anyhow::bail!("commit refused")
        }
    }
    let host = Host::new(Limits::default()).unwrap();
    let ports = Arc::new(Refuse(Mutex::new(0)));
    assert!(host
        .call(
            &common::wasm(),
            Arc::new(common::manifest("1.0.0")),
            AccessContext::new(uuid::Uuid::new_v4(), "completion"),
            ports.clone(),
            "health",
            "{}"
        )
        .is_err());
    assert_eq!(*ports.0.lock().unwrap(), 1);
}
