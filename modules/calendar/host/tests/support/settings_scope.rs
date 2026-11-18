//! Real host-minted scopes for trusted-port fault tests, with an explicit test budget.
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Capture(Mutex<Option<CallScope>>);
impl Ports for Capture {
    fn invoke(&self, scope: &CallScope, _: &str, _: &Request) -> anyhow::Result<Value> {
        *self.0.lock().unwrap() = Some(scope.clone());
        Ok(serde_json::json!({}))
    }
}
pub struct Scopes {
    host: Host,
    wasm: Vec<u8>,
}
impl Scopes {
    pub fn new(f: &crate::support::Fixture, budget: std::time::Duration) -> Self {
        Self {
            host: Host::new(Limits {
                deadline: budget,
                ..Limits::default()
            })
            .unwrap(),
            wasm: moss_calendar_host::package::component(&f.core()).unwrap(),
        }
    }
    pub fn next(&self, f: &crate::support::Fixture) -> CallScope {
        let capture = Arc::new(Capture::default());
        self.host.call(&self.wasm, Arc::new(moss_calendar_host::package::manifest().unwrap()),
            f.access(f.a), capture.clone(), "route",
            r#"{"method":"GET","path":"/briefing-settings","params":{},"query":{},"body":null}"#,
        ).unwrap();
        let scope = capture.0.lock().unwrap().clone().unwrap();
        scope
    }
}
