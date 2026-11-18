mod common;
use access_context::AccessContext;
use moss_module_host::{
    context::ContextPorts,
    manifest::Capability,
    runtime::{DenyPorts, Host, Limits},
};
use serde_json::{json, Value};
use std::sync::Arc;
#[test]
fn context_comes_from_host_and_requires_declared_capability() {
    let h = Host::new(Limits::default()).unwrap();
    let p = Arc::new(ContextPorts::new(Arc::new(DenyPorts)));
    let mut m = common::manifest("1.0.0");
    m.capabilities = vec![Capability {
        port: "context".into(),
        operations: ["read".into(), "uuid".into()].into(),
        resources: ["call".into(), "new".into()].into(),
        allow_private: false,
    }];
    m.validate(&"0.1.0".parse().unwrap()).unwrap();
    let actor = uuid::Uuid::new_v4();
    let a = AccessContext::new(actor, "context");
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace("moss:module/kv@1.0.0", "moss:module/context@1.0.0"),
    )
    .unwrap();
    let call = |op: &str, resource: &str| -> Value {
        serde_json::from_str(
            &h.call(
                &wasm,
                Arc::new(m.clone()),
                a.clone(),
                p.clone(),
                "route",
                &json!({"operation":op,"resource":resource,"parameters":{}}).to_string(),
            )
            .unwrap(),
        )
        .unwrap()
    };
    let context = call("read", "call");
    assert_eq!(context["actorUserId"], actor.to_string());
    let time = chrono::DateTime::parse_from_rfc3339(context["now"].as_str().unwrap()).unwrap();
    assert!((chrono::Utc::now().timestamp_millis() - time.timestamp_millis()).abs() < 1000);
    let one = call("uuid", "new");
    let two = call("uuid", "new");
    uuid::Uuid::parse_str(one["id"].as_str().unwrap()).unwrap();
    assert_ne!(one, two);
    m.capabilities.clear();
    assert!(h.call(&wasm, Arc::new(m), a, p, "health", "{}").is_err());
}
