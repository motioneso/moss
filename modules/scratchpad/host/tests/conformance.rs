//! Runs the native test corpus against the real compiled component through its ABI.
#[path = "../../tests/common/mod.rs"]
mod common;
#[path = "../../tests/conformance/mod.rs"]
mod conformance;
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use moss_module_sdk::Host as GuestHost;
use serde_json::Value;
use std::sync::{Arc, Mutex};
struct Scripted(Mutex<common::Fake>);
impl Ports for Scripted {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        self.0
            .lock()
            .unwrap()
            .call(
                port,
                &request.operation,
                &request.resource,
                request.parameters.clone(),
            )
            .map_err(|_| anyhow::anyhow!("scripted host failed"))
    }
}
#[test]
fn wasm_chat_contract() {
    let host = Host::new(Limits::default()).unwrap();
    let wasm = std::fs::read(std::env::var("SCRATCHPAD_COMPONENT_WASM").unwrap()).unwrap();
    let manifest = Arc::new(moss_scratchpad_host::package::manifest().unwrap());
    let ports = Arc::new(Scripted(Mutex::new(common::Fake::default())));
    let access =
        access_context::AccessContext::new(uuid::Uuid::new_v4(), "scratchpad-wasm-contract");
    conformance::check(|kind, input| {
        serde_json::from_str(
            &host
                .call(
                    &wasm,
                    manifest.clone(),
                    access.clone(),
                    ports.clone(),
                    kind,
                    &input.to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    });
}
