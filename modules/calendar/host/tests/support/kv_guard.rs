//! Capture a real installed invocation, then bypass only Calendar's set guard as a fault.
use moss_module_host::runtime::{authorize, CallScope, Ports, Request};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
#[derive(Default)]
pub struct Captured {
    pub scope: Mutex<Option<CallScope>>,
    pub guarded: Mutex<Option<Arc<dyn Ports>>>,
    pub downstream: Mutex<Option<Arc<dyn Ports>>>,
}
pub struct Observe {
    pub state: Arc<Captured>,
    pub next: Arc<dyn Ports>,
}
impl Ports for Observe {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        *self.state.scope.lock().unwrap() = Some(scope.clone());
        self.next.invoke(scope, port, request)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.next.finish_call(scope, success)
    }
}
pub fn witness(state: &Captured) {
    let scope = state.scope.lock().unwrap().clone().unwrap();
    let guarded = state.guarded.lock().unwrap().clone().unwrap();
    let downstream = state.downstream.lock().unwrap().clone().unwrap();
    for resource in [
        "calendar.chat-context",
        "calendar.task-reference",
        "calendar.briefing-reference",
    ] {
        let request = Request {
            operation: "set".into(),
            resource: resource.into(),
            parameters: if resource.ends_with("reference") {
                json!({"id":"untrusted"})
            } else {
                json!({})
            },
        };
        // The manifest permits generic KV writes. The trusted wrapper must reject them.
        authorize(scope.module(), "kv", &request).unwrap();
        let assertion = |ports: &dyn Ports| -> anyhow::Result<()> {
            let result = ports.invoke(&scope, "kv", &request);
            let expected = if resource.ends_with("reference") {
                "Calendar references are read-only"
            } else {
                "Calendar preferences are read-only and take no parameters"
            };
            anyhow::ensure!(
                result.is_err_and(|error| error.to_string() == expected),
                "read-only resource accepted set or missed its guard"
            );
            Ok(())
        };
        assert_eq!(
            assertion(downstream.as_ref()).unwrap_err().to_string(),
            "read-only resource accepted set or missed its guard"
        );
        println!("RED {resource}: same assertion detects set when Calendar's wrapper is bypassed");
        assertion(guarded.as_ref()).unwrap();
        println!("GREEN {resource}: same assertion rejects set through the real Calendar wrapper");
    }
}
